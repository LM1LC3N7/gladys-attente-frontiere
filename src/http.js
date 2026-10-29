// -----------------------------------------------------------------------------
// The only network access: one GET of an open-data file, bounded in time
// (REQUEST_TIMEOUT, from the first byte sent to the last byte read) and in
// size (cut as soon as the cap is passed, before the body is complete), with
// an honest User-Agent, an explicit Accept, the conditional headers the
// source offers (ETag / Last-Modified), no redirect followed and no cookie
// kept. The answer is decoded as strict UTF-8.
// -----------------------------------------------------------------------------

import { REQUEST_TIMEOUT, USER_AGENT } from './constants.js';

export class FetchError extends Error {
  /**
   * @param {string} code 'network' | 'timeout' | 'http' | 'rate_limited' | 'server' |
   *   'redirect' | 'too_large' | 'encoding' | 'aborted'
   */
  constructor(code, { status, retryAfter } = {}) {
    super(`fetch failed: ${code}${status ? ` ${status}` : ''}`);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

/** Control characters (never in a header). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\0-\x1f\x7f]/;

/** A header value safe to send back (no CR, LF, control byte), else nothing. */
const safeHeader = (value) =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && !CONTROL.test(value)
    ? value
    : undefined;

/** `Retry-After` in ms (seconds or an HTTP date against the server `Date`), else undefined. */
export function parseRetryAfter(value, serverDate) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (/^\d{1,7}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isFinite(at) && Number.isFinite(serverDate)) return Math.max(0, at - serverDate);
  return undefined;
}

/**
 * GET `url`. Resolves `{ status: 200, text, etag, lastModified, date }` or
 * `{ status: 304, date }`; throws a FetchError otherwise.
 * @param {{ url: string, accept: string, maxBytes: number, etag?: string,
 *   lastModified?: string, signal?: AbortSignal, fetchImpl?: typeof fetch,
 *   timeout?: number, timers?: object }} options
 */
export async function getText({
  url,
  accept,
  maxBytes,
  etag,
  lastModified,
  signal,
  fetchImpl = fetch,
  timeout = REQUEST_TIMEOUT,
  timers = { setTimeout, clearTimeout },
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = timers.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeout);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const fail = (err) => {
    if (err instanceof FetchError) return err;
    if (timedOut) return new FetchError('timeout');
    if (signal?.aborted) return new FetchError('aborted');
    return new FetchError('network');
  };
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: accept };
    if (safeHeader(etag)) headers['If-None-Match'] = etag;
    if (safeHeader(lastModified)) headers['If-Modified-Since'] = lastModified;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      throw fail(err);
    }
    const date = Date.parse(response.headers.get('date') ?? '');
    const status = response.status;
    if (status === 304) {
      await response.body?.cancel().catch(() => {});
      return { status, date };
    }
    if (status !== 200) {
      await response.body?.cancel().catch(() => {});
      const retryAfter = parseRetryAfter(response.headers.get('retry-after'), date);
      if (status === 429) throw new FetchError('rate_limited', { status, retryAfter });
      if (status >= 500 && status <= 599) throw new FetchError('server', { status, retryAfter });
      if (status >= 300 && status <= 399) throw new FetchError('redirect', { status });
      throw new FetchError('http', { status });
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new FetchError('too_large');
    }
    const chunks = [];
    let size = 0;
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new FetchError('too_large');
        }
        chunks.push(value);
      }
    } catch (err) {
      throw fail(err);
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new FetchError('encoding');
    }
    return {
      status,
      text,
      etag: safeHeader(response.headers.get('etag') ?? undefined),
      lastModified: safeHeader(response.headers.get('last-modified') ?? undefined),
      date,
    };
  } finally {
    timers.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

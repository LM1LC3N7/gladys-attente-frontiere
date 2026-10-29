// -----------------------------------------------------------------------------
// The integration itself: the border wait times of the CBSA (to Canada) and
// of CBP (to the U.S.) read at the pace of the form, one Gladys device per
// crossing and direction, the waits published once per reading, a status
// text per crossing, the pace, the pauses and what was published kept in
// /data. index.js only wires the SDK handlers to it. Read-only: nothing is
// ever sent to the sources but GET requests.
//
// One read = the English CSV of the CBSA, its French CSV when the form is in
// French (names only, never blocking), then the CBP feed: one request at a
// time. A source failing, paused or frozen never stops the other.
//
// The pace is global and kept across restarts: never two reads less than an
// interval apart, whatever asks (a reconnection, a save of the form, the
// Discovery tab, a device created, a restart: the time of the last read is
// written to /data before the read). The next read is armed before anything
// is awaited: a slow /data or a slow source never holds it back.
//
// Freshness: a value is published once per source reading (deduplicated on
// the date given by the source, kept in /data), only while that reading is at
// most 2 h old, without `created_at` (a scene "wait below X min" fires on
// it). A stale, closed, pending or unreadable reading is never published as
// a number: the status text says it.
//
// Two clocks: `now` (wall clock) only for /data and the reference of a source
// without `Date` header; `monotonic` for the pace, the pauses, the budget and
// the ages, so that a wall clock set back or forward never stops nor hurries
// them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { FormatError, frenchNames, parseCbsaEnglish, parseCbsaFrench } from './cbsa.js';
import { parseCbp } from './cbp.js';
import { normalizeConfig } from './config.js';
import {
  CATALOG_KEEP,
  CBP_MAX_BYTES,
  CBP_URL,
  CBSA_EN_URL,
  CBSA_FR_URL,
  CBSA_MAX_BYTES,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  DATE_HEADER_TRUST,
  FUTURE_SLACK,
  MAX_AGE,
  MAX_CATALOG,
  MAX_PUBLISHED,
  MINUTE,
  PAUSE_BASE,
  PAUSE_MAX,
  PAUSE_MIN,
  SECOND,
  SOURCES,
  STATE_BUDGET,
  STATE_WINDOW,
  STOP_WAIT,
} from './constants.js';
import { WAIT_KEYS, buildDevice, idsOf, parseDeviceId, validId } from './devices.js';
import { FetchError, getText } from './http.js';
import { T, deviceStatus, joinMessages, portTime, problemText } from './i18n.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/** A save of /data is awaited this long at most: a frozen /data never holds a read back. */
const SAVE_WAIT = 5 * SECOND;
const PAUSE_CODES = new Set(['rate_limited', 'server']);

/** A pause read back from /data: in memory it ends at a monotonic `due`, its rest capped to PAUSE_MAX. */
function validPause(pause, now, mono) {
  if (
    !pause ||
    !finite(pause.until) ||
    !Number.isInteger(pause.count) ||
    pause.count < 1 ||
    !PAUSE_CODES.has(pause.code)
  ) {
    return undefined;
  }
  const left = Math.min(Math.max(0, pause.until - now), PAUSE_MAX);
  return {
    until: now + left,
    due: mono + left,
    count: Math.min(pause.count, 32),
    code: pause.code,
    status: Number.isInteger(pause.status) ? pause.status : undefined,
  };
}

/** The crossings kept in /data, checked one by one. */
function keptCatalog(list, now) {
  const catalog = new Map();
  if (!Array.isArray(list)) return catalog;
  for (const entry of list.slice(0, MAX_CATALOG)) {
    if (
      !entry ||
      (entry.kind !== 'ca' && entry.kind !== 'us') ||
      !validId(entry.kind, entry.id) ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      entry.name.length > 80 ||
      !finite(entry.seenAt)
    ) {
      continue;
    }
    catalog.set(`${entry.kind}:${entry.id}`, {
      kind: entry.kind,
      id: entry.id,
      name: entry.name,
      nameFr: typeof entry.nameFr === 'string' ? entry.nameFr.slice(0, 80) : undefined,
      location: typeof entry.location === 'string' ? entry.location.slice(0, 80) : undefined,
      seenAt: Math.min(entry.seenAt, now),
    });
  }
  return catalog;
}

/** The source dates of the values published, by feature external id. */
function keptPublished(object) {
  const published = new Map();
  if (!object || typeof object !== 'object' || Array.isArray(object)) return published;
  for (const [key, value] of Object.entries(object)) {
    if (key.length <= 200 && key !== '__proto__' && finite(value)) published.set(key, value);
  }
  return new Map([...published].slice(-MAX_PUBLISHED));
}

export class BorderApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'attente-frontiere' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    store = createFileStore(),
    fetchImpl = (...args) => fetch(...args),
    urls = {},
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.urls = {
      [SOURCES.CBSA]: urls.cbsa ?? CBSA_EN_URL,
      [SOURCES.CBSA_FR]: urls.cbsaFr ?? CBSA_FR_URL,
      [SOURCES.CBP]: urls.cbp ?? CBP_URL,
    };
    this.config = normalizeConfig();
    this.running = false;
    this.run = 0;
    this.timer = undefined;
    this.busy = undefined;
    this.abort = undefined;
    this.lifecycle = Promise.resolve();
    this.connection = 0;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configRun = undefined;
    this.lastStatus = undefined;
    /** Status texts sent, by feature (forgotten at each start: Gladys may have lost them). */
    this.sentTexts = new Map();
    /** States sent to Gladys over the last minute: [{ at (monotonic), n }]. */
    this.sentLog = [];
    this.deferred = false;
    this.saveFailed = false;
    /** The outcome of the last attempt of each source: undefined | { ok: true } | { ok: false, ... }. */
    this.outcome = {};
    /** The parsed data of each source, in memory only. */
    this.cbsa = undefined;
    this.cbsaText = undefined;
    this.frNames = new Map();
    this.cbsaFr = undefined;
    this.cbp = undefined;

    const at = now();
    const mono = monotonic();
    const loaded = store.load();
    const kept = loaded.ok ? loaded.data : {};
    /** /data unreadable: set aside at the first start; values seen first are a baseline, not news. */
    this.dataUnreadable = !loaded.ok;
    this.dataBlocked = !loaded.ok;
    this.baseline = { ca: !loaded.ok, us: !loaded.ok };
    this.pauses = {};
    for (const source of Object.values(SOURCES)) {
      const pause = validPause(kept.pauses?.[source], at, mono);
      if (pause) this.pauses[source] = pause;
    }
    this.catalog = keptCatalog(kept.catalog, at);
    this.published = keptPublished(kept.published);
    // The last read before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.lastReadMono =
      this.lastAttemptAt === undefined ? undefined : mono - (at - this.lastAttemptAt);
    // The time of the CBP feed and when it last moved (a frozen feed is stale).
    const feed = kept.cbpFeed;
    this.cbpFeed =
      feed && finite(feed.time) && finite(feed.changedAt)
        ? {
            time: feed.time,
            changedAt: Math.min(feed.changedAt, at),
            changedMono: mono - (at - Math.min(feed.changedAt, at)),
          }
        : undefined;
    this.discoveryKey = undefined;
  }

  get intervalMs() {
    return this.config.intervalMinutes * MINUTE;
  }

  // --- Connection to Gladys -------------------------------------------------------

  /**
   * A (re)connection to Gladys: its configuration, then a start. A
   * `getConfig()` that fails is tried again without end (5 s doubled up to
   * 5 min), the status saying so, until it answers or the connection ends.
   */
  connected(getConfig) {
    const token = ++this.connection;
    this.configFailures = 0;
    this.clearConfigTimer();
    this.configRun = this.tryConfig(getConfig, token);
    return this.configRun;
  }

  /** The connection to Gladys is lost: the retries of getConfig end, the reads stop. */
  disconnected() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      await this.saveState();
    });
  }

  /** The user saved the form: this configuration wins over a getConfig still being tried. */
  configUpdated(raw) {
    this.connection += 1;
    this.clearConfigTimer();
    return this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  async tryConfig(getConfig, token) {
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (token !== this.connection) return;
      const wait = Math.min(CONFIG_RETRY_MIN * 2 ** this.configFailures, CONFIG_RETRY_MAX);
      this.configFailures = Math.min(this.configFailures + 1, 16);
      this.logger.warn(`The configuration could not be read (${err?.name ?? 'Error'})`);
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnread(wait));
      if (token !== this.connection) return;
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.configRun = this.tryConfig(getConfig, token);
        return this.configRun;
      }, wait);
      return;
    }
    if (token !== this.connection) return;
    this.configFailures = 0;
    await this.start(raw);
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /** Stops the reads, waits (bounded) for the one running, and writes /data. */
  stop() {
    this.connection += 1;
    this.clearConfigTimer();
    return this.serialize(async () => {
      this.doStop();
      if (this.busy) {
        let timer;
        await Promise.race([
          this.busy.catch(() => {}),
          new Promise((resolve) => {
            timer = this.timers.setTimeout(resolve, STOP_WAIT);
          }),
        ]);
        this.timers.clearTimeout(timer);
      }
      await this.saveState();
    });
  }

  /** Resolves once every queued start/stop and the read running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.configRun;
    await this.busy;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    const previous = this.config;
    this.config = normalizeConfig(raw);
    const gen = this.run;
    if (this.dataUnreadable && this.dataBlocked) {
      // Never overwritten: kept under another name, then a fresh file.
      try {
        await this.store.setAside(this.now());
        this.dataBlocked = false;
        this.logger.warn('/data could not be read: the file was set aside');
      } catch {
        this.logger.error('/data could not be read nor set aside: nothing is written to it');
      }
      if (gen !== this.run) return;
    }
    if (previous.language !== this.config.language) {
      // Another language: the French names are read again (or no longer).
      this.cbsaFr = undefined;
      this.frNames = new Map();
    }
    this.running = true;
    // The core keeps the connection status and the Discovery list in memory:
    // a restarted Gladys has lost them, so they are always sent again; the
    // status texts too (the waits only for a newer reading).
    this.lastStatus = undefined;
    this.sentTexts.clear();
    this.discoveryKey = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishDiscovery();
    if (gen !== this.run) return;
    await this.publishValues(gen);
    if (gen !== this.run) return;
    await this.updateStatus();
    if (gen !== this.run) return;
    this.schedule();
  }

  doStop() {
    this.running = false;
    this.run += 1;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.abort?.abort();
    this.abort = undefined;
  }

  // --- Schedule ----------------------------------------------------------------

  /** Arms the next read: at the last read plus the interval, at once when none. */
  schedule(minDelay = 0) {
    if (!this.running) return;
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    const mono = this.monotonic();
    const due = Math.max(
      this.lastReadMono === undefined ? mono : this.lastReadMono + this.intervalMs,
      mono + minDelay,
    );
    const gen = this.run;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (gen !== this.run || !this.running) return undefined;
        return this.tick(gen);
      },
      Math.max(0, due - mono),
    );
  }

  /** The timer of the next read fired: one read at a time, the next one armed first. */
  tick(gen) {
    if (this.busy) {
      // A read still running (a slow /data, a slow Gladys): looked at again in a minute.
      this.schedule(MINUTE);
      return undefined;
    }
    const mono = this.monotonic();
    if (this.lastReadMono !== undefined && mono - this.lastReadMono < this.intervalMs) {
      this.schedule();
      return undefined;
    }
    this.lastReadMono = mono;
    this.lastAttemptAt = this.now();
    this.schedule();
    const tracked = this.read(gen, mono).finally(() => {
      if (this.busy === tracked) this.busy = undefined;
    });
    this.busy = tracked;
    return tracked;
  }

  // --- One read ------------------------------------------------------------------

  async read(gen, mono) {
    const abort = new AbortController();
    this.abort = abort;
    try {
      // The time of this attempt in /data before any request (the pace survives a restart).
      await this.saveState();
      if (gen !== this.run) return;
      await this.readSource(SOURCES.CBSA, gen, abort.signal, mono);
      if (gen !== this.run) return;
      if (this.config.language === 'fr') {
        await this.readSource(SOURCES.CBSA_FR, gen, abort.signal, mono);
        if (gen !== this.run) return;
      } else {
        this.outcome[SOURCES.CBSA_FR] = undefined;
      }
      await this.readSource(SOURCES.CBP, gen, abort.signal, mono);
      if (gen !== this.run) return;
      this.updateCatalog();
      await this.publishDiscovery();
      if (gen !== this.run) return;
      await this.publishValues(gen);
      if (gen !== this.run) return;
      await this.updateStatus();
      await this.saveState();
    } catch (err) {
      this.logger.error(`Read failed (${err?.name ?? 'Error'})`);
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }

  async readSource(source, gen, signal, mono) {
    const pause = this.pauses[source];
    if (pause && pause.due > mono) {
      this.outcome[source] = { ok: false, code: 'paused', until: pause.due };
      return;
    }
    const isCbp = source === SOURCES.CBP;
    const previous =
      source === SOURCES.CBSA ? this.cbsa : source === SOURCES.CBSA_FR ? this.cbsaFr : undefined;
    let answer;
    try {
      answer = await getText({
        url: this.urls[source],
        accept: isCbp ? 'application/json' : 'text/csv, text/plain;q=0.9',
        maxBytes: isCbp ? CBP_MAX_BYTES : CBSA_MAX_BYTES,
        // CBSA offers ETag and Last-Modified; CBP answers no-cache without them.
        etag: previous?.etag,
        lastModified: previous?.lastModified,
        signal,
        fetchImpl: this.fetchImpl,
        timers: this.timers,
      });
    } catch (err) {
      if (gen !== this.run) return;
      this.failed(source, err);
      return;
    }
    if (gen !== this.run) return;
    const at = this.monotonic();
    const wall = this.now();
    delete this.pauses[source];
    if (answer.status === 304 && previous) {
      // Not modified: the readings keep their dates (their age grows on the monotonic clock).
      this.outcome[source] = { ok: true };
      return;
    }
    if (answer.status === 304) {
      this.outcome[source] = { ok: false, code: 'format' };
      return;
    }
    // The reference "now" of the source: its Date header, when close to ours.
    const ref =
      finite(answer.date) && Math.abs(answer.date - wall) <= DATE_HEADER_TRUST ? answer.date : wall;
    try {
      if (source === SOURCES.CBSA) {
        const { rows } = parseCbsaEnglish(answer.text);
        this.cbsa = {
          rows: new Map(rows.map((row) => [row.id, row])),
          ref,
          at,
          etag: answer.etag,
          lastModified: answer.lastModified,
        };
        this.cbsaText = answer.text;
        if (this.cbsaFr) this.frNames = frenchNames(this.cbsaText, this.cbsaFr.names);
      } else if (source === SOURCES.CBSA_FR) {
        const names = parseCbsaFrench(answer.text);
        this.cbsaFr = { names, etag: answer.etag, lastModified: answer.lastModified };
        this.frNames = frenchNames(this.cbsaText, names);
      } else {
        const { ports, feedTime } = parseCbp(answer.text);
        this.cbp = { ports: new Map(ports.map((port) => [port.id, port])), at };
        // A feed time that moves forward is a living feed; the same (or older) one is not.
        if (feedTime !== undefined && (!this.cbpFeed || feedTime > this.cbpFeed.time)) {
          this.cbpFeed = { time: feedTime, changedAt: wall, changedMono: at };
        }
      }
      this.outcome[source] = { ok: true };
    } catch (err) {
      if (!(err instanceof FormatError)) throw err;
      this.outcome[source] = { ok: false, code: 'format' };
      this.logger.warn(`${source}: unexpected format`);
    }
  }

  /** A request that failed: a 429/5xx pauses the source (bounded, kept in /data). */
  failed(source, err) {
    const code = err instanceof FetchError ? err.code : 'network';
    if (code === 'aborted') return;
    if (PAUSE_CODES.has(code)) {
      const count = (this.pauses[source]?.count ?? 0) + 1;
      const doubled = PAUSE_BASE * 2 ** Math.min(count - 1, 10);
      const wait = Math.min(Math.max(doubled, err.retryAfter ?? 0, PAUSE_MIN), PAUSE_MAX);
      const mono = this.monotonic();
      this.pauses[source] = {
        until: this.now() + wait,
        due: mono + wait,
        count,
        code,
        status: err.status,
      };
      this.outcome[source] = { ok: false, code, status: err.status, until: mono + wait };
    } else {
      this.outcome[source] = { ok: false, code, status: err.status };
    }
    this.logger.warn(`${source}: read failed (${code}${err?.status ? ` ${err.status}` : ''})`);
  }

  // --- What a crossing shows ------------------------------------------------------

  /** Whether the CBP feed no longer moves (its time unchanged for over 2 h). */
  cbpStale(mono) {
    return !this.cbpFeed || mono - this.cbpFeed.changedMono > MAX_AGE;
  }

  /**
   * The values and the status of one crossing now.
   * @returns {{ values: Record<string, { minutes: number, stamp: number }>,
   *   status: { code: string, time?: string } }}
   */
  viewOf(kind, id, mono) {
    const lang = this.config.language;
    const values = {};
    if (kind === 'ca') {
      if (!this.cbsa) return { values, status: { code: 'waiting' } };
      const row = this.cbsa.rows.get(id);
      if (!row) return { values, status: { code: 'missing' } };
      if (row.stamp === undefined) return { values, status: { code: 'undated' } };
      const age = this.cbsa.ref - row.stamp + (mono - this.cbsa.at);
      if (age < -FUTURE_SLACK) return { values, status: { code: 'undated' } };
      if (age > MAX_AGE) return { values, status: { code: 'stale', time: row.updated } };
      for (const key of WAIT_KEYS.ca) {
        const cell = row[key];
        if (cell.kind === 'wait') values[key] = { minutes: cell.minutes, stamp: row.stamp };
      }
      const main = row.travellers;
      let code;
      if (main.kind === 'wait') code = 'open';
      else if (main.kind === 'closed') code = 'closed';
      else if (values.commercial) code = 'open';
      else code = main.kind;
      return { values, status: { code, time: row.updated } };
    }
    if (!this.cbp) return { values, status: { code: 'waiting' } };
    const port = this.cbp.ports.get(id);
    if (!port) return { values, status: { code: 'missing' } };
    if (this.cbpStale(mono)) return { values, status: { code: 'source_stale' } };
    const grown = mono - this.cbp.at;
    for (const key of WAIT_KEYS.us) {
      const lane = port.lanes[key];
      if (lane.kind === 'wait' && lane.stamp !== undefined && lane.age + grown <= MAX_AGE) {
        values[key] = { minutes: lane.minutes, stamp: lane.stamp };
      }
    }
    const main = port.lanes.passenger;
    const timeOf = (naive) => (naive === undefined ? '' : portTime(lang, naive));
    if (port.open === false) {
      // A closed port: no wait, whatever its lanes say.
      return { values: {}, status: { code: 'closed', time: timeOf(port.portTime) } };
    }
    let status;
    if (main.kind === 'wait') {
      if (main.stamp === undefined) status = { code: 'undated' };
      else if (main.age + grown > MAX_AGE) status = { code: 'stale', time: timeOf(main.stamp) };
      else status = { code: 'open', time: timeOf(main.stamp) };
    } else if (Object.keys(values).length > 0) {
      const first = Object.values(values)[0];
      status = { code: 'open', time: timeOf(first.stamp) };
    } else if (main.kind === 'closed') {
      status = { code: 'lanes_closed', time: timeOf(port.portTime) };
    } else {
      status = { code: main.kind };
    }
    return { values, status };
  }

  // --- Discovery -------------------------------------------------------------------

  /** The crossings of the last readings join the catalog; the long gone ones leave it. */
  updateCatalog() {
    const wall = this.now();
    if (this.cbsa && this.outcome[SOURCES.CBSA]?.ok) {
      for (const row of this.cbsa.rows.values()) {
        this.catalog.set(`ca:${row.id}`, {
          kind: 'ca',
          id: row.id,
          name: row.name,
          nameFr: this.frNames.get(row.id) ?? this.catalog.get(`ca:${row.id}`)?.nameFr,
          location: row.location,
          seenAt: wall,
        });
      }
    }
    if (this.cbp && this.outcome[SOURCES.CBP]?.ok) {
      for (const port of this.cbp.ports.values()) {
        this.catalog.set(`us:${port.id}`, {
          kind: 'us',
          id: port.id,
          name: port.name,
          seenAt: wall,
        });
      }
    }
    for (const [key, entry] of this.catalog) {
      if (wall - entry.seenAt > CATALOG_KEEP) this.catalog.delete(key);
    }
    if (this.catalog.size > MAX_CATALOG) {
      this.catalog = new Map([...this.catalog].slice(-MAX_CATALOG));
    }
  }

  /** The Discovery list from the crossings known; never a read. */
  async scan() {
    this.discoveryKey = undefined;
    await this.publishDiscovery();
  }

  async publishDiscovery() {
    const entries = [...this.catalog.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    );
    const devices = entries.map((entry) => buildDevice(this.gladys, entry, this.config.language));
    const key = JSON.stringify(devices);
    if (key === this.discoveryKey) return;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveryKey = key;
    } catch (err) {
      this.logger.warn(`Discovery not published (${err?.name ?? 'Error'})`);
    }
  }

  // --- Publication -------------------------------------------------------------------

  /** States still allowed this minute (the core accepts 300 per minute). */
  budgetLeft(mono) {
    this.sentLog = this.sentLog.filter((entry) => mono - entry.at < STATE_WINDOW);
    return STATE_BUDGET - this.sentLog.reduce((sum, entry) => sum + entry.n, 0);
  }

  /** The devices of this integration the user created: [{ kind, id, features: Set }]. */
  createdDevices() {
    const list = [];
    for (const device of this.gladys.devices ?? []) {
      const parsed = parseDeviceId(this.gladys, device?.external_id);
      if (!parsed) continue;
      const features = new Set((device.features ?? []).map((f) => f?.external_id));
      list.push({ ...parsed, features });
    }
    return list;
  }

  /**
   * The waits of the readings not published yet (each source reading once),
   * then the status texts that changed, within the budget.
   */
  async publishValues(gen) {
    const mono = this.monotonic();
    const values = [];
    const texts = [];
    const baselineDone = { ca: false, us: false };
    for (const device of this.createdDevices()) {
      const view = this.viewOf(device.kind, device.id, mono);
      const ids = idsOf(this.gladys, device.kind, device.id);
      for (const [key, value] of Object.entries(view.values)) {
        const fid = ids.feature(key);
        if (!device.features.has(fid)) continue;
        const last = this.published.get(fid);
        if (last !== undefined && value.stamp <= last) continue;
        if (this.baseline[device.kind]) {
          // /data was unreadable: what is there now may have been published before.
          this.published.set(fid, value.stamp);
          continue;
        }
        values.push({ fid, state: value.minutes, stamp: value.stamp });
      }
      if (view.status.code !== 'waiting') {
        baselineDone[device.kind] = true;
      }
      const fid = ids.feature('status');
      if (device.features.has(fid)) {
        const text = deviceStatus(this.config.language, view.status.code, view.status.time);
        if (this.sentTexts.get(fid) !== text) texts.push({ fid, text });
      }
    }
    for (const kind of ['ca', 'us']) {
      const loaded = kind === 'ca' ? this.cbsa : this.cbp;
      if (this.baseline[kind] && (baselineDone[kind] || loaded)) this.baseline[kind] = false;
    }
    let left = this.budgetLeft(mono);
    this.deferred = values.length + texts.length > left;
    const sendValues = values.slice(0, Math.max(0, left));
    left -= sendValues.length;
    const sendTexts = texts.slice(0, Math.max(0, left));
    for (let i = 0; i < sendValues.length; i += 100) {
      const batch = sendValues.slice(i, i + 100);
      try {
        await this.gladys.publishStates(
          batch.map((v) => ({ device_feature_external_id: v.fid, state: v.state })),
        );
      } catch (err) {
        this.logger.warn(`Values not published (${err?.name ?? 'Error'}): next read`);
        this.sentLog.push({ at: mono, n: batch.length });
        this.deferred = true;
        return;
      }
      this.sentLog.push({ at: mono, n: batch.length });
      if (gen !== this.run) return;
      for (const v of batch) this.published.set(v.fid, v.stamp);
    }
    if (this.published.size > MAX_PUBLISHED) {
      this.published = new Map([...this.published].slice(-MAX_PUBLISHED));
    }
    for (let i = 0; i < sendTexts.length; i += 100) {
      const batch = sendTexts.slice(i, i + 100);
      try {
        await this.gladys.publishStates(
          batch.map((t) => ({ device_feature_external_id: t.fid, text: t.text })),
        );
      } catch (err) {
        this.logger.warn(`Statuses not published (${err?.name ?? 'Error'})`);
        this.sentLog.push({ at: mono, n: batch.length });
        this.deferred = true;
        return;
      }
      this.sentLog.push({ at: mono, n: batch.length });
      if (gen !== this.run) return;
      for (const t of batch) this.sentTexts.set(t.fid, t.text);
    }
  }

  /** A device created: its waits are sent at the next read (never a read now). */
  async onDeviceCreated(device) {
    this.forgetDevice(device);
  }

  async onDeviceUpdated(device) {
    this.forgetDevice(device);
  }

  async onDeviceDeleted(device) {
    this.forgetDevice(device);
  }

  /** Gladys holds nothing for a new device: its last readings may be sent again. */
  forgetDevice(device) {
    const parsed = parseDeviceId(this.gladys, device?.external_id);
    if (!parsed) return;
    const ids = idsOf(this.gladys, parsed.kind, parsed.id);
    for (const key of [...WAIT_KEYS[parsed.kind], 'status']) {
      this.published.delete(ids.feature(key));
      this.sentTexts.delete(ids.feature(key));
    }
  }

  // --- Status ------------------------------------------------------------------------

  async updateStatus() {
    const mono = this.monotonic();
    const parts = [];
    for (const note of this.config.notes) parts.push(T.notes[note]);
    if (this.dataUnreadable) parts.push(T.dataUnreadable);
    if (this.saveFailed || this.dataBlocked) parts.push(T.dataUnwritable);
    const tried = [SOURCES.CBSA, SOURCES.CBP].some((s) => this.outcome[s] !== undefined);
    if (!tried) {
      const due = this.lastReadMono === undefined ? mono : this.lastReadMono + this.intervalMs;
      parts.unshift(T.waiting(Math.max(0, due - mono)));
      await this.setStatus(false, joinMessages(parts));
      return;
    }
    let connected = false;
    const sources = [SOURCES.CBSA, SOURCES.CBP];
    if (this.config.language === 'fr') sources.splice(1, 0, SOURCES.CBSA_FR);
    for (const source of sources) {
      const outcome = this.outcome[source];
      if (!outcome) continue;
      if (outcome.ok && source === SOURCES.CBP && this.cbpStale(mono)) {
        parts.push(problemText(source, { code: 'stale' }));
        continue;
      }
      if (outcome.ok) {
        if (source !== SOURCES.CBSA_FR) connected = true;
        continue;
      }
      parts.push(problemText(source, outcome, mono));
    }
    if (this.deferred) parts.push(T.budget);
    await this.setStatus(connected, joinMessages(parts));
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    try {
      await this.gladys.setConnectionStatus(connected, message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Status not sent (${err?.name ?? 'Error'})`);
    }
  }

  // --- /data ---------------------------------------------------------------------------

  /** Writes /data, awaited SAVE_WAIT at most (the save goes on in the background). */
  async saveState() {
    if (this.dataBlocked) return false;
    const pauses = {};
    for (const [source, pause] of Object.entries(this.pauses)) {
      pauses[source] = {
        until: pause.until,
        count: pause.count,
        code: pause.code,
        ...(pause.status !== undefined ? { status: pause.status } : {}),
      };
    }
    const data = {
      v: 1,
      lastAttemptAt: this.lastAttemptAt,
      pauses,
      catalog: [...this.catalog.values()],
      published: Object.fromEntries(this.published),
      cbpFeed: this.cbpFeed
        ? { time: this.cbpFeed.time, changedAt: this.cbpFeed.changedAt }
        : undefined,
    };
    const job = Promise.resolve()
      .then(() => this.store.save(data))
      .then(
        () => {
          this.saveFailed = false;
          return true;
        },
        (err) => {
          this.saveFailed = true;
          this.logger.warn(`/data not written (${err?.code ?? err?.name ?? 'Error'})`);
          return false;
        },
      );
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(false), SAVE_WAIT);
    });
    const done = await Promise.race([job, late]);
    this.timers.clearTimeout(timer);
    return done;
  }
}

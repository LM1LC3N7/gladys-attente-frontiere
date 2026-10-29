// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, scripted sources (a fetch that
// answers from builders or the real captures of test/fixtures) and a virtual
// clock (test/helpers/clock.js).
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BorderApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { createMemoryStore } from '../../src/store.js';
import { wire } from '../../src/wire.js';
import { settle, testClock } from './clock.js';

export const SELECTOR = 'af';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** 2026-10-29 21:05 UTC = 17:05 EDT: four minutes after the real captures. */
export const NOW = Date.UTC(2026, 9, 29, 21, 5);
export const URLS = {
  cbsa: 'https://cbsa.test/bwt-eng.csv',
  cbsaFr: 'https://cbsa.test/bwt-fra.csv',
  cbp: 'https://cbp.test/api/bwtnew',
};
export const F = (kind, id, key) => `ext:${SELECTOR}:${kind}:${id}:${key}`;
export const D = (kind, id) => `ext:${SELECTOR}:${kind}:${id}`;

export const fixture = (name) =>
  readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

// --- Builders ------------------------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
/** "2026-10-29 17:00 EDT" for an epoch ms and an offset in hours. */
export function cbsaTime(at, offsetHours = -4, zone = 'EDT') {
  const d = new Date(at + offsetHours * HOUR);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${zone}`;
}

export const CBSA_HEADER =
  'Customs Office;; Location;; Last updated;; Commercial Flow - Canada bound;; Commercial Flow - U.S. bound;; Travellers Flow - Canada bound;; Travellers Flow - U.S. bound;;';

/** A CSV of the CBSA: rows `{ office, location, updated, commercial, travellers }`. */
export function cbsaCsv(rows) {
  const lines = rows.map(
    (r) =>
      `${r.office};; ${r.location ?? 'Fort Erie, ON/Buffalo, NY'};; ${r.updated};; ${r.commercial ?? 'No Delay'};; --;; ${r.travellers ?? 'No Delay'};; --;; `,
  );
  return `\uFEFF${[CBSA_HEADER, ...lines].join('\r\n')}\r\n`;
}

const lane = (status, minutes, update) => ({
  update_time: update ?? '',
  operational_status: status,
  delay_minutes: minutes ?? '',
  lanes_open: '',
});

/** "10/29/2026" and "17:02:31" for a local naive time. */
function portStamp(localNaive) {
  const d = new Date(localNaive);
  return {
    date: `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${d.getUTCFullYear()}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
  };
}

/** "At 5:00 pm EDT" for a local naive time. */
export function atText(localNaive, zone = 'EDT') {
  const d = new Date(localNaive);
  const h = d.getUTCHours();
  return `At ${h % 12 === 0 ? 12 : h % 12}:${pad(d.getUTCMinutes())} ${h < 12 ? 'am' : 'pm'} ${zone}`;
}

/**
 * One CBP port: `local` = the port's local time now (naive ms), `updated` =
 * the local time of its lanes, `passenger` / `nexus` / `commercial` = minutes
 * or a status text.
 */
export function cbpPort({
  number = '090101',
  portName = 'Buffalo/Niagara Falls',
  crossing = 'Peace Bridge',
  border = 'Canadian Border',
  status = 'Open',
  local,
  updated = local,
  passenger = 10,
  nexus = 'N/A',
  ready = 'N/A',
  commercial = 5,
  fast = 'N/A',
}) {
  const at = atText(updated);
  const mk = (value) =>
    typeof value === 'number'
      ? lane(value > 0 ? 'delay' : 'no delay', String(value), at)
      : lane(value, '', value === 'N/A' ? '' : at);
  return {
    port_number: number,
    border,
    port_name: portName,
    crossing_name: crossing,
    hours: '24 hrs/day',
    ...portStamp(local),
    port_status: status,
    commercial_vehicle_lanes: {
      maximum_lanes: '5',
      standard_lanes: mk(commercial),
      FAST_lanes: mk(fast),
    },
    passenger_vehicle_lanes: {
      maximum_lanes: '8',
      standard_lanes: mk(passenger),
      NEXUS_SENTRI_lanes: mk(nexus),
      ready_lanes: mk(ready),
    },
    pedestrian_lanes: { maximum_lanes: 'N/A', standard_lanes: lane('N/A') },
    construction_notice: '',
  };
}

/** The local naive time of an EDT port for an epoch ms. */
export const edt = (at) => at - 4 * HOUR;

// --- Sources ---------------------------------------------------------------------------

export const text = (body, { status = 200, headers = {}, type = 'text/csv' } = {}) =>
  new Response(body, { status, headers: { 'content-type': type, ...headers } });

/**
 * The sources: `world[key](request)` -> a Response, a string (200 CSV / JSON),
 * an object (200 JSON), 'hang' (never answers), an Error (network) or a
 * promise of one of these. `requests` lists every request with its time.
 */
export function createSources(clock, world = {}) {
  const sources = { world, requests: [] };
  const keyOf = (url) => Object.entries(URLS).find(([, u]) => u === url)?.[0];
  sources.fetch = async (url, init) => {
    const key = keyOf(String(url));
    sources.requests.push({ key, at: clock.now(), headers: init?.headers ?? {} });
    let answer = await sources.world[key]?.(init);
    if (answer === 'hang') {
      answer = await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    }
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    if (answer === undefined) return text('not found', { status: 404 });
    const date = new Date(clock.now()).toUTCString();
    if (typeof answer === 'string') return text(answer, { headers: { date } });
    return text(JSON.stringify(answer), { headers: { date }, type: 'application/json' });
  };
  sources.count = (key) => sources.requests.filter((r) => r.key === key).length;
  return sources;
}

/** The real captures, as the sources answered at 17:04 EDT. */
export const realWorld = () => ({
  cbsa: () => fixture('cbsa-eng.csv'),
  cbsaFr: () => fixture('cbsa-fra.csv'),
  cbp: () => fixture('cbp-bwtnew.json'),
});

/** A device as the user created it from Discovery. */
export function created(gladys, entry, language = 'fr') {
  return buildDevice(gladys, entry, language);
}

export const quiet = () => {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  return { lines, info: log, warn: log, error: log, debug: log };
};

export async function setup({
  store = createMemoryStore(),
  config = {},
  world = realWorld(),
  start = NOW,
  clock = testClock({ start }),
  devices = [],
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const sources = createSources(clock, world);
  const logger = quiet();
  const app = new BorderApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    fetchImpl: sources.fetch,
    urls: URLS,
  });
  // The handlers as index.js wires them (deviceCreated, configUpdated...). The
  // 'connected' listener is not used here: `begin()` calls app.connected itself.
  wire(gladys, app, logger);
  gladys.removeAllListeners('connected');
  gladys.removeAllListeners('disconnected');
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle(10);
  };
  const begin = async () => {
    await app.connected(() => gladys.getConfig());
    await wait(0);
    await app.idle();
    await settle(10);
  };
  /** Creates a device of the Discovery list as the user does. */
  const create = async (kind, id) => {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D(kind, id));
    if (!device) throw new Error(`${kind}:${id} not in Discovery`);
    await gladys.fake.deviceCreated(structuredClone(device));
    return device;
  };
  const statesOf = (fid) => gladys.fake.states.filter((s) => s.device_feature_external_id === fid);
  return { app, gladys, clock, store, sources, logger, wait, begin, create, statesOf };
}

// -----------------------------------------------------------------------------
// Time zones of the CBP ports (pure). The CBP feed gives local times without
// a reliable zone (the abbreviation is typed by hand): each port gets its IANA
// zone from its CBP district (the first two digits of its port number), so
// that its local times become exact UTC instants across the changes of time
// (the repeated hour of November, the missing hour of March). A port of an
// unknown district takes every North American zone whose offset matches its
// feed time against the server `Date` header (src/cbp.js keeps the most
// prudent reading of them).
// -----------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** CBP districts of the Canadian border -> zone. */
const DISTRICTS = {
  '01': 'America/New_York', // Portland, Maine
  '02': 'America/New_York', // St. Albans, Vermont (and New Hampshire)
  '07': 'America/New_York', // Ogdensburg, New York
  '09': 'America/New_York', // Buffalo, New York
  30: 'America/Los_Angeles', // Seattle, Washington
  31: 'America/Anchorage', // Anchorage, Alaska
  33: 'America/Denver', // Great Falls, Montana (Idaho's ports below)
  34: 'America/Chicago', // Pembina, North Dakota and Minnesota
  35: 'America/Chicago', // Minneapolis, Minnesota
  36: 'America/Chicago', // Duluth, Minnesota
  38: 'America/Detroit', // Detroit, Michigan
};
/** Ports whose zone is not the one of their district: Eastport and Porthill, Idaho (Pacific). */
const PORTS = { 3302: 'America/Los_Angeles', 3308: 'America/Los_Angeles' };
/** The zones tried for a port of an unknown district, in this order. */
const FALLBACK = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'America/Halifax',
  'America/Phoenix',
  'America/Regina',
];

/** The zone of a CBP port number ("070801", "L01901"), else undefined. */
export function zoneOfPort(number) {
  const m = /^[A-Z]?(\d{2})(\d{2})/.exec(number ?? '');
  if (!m) return undefined;
  return PORTS[`${m[1]}${m[2]}`] ?? DISTRICTS[m[1]];
}

const formats = new Map();
function format(zone) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formats.set(zone, f);
  }
  return f;
}

/** The local time of `utc` in `zone`, as naive ms (UTC fields), to the second. */
export function localNaive(zone, utc) {
  const p = {};
  for (const part of format(zone).formatToParts(new Date(utc))) p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** The offset of `zone` at `utc`, in ms (negative west of Greenwich). */
export const offsetAt = (zone, utc) =>
  localNaive(zone, Math.floor(utc / 1000) * 1000) - Math.floor(utc / 1000) * 1000;

/**
 * Every UTC instant whose local time in `zone` is `naive` (ms, UTC fields),
 * sorted: none for a local time skipped in March, two for one repeated in
 * November, one otherwise.
 */
export function instantsOf(zone, naive) {
  const offsets = new Set([offsetAt(zone, naive - 14 * HOUR), offsetAt(zone, naive + 14 * HOUR)]);
  const out = [];
  for (const offset of offsets) {
    const utc = naive - offset;
    if (localNaive(zone, utc) === naive) out.push(utc);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * The zones a port of an unknown district may be in: those whose offset now
 * matches its feed time against the server time (the feed lags by a few
 * minutes; offset rounded to 30 min). Several may match (Eastern standard and
 * Central daylight time, Arizona and Pacific daylight time): the caller takes
 * every one into account and keeps the most prudent reading.
 */
export function inferZones(portNaive, ref) {
  if (!Number.isFinite(portNaive) || !Number.isFinite(ref)) return [];
  const offset = Math.round((portNaive - ref) / (30 * MINUTE)) * 30 * MINUTE;
  return FALLBACK.filter((zone) => offsetAt(zone, ref) === offset);
}

/** The first zone of `inferZones`, else undefined. */
export const inferZone = (portNaive, ref) => inferZones(portNaive, ref)[0];

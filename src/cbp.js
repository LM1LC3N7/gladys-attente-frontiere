// -----------------------------------------------------------------------------
// The Border Wait Times feed of U.S. Customs and Border Protection (pure).
//
// bwt.cbp.gov/api/bwtnew is the JSON behind bwt.cbp.gov (no formal
// documentation; the fields are the same as the documented XML feed
// bwt.cbp.gov/xml/bwt.xml): an array of ports, each with its border, number,
// names, status, the local date and time of the port ("10/29/2026",
// "17:02:31") and its lanes. A lane has an `operational_status` ("no delay",
// "delay", "Lanes Closed", "Update Pending", "N/A"), `delay_minutes` and an
// `update_time` ("At 5:00 pm EDT"). Only the Canadian border is kept.
//
// The zone abbreviation of `update_time` is typed by hand at the port and is
// sometimes wrong (an "EST" in October at a port on EDT): it is never used.
// The time of a lane is read as the local time of its port, on the date of
// the port, the day before when it is later than the time of the port; its
// age is the difference of the two local times. The age of the feed itself
// is checked by the app (src/app.js: a feed whose time no longer moves).
// -----------------------------------------------------------------------------

import { CBP_ROLLOVER_SLACK, DAY, MAX_ROWS, MAX_WAIT_MINUTES } from './constants.js';
import { FormatError } from './cbsa.js';

/** The lanes kept, by feature key: [group, lane]. */
export const CBP_LANES = {
  passenger: ['passenger_vehicle_lanes', 'standard_lanes'],
  nexus: ['passenger_vehicle_lanes', 'NEXUS_SENTRI_lanes'],
  ready: ['passenger_vehicle_lanes', 'ready_lanes'],
  commercial: ['commercial_vehicle_lanes', 'standard_lanes'],
  fast: ['commercial_vehicle_lanes', 'FAST_lanes'],
};

/** Control characters (never in a name nor a header). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\0-\x1f\x7f]/g;

const PORT_NUMBER = /^[A-Z0-9]{6}$/;

/** A printable name: no control character, spaces folded, bounded. */
const clean = (value, max = 60) =>
  typeof value === 'string'
    ? value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';

/** "10/29/2026" + "17:02:31" -> the local time of the port as naive ms (UTC fields), else undefined. */
export function parsePortTime(date, time) {
  const d = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date ?? '');
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time ?? '');
  if (!d || !t) return undefined;
  const [mo, day, y] = d.slice(1, 4).map(Number);
  const [h, mi, s] = [Number(t[1]), Number(t[2]), Number(t[3] ?? 0)];
  if (h > 23 || mi > 59 || s > 59) return undefined;
  const at = Date.UTC(y, mo - 1, day, h, mi, s);
  const back = new Date(at);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== day) return undefined;
  return at;
}

/** "At 5:00 pm EDT" -> minutes since local midnight and the text after "At", else undefined. */
export function parseUpdateTime(text) {
  const m = /^At (\d{1,2}):(\d{2}) ?(am|pm)(?: ([A-Z]{2,5}))?$/i.exec(clean(text, 40));
  if (!m) {
    if (/^At noon$/i.test(clean(text, 40))) return { minutes: 12 * 60, text: '12:00 pm' };
    if (/^At midnight$/i.test(clean(text, 40))) return { minutes: 0, text: '12:00 am' };
    return undefined;
  }
  let h = Number(m[1]);
  const mi = Number(m[2]);
  if (h < 1 || h > 12 || mi > 59) return undefined;
  const pm = m[3].toLowerCase() === 'pm';
  if (h === 12) h = 0;
  return {
    minutes: (pm ? h + 12 : h) * 60 + mi,
    text: clean(text, 40).replace(/^At /i, ''),
  };
}

/**
 * One lane.
 * @returns {{ kind: 'wait', minutes: number } | { kind: 'closed' | 'pending' | 'na' | 'none' |
 *   'unreadable' }} plus `stamp` (naive local ms), `age` (ms) and `updated` (text) when dated.
 */
export function parseLane(lane, portTime) {
  if (!lane || typeof lane !== 'object') return { kind: 'none' };
  const status = clean(lane.operational_status, 40).toLowerCase();
  let reading;
  if (status === 'no delay' || status === 'delay') {
    const raw = clean(lane.delay_minutes, 10);
    const minutes = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    reading =
      Number.isInteger(minutes) && minutes <= MAX_WAIT_MINUTES
        ? { kind: 'wait', minutes }
        : { kind: 'unreadable' };
  } else if (status === 'lanes closed') {
    reading = { kind: 'closed' };
  } else if (status === 'update pending') {
    reading = { kind: 'pending' };
  } else if (status === 'n/a') {
    reading = { kind: 'na' };
  } else if (status === '') {
    reading = { kind: 'none' };
  } else {
    reading = { kind: 'unreadable' };
  }
  const update = parseUpdateTime(lane.update_time);
  if (update && portTime !== undefined) {
    const midnight = portTime - (portTime % DAY);
    let stamp = midnight + update.minutes * 60_000;
    if (stamp > portTime + CBP_ROLLOVER_SLACK) stamp -= DAY;
    reading.stamp = stamp;
    reading.age = Math.max(0, portTime - stamp);
    reading.updated = update.text;
  }
  return reading;
}

/**
 * The feed: the ports of the Canadian border with a valid number.
 * @returns {{ ports: Array<{ id, name, portName, crossing, open: boolean | undefined,
 *   portTime: number | undefined, lanes: Record<string, object> }>, feedTime: number | undefined,
 *   skipped: number }}
 */
export function parseCbp(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new FormatError('not JSON');
  }
  if (!Array.isArray(data)) throw new FormatError('not an array');
  if (data.length > MAX_ROWS) throw new FormatError('too many ports');
  const ports = [];
  const seen = new Set();
  let skipped = 0;
  let feedTime;
  for (const port of data) {
    if (!port || typeof port !== 'object' || Array.isArray(port)) {
      skipped += 1;
      continue;
    }
    if (clean(port.border).toLowerCase() !== 'canadian border') continue;
    const id = typeof port.port_number === 'string' ? port.port_number.trim() : '';
    if (!PORT_NUMBER.test(id) || seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    const portName = clean(port.port_name);
    const crossing = clean(port.crossing_name);
    const portTime = parsePortTime(clean(port.date, 12), clean(port.time, 10));
    if (portTime !== undefined && (feedTime === undefined || portTime > feedTime)) {
      feedTime = portTime;
    }
    const portStatus = clean(port.port_status, 20).toLowerCase();
    const lanes = {};
    for (const [key, [group, lane]] of Object.entries(CBP_LANES)) {
      const groupOf = port[group];
      lanes[key] = parseLane(
        groupOf && typeof groupOf === 'object' ? groupOf[lane] : undefined,
        portTime,
      );
    }
    ports.push({
      id,
      name: crossing && crossing !== portName ? `${portName} - ${crossing}` : portName || id,
      portName,
      crossing,
      open: portStatus === 'open' ? true : portStatus === 'closed' ? false : undefined,
      portTime,
      lanes,
    });
  }
  if (ports.length === 0) throw new FormatError('no port of the Canadian border');
  return { ports, feedTime, skipped };
}

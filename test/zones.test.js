// -----------------------------------------------------------------------------
// The zones of the CBP ports and the changes of time (2026: 8 March and
// 1 November in the U.S.): local times turned into exact UTC instants, the
// repeated hour of November resolved without taking a stale reading for a
// fresh one nor a new reading for an old one, the missing hour of March.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCbp, resolvePort } from '../src/cbp.js';
import {
  inferZone,
  inferZones,
  instantsOf,
  localNaive,
  offsetAt,
  zoneOfPort,
} from '../src/zones.js';
import { HOUR, MINUTE, atText, cbpPort, fixture } from './helpers/app.js';

const N = (y, mo, d, h, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s);

test('the zone of each port comes from its CBP district', () => {
  assert.equal(zoneOfPort('090101'), 'America/New_York');
  assert.equal(zoneOfPort('L01901'), 'America/New_York');
  assert.equal(zoneOfPort('380201'), 'America/Detroit');
  assert.equal(zoneOfPort('340101'), 'America/Chicago');
  assert.equal(zoneOfPort('360401'), 'America/Chicago');
  assert.equal(zoneOfPort('331001'), 'America/Denver');
  assert.equal(zoneOfPort('330201'), 'America/Los_Angeles', 'Eastport, Idaho');
  assert.equal(zoneOfPort('300401'), 'America/Los_Angeles');
  assert.equal(zoneOfPort('310401'), 'America/Anchorage');
  assert.equal(zoneOfPort('990101'), undefined);
  assert.equal(zoneOfPort('x'), undefined);
});

test('an unknown district: the zone whose offset matches the feed time against the server Date', () => {
  // 17:02 local while the server says 21:04 UTC: UTC-4 in October -> Eastern.
  assert.equal(inferZone(N(2026, 10, 29, 17, 2), N(2026, 10, 29, 21, 4)), 'America/New_York');
  assert.equal(inferZone(N(2026, 10, 29, 14, 2), N(2026, 10, 29, 21, 4)), 'America/Los_Angeles');
  assert.equal(inferZone(N(2026, 10, 29, 3, 0), N(2026, 10, 29, 21, 4)), undefined);
  assert.equal(inferZone(undefined, N(2026, 10, 29, 21, 4)), undefined);
});

test('local times -> UTC: one instant, two in the repeated hour, none in the missing one', () => {
  const ny = 'America/New_York';
  assert.deepEqual(instantsOf(ny, N(2026, 10, 29, 17, 0)), [N(2026, 10, 29, 21, 0)]);
  // 1 November 2026, 01:30 happens twice: 05:30 UTC (EDT) and 06:30 UTC (EST).
  assert.deepEqual(instantsOf(ny, N(2026, 11, 1, 1, 30)), [
    N(2026, 11, 1, 5, 30),
    N(2026, 11, 1, 6, 30),
  ]);
  // 8 March 2026, 02:30 never happens.
  assert.deepEqual(instantsOf(ny, N(2026, 3, 8, 2, 30)), []);
  assert.equal(offsetAt(ny, N(2026, 7, 1, 12)), -4 * HOUR);
  assert.equal(offsetAt(ny, N(2026, 12, 1, 12)), -5 * HOUR);
  assert.equal(localNaive('America/Los_Angeles', N(2026, 11, 1, 9, 30)), N(2026, 11, 1, 1, 30));
});

/** One Detroit port with its feed time and a passenger lane at a local time. */
function port(feedNaive, laneNaive) {
  const json = JSON.stringify([
    cbpPort({ number: '380001', local: feedNaive, updated: laneNaive, passenger: 9 }),
  ]);
  return parseCbp(json).ports[0];
}

test('fall-back: a reading of the evening before (EDT) is 2.5 h old, not 1.5 h', () => {
  // Feed at 01:00 EST (06:00 UTC); lane "11:30 pm" = 23:30 EDT the day before = 03:30 UTC.
  const p = resolvePort(port(N(2026, 11, 1, 1, 0), N(2026, 10, 31, 23, 30)), N(2026, 11, 1, 6, 1));
  assert.equal(p.feedUtc, N(2026, 11, 1, 6, 0));
  assert.equal(p.lanes.passenger.stamp, N(2026, 11, 1, 3, 30));
  assert.equal(p.lanes.passenger.age, 2.5 * HOUR);
});

test('fall-back: a time of the repeated hour, never seen before, is taken as the earlier one (never a stale reading as fresh)', () => {
  // Feed at 03:00 EST (08:00 UTC); lane "1:30 am": 05:30 UTC (EDT, 2.5 h) or 06:30 UTC (EST, 1.5 h).
  const p = resolvePort(port(N(2026, 11, 1, 3, 0), N(2026, 11, 1, 1, 30)), N(2026, 11, 1, 8, 1));
  assert.equal(p.lanes.passenger.stamp, N(2026, 11, 1, 5, 30));
  assert.equal(p.lanes.passenger.age, 2.5 * HOUR);
});

test('fall-back: a NEW reading of the repeated hour after one published is the later instant', () => {
  // 01:20 EDT (05:20 UTC) published; feed at 01:10 EST (06:10 UTC), lane "1:05 am".
  const last = N(2026, 11, 1, 5, 20);
  const p = resolvePort(
    port(N(2026, 11, 1, 1, 10), N(2026, 11, 1, 1, 5)),
    N(2026, 11, 1, 6, 11),
    () => last,
  );
  assert.equal(p.lanes.passenger.stamp, N(2026, 11, 1, 6, 5));
  assert.equal(p.lanes.passenger.age, 5 * MINUTE);
  // The same reading seen again (its local time unchanged): the instant already published.
  const same = resolvePort(
    port(N(2026, 11, 1, 1, 40), N(2026, 11, 1, 1, 20)),
    N(2026, 11, 1, 6, 41),
    () => last,
  );
  assert.equal(same.lanes.passenger.stamp, last);
});

test('fall-back: before the change, the repeated hour is only its first pass', () => {
  // Feed at 01:30 EDT (05:30 UTC), lane "1:20 am": 06:20 UTC would be after the feed.
  const p = resolvePort(port(N(2026, 11, 1, 1, 30), N(2026, 11, 1, 1, 20)), N(2026, 11, 1, 5, 31));
  assert.equal(p.lanes.passenger.stamp, N(2026, 11, 1, 5, 20));
});

test('spring-forward: a reading of 01:45 EST seen at 04:30 EDT is 1 h 45 old, not 2 h 45', () => {
  const p = resolvePort(port(N(2026, 3, 8, 4, 30), N(2026, 3, 8, 1, 45)), N(2026, 3, 8, 8, 31));
  assert.equal(p.feedUtc, N(2026, 3, 8, 8, 30));
  assert.equal(p.lanes.passenger.stamp, N(2026, 3, 8, 6, 45));
  assert.equal(p.lanes.passenger.age, 105 * MINUTE);
});

test('spring-forward: a lane time that never existed today (2:30 am) is the one of the day before: stale', () => {
  const json = JSON.stringify([
    cbpPort({ number: '380001', local: N(2026, 3, 8, 4, 0), passenger: 9 }),
  ]).replaceAll(atText(N(2026, 3, 8, 4, 0)), 'At 2:30 am EDT');
  const p = resolvePort(parseCbp(json).ports[0], N(2026, 3, 8, 8, 1));
  assert.equal(p.lanes.passenger.stamp, N(2026, 3, 7, 7, 30));
  assert.ok(p.lanes.passenger.age > 24 * HOUR);
});

test('a lane later than its port time by more than 30 min is of the day before', () => {
  const p = resolvePort(
    port(N(2026, 10, 29, 17, 2), N(2026, 10, 29, 17, 40)),
    N(2026, 10, 29, 21, 3),
  );
  assert.equal(p.lanes.passenger.stamp, N(2026, 10, 28, 21, 40));
  const q = resolvePort(
    port(N(2026, 10, 29, 17, 2), N(2026, 10, 29, 17, 20)),
    N(2026, 10, 29, 21, 3),
  );
  assert.equal(q.lanes.passenger.stamp, N(2026, 10, 29, 21, 20), 'a few minutes ahead: today');
});

test('an unknown district without a usable server time: no date, nothing published', () => {
  const json = JSON.stringify([
    cbpPort({ number: '990101', local: N(2026, 10, 29, 3, 0), passenger: 9 }),
  ]);
  const p = resolvePort(parseCbp(json).ports[0], N(2026, 10, 29, 21, 4));
  assert.equal(p.zone, undefined);
  assert.equal(p.feedUtc, undefined);
  assert.equal(p.lanes.passenger.stamp, undefined);
});

test('an unknown district during a change of time: every matching zone, the most prudent reading', () => {
  // 01:30 local at 06:32 UTC on 1 November: UTC-5 = Eastern standard and Central daylight time.
  assert.deepEqual(inferZones(N(2026, 11, 1, 1, 30), N(2026, 11, 1, 6, 32)), [
    'America/New_York',
    'America/Chicago',
  ]);
  assert.deepEqual(inferZones(N(2026, 7, 1, 5, 0), N(2026, 7, 1, 12, 0)), [
    'America/Los_Angeles',
    'America/Phoenix',
  ]);
  // Lane "12:45 am": 04:45 UTC if Eastern (EDT), 05:45 UTC if Central (CDT): the earlier is kept.
  const json = JSON.stringify([
    cbpPort({ number: '990101', local: N(2026, 10, 29, 3, 0), passenger: 9 }),
  ]);
  const p = resolvePort(parseCbp(json).ports[0], N(2026, 10, 29, 21, 4));
  assert.equal(p.zone, undefined);
  assert.equal(p.feedUtc, undefined);
  assert.equal(p.lanes.passenger.stamp, undefined);
});

test('an unknown district during a change of time: every matching zone, the most prudent reading', () => {
  // 01:30 local at 06:32 UTC on 1 November: UTC-5 = Eastern standard and Central daylight time.
  assert.deepEqual(inferZones(N(2026, 11, 1, 1, 30), N(2026, 11, 1, 6, 32)), [
    'America/New_York',
    'America/Chicago',
  ]);
  assert.deepEqual(inferZones(N(2026, 7, 1, 5, 0), N(2026, 7, 1, 12, 0)), [
    'America/Los_Angeles',
    'America/Phoenix',
  ]);
  // Lane "12:45 am": 05:45 UTC (Eastern, then EDT) or 05:45 UTC (Central CDT)... and 06:45 for
  // Chicago's... the earliest of the latest day is kept.
  const json = JSON.stringify([
    cbpPort({
      number: '990101',
      local: N(2026, 11, 1, 1, 30),
      updated: N(2026, 11, 1, 0, 45),
      passenger: 9,
    }),
  ]);
  const p = resolvePort(parseCbp(json).ports[0], N(2026, 11, 1, 6, 32));
  assert.deepEqual(p.zones, ['America/New_York', 'America/Chicago']);
  assert.equal(p.zone, undefined);
  assert.equal(p.lanes.passenger.stamp, N(2026, 11, 1, 4, 45), '00:45 EDT, the earliest reading');
});

test('every port of the real capture gets its zone from its district', () => {
  const zones = Object.fromEntries(
    parseCbp(fixture('cbp-bwtnew.json')).ports.map((p) => [p.id, zoneOfPort(p.id)]),
  );
  const east = [
    '010401',
    '010601',
    '011501',
    '011502',
    '011503',
    '020901',
    '021101',
    '021201',
    '070101',
    '070401',
    '070801',
    '071201',
    '090101',
    '090102',
    '090103',
    '090104',
    'L01901',
  ];
  for (const id of east) assert.equal(zones[id], 'America/New_York', id);
  for (const id of ['380001', '380002', '380102', '380201', '380301'])
    assert.equal(zones[id], 'America/Detroit', id);
  for (const id of ['300401', '300402', '300403', '300901', '302301'])
    assert.equal(zones[id], 'America/Los_Angeles', id);
  assert.equal(zones['331001'], 'America/Denver');
  assert.equal(zones['340101'], 'America/Chicago');
  assert.equal(zones['360401'], 'America/Chicago');
  assert.equal(Object.keys(zones).length, 30);
  // Idaho's ports of the Great Falls district are on Pacific time: Eastport and Porthill.
  assert.equal(zoneOfPort('330201'), 'America/Los_Angeles');
  assert.equal(zoneOfPort('330801'), 'America/Los_Angeles');
  assert.equal(zoneOfPort('331801'), 'America/Denver', 'Roosville, Montana');
});

test('a lane a little ahead of its port (within 30 min) is 0 min old, never younger', () => {
  const p = resolvePort(
    port(N(2026, 10, 29, 17, 2), N(2026, 10, 29, 17, 20)),
    N(2026, 10, 29, 21, 3),
  );
  assert.equal(p.lanes.passenger.age, 0);
});

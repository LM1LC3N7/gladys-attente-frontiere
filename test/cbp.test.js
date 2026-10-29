// -----------------------------------------------------------------------------
// The CBP feed, on the real capture of 2026-10-29 (17:02 EDT) and on built
// ports: the Canadian border only, the lanes, the local times of the port
// (the zone typed by hand is never trusted), never a text read as a number.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FormatError } from '../src/cbsa.js';
import { parseCbp, parseLane, parsePortTime, parseUpdateTime } from '../src/cbp.js';
import { HOUR, MINUTE, cbpPort, fixture } from './helpers/app.js';

const LOCAL = Date.UTC(2026, 9, 29, 17, 2, 31);

test('the real capture: the 30 ports of the Canadian border, none of the Mexican one', () => {
  const { ports, feedTime } = parseCbp(fixture('cbp-bwtnew.json'));
  assert.equal(ports.length, 30);
  assert.equal(feedTime, LOCAL);
  const by = Object.fromEntries(ports.map((p) => [p.id, p]));
  assert.equal(by['260101'], undefined, 'Douglas, Arizona: Mexican border');
  const peace = by['090101'];
  assert.equal(peace.name, 'Buffalo/Niagara Falls - Peace Bridge');
  assert.equal(peace.open, true);
  assert.equal(peace.lanes.passenger.kind, 'wait');
  assert.equal(peace.lanes.passenger.minutes, 20);
  assert.equal(peace.lanes.passenger.stamp, Date.UTC(2026, 9, 29, 16, 57));
  assert.equal(peace.lanes.passenger.age, 5 * MINUTE + 31_000);
  assert.equal(peace.lanes.ready.kind, 'closed');
  assert.equal(peace.lanes.fast.kind, 'na');
  // "Champlain" has no crossing name: the port name alone.
  assert.equal(by['071201'].name, 'Champlain');
  // L01901 (Madawaska): letters are valid in a port number.
  assert.ok(by.L01901);
});

test('a lane time later than the port time is of the day before; the typed zone is ignored', () => {
  const { ports } = parseCbp(fixture('cbp-bwtnew.json'));
  const by = Object.fromEntries(ports.map((p) => [p.id, p]));
  // Ogdensburg: "At 11:00 pm EDT" on 10/29 at 17:02 -> 10/28 23:00, 18 h old.
  const ogd = by['070101'].lanes.passenger;
  assert.equal(ogd.stamp, Date.UTC(2026, 9, 28, 23, 0));
  assert.ok(ogd.age > 18 * HOUR && ogd.age < 18.1 * HOUR);
  // Port Huron: "At 4:00 pm EST" at a port on EDT: read as 16:00 local, about an hour old.
  const huron = by['380201'].lanes.passenger;
  assert.equal(huron.minutes, 14);
  assert.equal(huron.stamp, Date.UTC(2026, 9, 29, 16, 0));
  assert.ok(huron.age > HOUR && huron.age < 1.1 * HOUR);
});

test('lanes: delay, no delay, closed, pending, N/A; a text is never 0', () => {
  const lane = (status, minutes = '', update = 'At 4:30 pm EDT') =>
    parseLane({ operational_status: status, delay_minutes: minutes, update_time: update }, LOCAL);
  assert.equal(lane('no delay', '0').minutes, 0);
  assert.equal(lane('delay', '35').minutes, 35);
  assert.equal(lane('delay', '35').stamp, Date.UTC(2026, 9, 29, 16, 30));
  assert.equal(lane('Lanes Closed').kind, 'closed');
  assert.equal(lane('Update Pending').kind, 'pending');
  assert.equal(lane('N/A').kind, 'na');
  assert.equal(lane('').kind, 'none');
  for (const [status, minutes] of [
    ['delay', ''],
    ['delay', '5.5'],
    ['delay', '-1'],
    ['delay', '1441'],
    ['no delay', 'abc'],
    ['heavy delay', '10'],
  ]) {
    assert.equal(lane(status, minutes).kind, 'unreadable', `${status} ${minutes}`);
    assert.equal(lane(status, minutes).minutes, undefined);
  }
  // No update time: no date (never published).
  assert.equal(lane('delay', '5', '').stamp, undefined);
  assert.equal(parseLane(undefined, LOCAL).kind, 'none');
  assert.equal(
    parseLane({ operational_status: 'delay', delay_minutes: '5' }, undefined).stamp,
    undefined,
  );
});

test('update times: 12-hour clock, noon and midnight, nothing else', () => {
  assert.deepEqual(parseUpdateTime('At 5:00 pm EDT'), { minutes: 17 * 60, text: '5:00 pm EDT' });
  assert.equal(parseUpdateTime('At 12:15 am PDT').minutes, 15);
  assert.equal(parseUpdateTime('At 12:15 pm PDT').minutes, 12 * 60 + 15);
  assert.equal(parseUpdateTime('At 9:05 AM').minutes, 9 * 60 + 5);
  assert.equal(parseUpdateTime('At noon').minutes, 720);
  assert.equal(parseUpdateTime('At midnight').minutes, 0);
  for (const bad of ['', 'At 13:00 pm EDT', 'At 0:30 am EDT', 'At 5:60 pm', '5:00 pm', undefined]) {
    assert.equal(parseUpdateTime(bad), undefined, String(bad));
  }
});

test('port times: strict date and time', () => {
  assert.equal(parsePortTime('10/29/2026', '17:02:31'), LOCAL);
  assert.equal(parsePortTime('2/30/2026', '17:02:31'), undefined);
  assert.equal(parsePortTime('10/29/2026', '25:00:00'), undefined);
  assert.equal(parsePortTime('2026-10-29', '17:02:31'), undefined);
  assert.equal(parsePortTime('', ''), undefined);
});

test('a closed port, a bad port number, a duplicate: read as such or skipped', () => {
  const local = LOCAL;
  const data = [
    cbpPort({ local, status: 'Closed' }),
    cbpPort({ local, number: '09.101' }),
    cbpPort({ local, number: '090101' }),
    cbpPort({ local, number: '300401', border: 'Mexican Border' }),
    null,
    'text',
  ];
  const { ports, skipped } = parseCbp(JSON.stringify(data));
  assert.equal(ports.length, 1);
  assert.equal(ports[0].open, false);
  assert.equal(skipped, 4);
});

test('a feed that is not the expected one is a format error', () => {
  assert.throws(() => parseCbp('<html></html>'), FormatError);
  assert.throws(() => parseCbp('{"ports":[]}'), FormatError);
  assert.throws(() => parseCbp('[]'), FormatError);
  assert.throws(() => parseCbp(JSON.stringify(new Array(401).fill({}))), FormatError);
  // A __proto__ key in a port is an own property of the parsed object: nothing is polluted.
  const port = JSON.stringify(cbpPort({ local: LOCAL })).replace(
    '{',
    '{"__proto__":{"polluted":1},',
  );
  parseCbp(`[${port}]`);
  assert.equal({}.polluted, undefined);
});

test('names: control characters and long names cleaned', () => {
  const { ports } = parseCbp(
    JSON.stringify([
      cbpPort({ local: LOCAL, portName: 'Blaine\u0007\n', crossing: 'x'.repeat(200) }),
    ]),
  );
  assert.ok(![...ports[0].name].some((c) => c.charCodeAt(0) < 0x20));
  assert.ok(ports[0].name.length <= 130);
});

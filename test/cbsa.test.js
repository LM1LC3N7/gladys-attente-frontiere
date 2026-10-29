// -----------------------------------------------------------------------------
// The CSV files of the CBSA, on the real captures of 2026-10-29 (17:04 EDT)
// and on built ones: ids, dates with their zone, waits, never a text read as
// a number.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FormatError,
  frenchNames,
  parseCbsaEnglish,
  parseCbsaFrench,
  parseUpdated,
  parseWait,
  slugOf,
} from '../src/cbsa.js';
import { CBSA_HEADER, cbsaCsv, fixture } from './helpers/app.js';

test('the real English file: 30 offices, ids, dates and waits', () => {
  const { rows, skipped } = parseCbsaEnglish(fixture('cbsa-eng.csv'));
  assert.equal(rows.length, 30);
  assert.equal(skipped, 0);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).slice(0, 3), [
    'st-stephen',
    'st-stephen-3rd-bridge',
    'edmundston',
  ]);
  assert.ok(by['lacolle-route-223'] && by['windsor-and-detroit-tunnel'] && by['peace-bridge']);
  // "No Delay" is a wait of 0 minutes; "20 minutes" is 20.
  assert.deepEqual(by['st-bernard-de-lacolle'].travellers, { kind: 'wait', minutes: 20 });
  assert.deepEqual(by['st-bernard-de-lacolle'].commercial, { kind: 'wait', minutes: 0 });
  // "Closed", "Not Applicable": never a number.
  assert.deepEqual(by['st-stephen'].travellers, { kind: 'closed' });
  assert.deepEqual(by['st-stephen'].commercial, { kind: 'na' });
  assert.deepEqual(by['rainbow-bridge'].commercial, { kind: 'na' });
  // "2026-10-29 16:40 EDT" = 20:40 UTC; "13:40 PDT" = 20:40 UTC; "13:15 CST" (Saskatchewan) = 19:15 UTC.
  assert.equal(by['peace-bridge'].stamp, Date.UTC(2026, 9, 29, 20, 40));
  assert.equal(by['abbotsford-huntingdon'].stamp, Date.UTC(2026, 9, 29, 20, 40));
  assert.equal(by['north-portal'].stamp, Date.UTC(2026, 9, 29, 19, 15));
  assert.equal(by['st-stephen'].stamp, Date.UTC(2026, 9, 16, 13, 33));
  assert.equal(by['peace-bridge'].location, 'Fort Erie, ON/Buffalo, NY');
});

test('the real French file gives the French names, matched on position and location', () => {
  const english = fixture('cbsa-eng.csv');
  const names = frenchNames(english, parseCbsaFrench(fixture('cbsa-fra.csv')));
  assert.equal(names.get('peace-bridge'), 'Pont Peace');
  assert.equal(names.get('thousand-islands-bridge'), 'Pont des Mille-Îles');
  assert.equal(names.get('st-stephen-3rd-bridge'), 'St. Stephen 3e Pont');
  // Another location at the same position: no French name (the English one stays).
  const french = parseCbsaFrench(fixture('cbsa-fra.csv'));
  french[0] = { name: 'Ailleurs', location: 'Somewhere, QC/Else, NY' };
  assert.equal(frenchNames(english, french).has('st-stephen'), false);
  assert.equal(frenchNames(undefined, french).size, 0);
});

test('dates: every zone of the file, exact; anything else is unreadable', () => {
  const at = (zone) => parseUpdated(`2026-07-01 12:00 ${zone}`);
  const noon = Date.UTC(2026, 6, 1, 12);
  assert.equal(at('NDT'), noon + 2.5 * 3600_000);
  assert.equal(at('NST'), noon + 3.5 * 3600_000);
  assert.equal(at('ADT'), noon + 3 * 3600_000);
  assert.equal(at('EDT'), noon + 4 * 3600_000);
  assert.equal(at('EST'), noon + 5 * 3600_000);
  assert.equal(at('CST'), noon + 6 * 3600_000);
  assert.equal(at('MDT'), noon + 6 * 3600_000);
  assert.equal(at('PDT'), noon + 7 * 3600_000);
  assert.equal(at('PST'), noon + 8 * 3600_000);
  for (const bad of [
    '2026-02-30 12:00 EDT',
    '2026-10-29 24:00 EDT',
    '2026-10-29 12:60 EDT',
    '2026-10-29 12:00 XYZ',
    '2026-10-29 12:00',
    '2026-10-29 12:00 HAE',
    '',
    '--',
    undefined,
  ]) {
    assert.equal(parseUpdated(bad), undefined, String(bad));
  }
  // Midnight crossing in the west: 23:30 PDT is 06:30 UTC the next day.
  assert.equal(parseUpdated('2026-10-29 23:30 PDT'), Date.UTC(2026, 9, 30, 6, 30));
});

test('waits: minutes and hours, bounded; a text is never 0', () => {
  assert.deepEqual(parseWait('No Delay'), { kind: 'wait', minutes: 0 });
  assert.deepEqual(parseWait('no delay'), { kind: 'wait', minutes: 0 });
  assert.deepEqual(parseWait('1 minute'), { kind: 'wait', minutes: 1 });
  assert.deepEqual(parseWait('45 minutes'), { kind: 'wait', minutes: 45 });
  assert.deepEqual(parseWait('2 hours'), { kind: 'wait', minutes: 120 });
  assert.deepEqual(parseWait('1 hour 30 minutes'), { kind: 'wait', minutes: 90 });
  assert.deepEqual(parseWait('1440 minutes'), { kind: 'wait', minutes: 1440 });
  assert.deepEqual(parseWait('1441 minutes'), { kind: 'unreadable' });
  assert.deepEqual(parseWait('Closed'), { kind: 'closed' });
  assert.deepEqual(parseWait('Temporarily closed'), { kind: 'closed' });
  assert.deepEqual(parseWait('Not Applicable'), { kind: 'na' });
  assert.deepEqual(parseWait('--'), { kind: 'none' });
  assert.deepEqual(parseWait(''), { kind: 'none' });
  for (const bad of [
    'Fermé',
    '5.5 minutes',
    '-3 minutes',
    'minutes',
    '0x10 minutes',
    'Delay',
    '12',
  ]) {
    assert.deepEqual(parseWait(bad), { kind: 'unreadable' }, bad);
  }
});

test('ids: lowercase ASCII and dashes, never a dot nor a colon', () => {
  assert.equal(slugOf('Lacolle: Route 223'), 'lacolle-route-223');
  assert.equal(slugOf('St-Armand/Philipsburg'), 'st-armand-philipsburg');
  assert.equal(slugOf('Pont des Mille-Îles'), 'pont-des-mille-iles');
  assert.equal(slugOf('../..'), '');
  assert.equal(slugOf('a'.repeat(80)).length, 48);
  assert.equal(slugOf(undefined), '');
});

test('a file that is not the expected one is a format error, never values', () => {
  assert.throws(() => parseCbsaEnglish(''), FormatError);
  assert.throws(() => parseCbsaEnglish('<html>Maintenance</html>'), FormatError);
  assert.throws(
    () => parseCbsaEnglish(CBSA_HEADER.replace('Last updated', 'Updated')),
    FormatError,
  );
  assert.throws(() => parseCbsaEnglish(`${CBSA_HEADER}\n`), FormatError);
  const many = cbsaCsv(
    Array.from({ length: 401 }, (_, i) => ({
      office: `Office ${i}`,
      updated: '2026-10-29 16:00 EDT',
    })),
  );
  assert.throws(() => parseCbsaEnglish(many), FormatError);
  assert.throws(() => parseCbsaEnglish(undefined), FormatError);
});

test('a short line, a duplicate office or an empty name is skipped, the others kept', () => {
  const csv = `${cbsaCsv([
    { office: 'Peace Bridge', updated: '2026-10-29 16:40 EDT', travellers: '5 minutes' },
    { office: 'Peace Bridge', updated: '2026-10-29 16:40 EDT', travellers: '50 minutes' },
    { office: '...', updated: '2026-10-29 16:40 EDT' },
  ])}Short line;; only;;\n`;
  const { rows, skipped } = parseCbsaEnglish(csv);
  assert.equal(rows.length, 1);
  assert.equal(skipped, 3);
  assert.deepEqual(rows[0].travellers, { kind: 'wait', minutes: 5 });
});

test('columns are found by name, not by position', () => {
  const csv =
    'Location;; Customs Office;; Travellers Flow - Canada bound;; Last updated;; Commercial Flow - Canada bound;;\n' +
    'Fort Erie, ON/Buffalo, NY;; Peace Bridge;; 7 minutes;; 2026-10-29 16:40 EDT;; No Delay;;\n';
  const [row] = parseCbsaEnglish(csv).rows;
  assert.equal(row.id, 'peace-bridge');
  assert.deepEqual(row.travellers, { kind: 'wait', minutes: 7 });
  assert.deepEqual(row.commercial, { kind: 'wait', minutes: 0 });
});

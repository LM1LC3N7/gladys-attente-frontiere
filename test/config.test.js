// -----------------------------------------------------------------------------
// The form, normalized: defaults, bounds, strict numbers; a value replaced is
// noted for the status (never repeated back).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig } from '../src/config.js';

test('defaults: French, 15 minutes', () => {
  assert.deepEqual(normalizeConfig(), { language: 'fr', intervalMinutes: 15, notes: [] });
  assert.deepEqual(normalizeConfig({ interval_minutes: '', language: null }), {
    language: 'fr',
    intervalMinutes: 15,
    notes: [],
  });
  assert.deepEqual(normalizeConfig(null).intervalMinutes, 15);
});

test('the interval: 10 to 60 minutes, out of bounds brought back and noted', () => {
  assert.equal(normalizeConfig({ interval_minutes: 10 }).intervalMinutes, 10);
  assert.equal(normalizeConfig({ interval_minutes: '45' }).intervalMinutes, 45);
  assert.deepEqual(normalizeConfig({ interval_minutes: 5 }), {
    language: 'fr',
    intervalMinutes: 10,
    notes: ['interval'],
  });
  assert.deepEqual(normalizeConfig({ interval_minutes: 0 }).intervalMinutes, 10);
  assert.deepEqual(normalizeConfig({ interval_minutes: 600 }), {
    language: 'fr',
    intervalMinutes: 60,
    notes: ['interval'],
  });
  for (const bad of [12.5, '12.5', 'abc', -3, '1e3', NaN, true]) {
    const config = normalizeConfig({ interval_minutes: bad });
    assert.equal(config.intervalMinutes, 15, String(bad));
    assert.deepEqual(config.notes, ['interval'], String(bad));
  }
});

test('the language: fr or en', () => {
  assert.equal(normalizeConfig({ language: 'en' }).language, 'en');
  assert.deepEqual(normalizeConfig({ language: 'de' }), {
    language: 'fr',
    intervalMinutes: 15,
    notes: ['language'],
  });
});

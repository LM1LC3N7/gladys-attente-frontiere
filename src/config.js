// -----------------------------------------------------------------------------
// The configuration typed in Gladys (manifest `config_schema`), normalized so
// that the rest of the code never sees `undefined` nor a value out of bounds.
// Nothing secret: both sources are open data, without account nor key.
// -----------------------------------------------------------------------------

import { INTERVAL_DEFAULT_MIN, INTERVAL_MAX_MIN, INTERVAL_MIN_MIN } from './constants.js';

/** Defaults: the same as the `default` values of the manifest. */
export const DEFAULT_CONFIG = { language: 'fr', interval_minutes: INTERVAL_DEFAULT_MIN };

export const LANGUAGES = ['fr', 'en'];

/**
 * @returns {{ language: 'fr'|'en', intervalMinutes: number, notes: string[] }}
 * `notes` lists the values replaced (shown in the status, never the value typed).
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const notes = [];
  let language = DEFAULT_CONFIG.language;
  if (source.language !== undefined && source.language !== null && source.language !== '') {
    if (LANGUAGES.includes(source.language)) {
      language = source.language;
    } else {
      notes.push('language');
    }
  }
  let intervalMinutes = DEFAULT_CONFIG.interval_minutes;
  const typed = source.interval_minutes;
  if (typed !== undefined && typed !== null && typed !== '') {
    // Strict: '' or null is "not typed", never 0; a decimal or a text is refused.
    const value = typeof typed === 'number' ? typed : /^\d{1,4}$/.test(`${typed}`) ? +typed : NaN;
    if (Number.isInteger(value) && value >= INTERVAL_MIN_MIN && value <= INTERVAL_MAX_MIN) {
      intervalMinutes = value;
    } else if (Number.isInteger(value) && value > INTERVAL_MAX_MIN) {
      intervalMinutes = INTERVAL_MAX_MIN;
      notes.push('interval');
    } else if (Number.isInteger(value) && value >= 0) {
      intervalMinutes = INTERVAL_MIN_MIN;
      notes.push('interval');
    } else {
      notes.push('interval');
    }
  }
  return { language, intervalMinutes, notes };
}

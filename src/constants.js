// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (manifest
// keys, feature keys, the type part of the external ids) is forever: never
// rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of the package (the release bumps it): the User-Agent follows. */
export const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
/** Honest User-Agent, in the name of the integration (never a browser's). */
export const USER_AGENT = `gladys-attente-frontiere/${VERSION} (+https://github.com/LM1LC3N7/gladys-attente-frontiere)`;

// --- The sources ---------------------------------------------------------------------

/**
 * Canada Border Services Agency (CBSA / ASFC): Canada-bound wait times, one
 * CSV per language, Open Government Licence - Canada. The English file gives
 * the values, the dates and the ids; the French one only the French names.
 */
export const CBSA_EN_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv';
export const CBSA_FR_URL = 'https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-fra.csv';
/** U.S. Customs and Border Protection (CBP): U.S.-bound wait times, public domain. */
export const CBP_URL = 'https://bwt.cbp.gov/api/bwtnew';

/** The source keys (status, pauses, /data). */
export const SOURCES = { CBSA: 'cbsa', CBSA_FR: 'cbsa_fr', CBP: 'cbp' };

/** A CSV of the CBSA is ~4 KB: anything above is not it, cut before it is complete. */
export const CBSA_MAX_BYTES = 256 * 1024;
/** The CBP JSON is ~140 KB (both borders): cut beyond. */
export const CBP_MAX_BYTES = 4 * 1024 * 1024;
/** One request, from the first byte sent to the last byte read, at most. */
export const REQUEST_TIMEOUT = 20_000;
/** Rows (CBSA) or ports (CBP) read in one file, at most. */
export const MAX_ROWS = 400;
/** Crossings offered in Discovery, at most. */
export const MAX_CATALOG = 300;
/** A wait above this many minutes is not a wait (unreadable). */
export const MAX_WAIT_MINUTES = 24 * 60;

// --- Schedule ------------------------------------------------------------------------
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The interval between two reads (minutes, the form): default, bounds. */
export const INTERVAL_DEFAULT_MIN = 15;
export const INTERVAL_MIN_MIN = 10;
export const INTERVAL_MAX_MIN = 60;

/** A reading older than this is stale: never published, said in the status. */
export const MAX_AGE = 2 * HOUR;
/** A reading dated more than this in the future is unreadable. */
export const FUTURE_SLACK = 15 * MINUTE;
/** A CBP lane time later than the time of its port by more than this is of the day before. */
export const CBP_ROLLOVER_SLACK = 30 * MINUTE;
/** A server `Date` further than this from our clock is not used as the reference. */
export const DATE_HEADER_TRUST = DAY;

/** 429 / 5xx of a source: paused 5 min, doubled, between 60 s and 6 h (Retry-After honoured). */
export const PAUSE_BASE = 5 * MINUTE;
export const PAUSE_MIN = 60 * SECOND;
export const PAUSE_MAX = 6 * HOUR;

/** `getConfig()` failing at a connection: tried again after 5 s, doubled up to 5 min, without end. */
export const CONFIG_RETRY_MIN = 5 * SECOND;
export const CONFIG_RETRY_MAX = 5 * MINUTE;

/** States sent to Gladys over a rolling minute, at most (the core accepts 300). */
export const STATE_BUDGET = 250;
export const STATE_WINDOW = MINUTE;

/** A crossing no longer in its feed leaves Discovery after this long. */
export const CATALOG_KEEP = 30 * DAY;
/** Dates of the last values published kept in /data, at most. */
export const MAX_PUBLISHED = 3000;
/** A clean stop waits this long, at most, for the read running. */
export const STOP_WAIT = 3 * SECOND;
/** A status text, at most (characters). */
export const MAX_STATUS_LENGTH = 120;

// -----------------------------------------------------------------------------
// The CSV files of the Canada Border Services Agency (pure).
//
// Format seen on cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv (2026-10): UTF-8 with a
// BOM, one office per line, cells separated by ";;" (and a ";;" at the end of
// every line), a header line first. The "Last updated" cell is a local time
// with its zone abbreviation ("2026-10-29 16:15 EDT"); a wait is "No Delay",
// "<n> minutes", "Closed", "Not Applicable" or "--" (no value). Only the
// Canada-bound columns carry values (the U.S.-bound ones are "--": CBP gives
// them, src/cbp.js). Anything else is unreadable, never 0.
// -----------------------------------------------------------------------------

import { MAX_ROWS, MAX_WAIT_MINUTES } from './constants.js';

export class FormatError extends Error {
  constructor(detail) {
    super(`unexpected format: ${detail}`);
    this.name = 'FormatError';
    this.code = 'format';
  }
}

/** The zone abbreviations of the English file, as offsets from UTC in minutes. */
export const ZONES = {
  NST: -210,
  NDT: -150,
  AST: -240,
  ADT: -180,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AKST: -540,
  AKDT: -480,
};

const EN_COLUMNS = {
  office: 'customs office',
  location: 'location',
  updated: 'last updated',
  commercial: 'commercial flow - canada bound',
  travellers: 'travellers flow - canada bound',
};
/** The byte order mark the CBSA files start with. */
const BOM = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const FR_COLUMNS = { office: "bureau de l'asfc", location: 'emplacement' };

/** Lines of a CSV of the CBSA, split into trimmed cells. */
function linesOf(text) {
  if (typeof text !== 'string') throw new FormatError('not a text');
  const lines = text
    .replace(BOM, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length < 1) throw new FormatError('empty');
  if (lines.length > MAX_ROWS + 1) throw new FormatError('too many rows');
  return lines.map((line) => {
    const cells = line.split(';;').map((cell) => cell.trim());
    // Every line ends with ";;": the last cell is empty.
    if (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
    return cells;
  });
}

/** The position of each wanted column in the header, by name. */
function columnsOf(header, wanted) {
  const names = header.map((cell) => cell.toLowerCase().replace(/\s+/g, ' '));
  const at = {};
  for (const [key, name] of Object.entries(wanted)) {
    const index = names.indexOf(name);
    if (index < 0) throw new FormatError(`no column ${key}`);
    at[key] = index;
  }
  return at;
}

/** A stable id from an English office name: lowercase ASCII letters, digits and dashes. */
export function slugOf(name) {
  if (typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
}

/** "2026-10-29 16:15 EDT" -> epoch ms, else undefined. */
export function parseUpdated(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) ([A-Z]{3,4})$/.exec(text ?? '');
  if (!m) return undefined;
  const offset = ZONES[m[6]];
  if (offset === undefined) return undefined;
  const [y, mo, d, h, mi] = m.slice(1, 6).map(Number);
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(local);
  if (
    back.getUTCFullYear() !== y ||
    back.getUTCMonth() !== mo - 1 ||
    back.getUTCDate() !== d ||
    h > 23 ||
    mi > 59
  ) {
    return undefined;
  }
  return local - offset * 60_000;
}

/**
 * A wait cell of the English file.
 * @returns {{ kind: 'wait', minutes: number } | { kind: 'closed' | 'na' | 'none' | 'unreadable' }}
 */
export function parseWait(text) {
  const cell = (text ?? '').trim().replace(/\s+/g, ' ');
  if (cell === '' || cell === '--') return { kind: 'none' };
  if (/^no delay$/i.test(cell)) return { kind: 'wait', minutes: 0 };
  if (/^(temporarily )?closed$/i.test(cell)) return { kind: 'closed' };
  if (/^not applicable$/i.test(cell)) return { kind: 'na' };
  let minutes;
  let m = /^(\d{1,4}) min(ute)?s?$/i.exec(cell);
  if (m) {
    minutes = Number(m[1]);
  } else {
    m = /^(\d{1,2}) h(?:ou)?rs?(?:,? (?:and )?(\d{1,2}) min(?:ute)?s?)?$/i.exec(cell);
    if (m) minutes = Number(m[1]) * 60 + Number(m[2] ?? 0);
  }
  if (minutes !== undefined && Number.isInteger(minutes) && minutes <= MAX_WAIT_MINUTES) {
    return { kind: 'wait', minutes };
  }
  return { kind: 'unreadable' };
}

/**
 * The English file: one entry per office with a usable id.
 * @returns {{ rows: Array<{ id: string, name: string, location: string,
 *   stamp: number | undefined, updated: string, travellers: object, commercial: object }>,
 *   skipped: number }}
 */
export function parseCbsaEnglish(text) {
  const [header, ...lines] = linesOf(text);
  const at = columnsOf(header, EN_COLUMNS);
  const width = header.length;
  const rows = [];
  const seen = new Set();
  let skipped = 0;
  for (const cells of lines) {
    const id = slugOf(cells[at.office]);
    if (cells.length !== width || !id || seen.has(id)) {
      skipped += 1;
      continue;
    }
    seen.add(id);
    rows.push({
      id,
      name: cells[at.office].slice(0, 80),
      location: (cells[at.location] ?? '').slice(0, 80),
      stamp: parseUpdated(cells[at.updated]),
      updated: (cells[at.updated] ?? '').slice(0, 30),
      travellers: parseWait(cells[at.travellers]),
      commercial: parseWait(cells[at.commercial]),
    });
  }
  if (rows.length === 0) throw new FormatError('no office');
  return { rows, skipped };
}

/** The French file: the names only, in the order of the file. */
export function parseCbsaFrench(text) {
  const [header, ...lines] = linesOf(text);
  const at = columnsOf(header, FR_COLUMNS);
  return lines.map((cells) => ({
    name: (cells[at.office] ?? '').slice(0, 80),
    location: (cells[at.location] ?? '').slice(0, 80),
  }));
}

/**
 * The French name of each English row: same position and same location in
 * both files, else none (the English name is kept).
 */
export function frenchNames(englishText, french) {
  const names = new Map();
  if (!Array.isArray(french)) return names;
  let lines;
  try {
    lines = linesOf(englishText);
  } catch {
    return names;
  }
  const [header, ...rest] = lines;
  let at;
  try {
    at = columnsOf(header, EN_COLUMNS);
  } catch {
    return names;
  }
  rest.forEach((cells, index) => {
    const fr = french[index];
    const id = slugOf(cells[at.office]);
    if (id && fr && fr.name && fr.location === (cells[at.location] ?? '').slice(0, 80)) {
      if (!names.has(id)) names.set(id, fr.name);
    }
  });
  return names;
}

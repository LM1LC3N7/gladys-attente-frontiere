// -----------------------------------------------------------------------------
// The devices offered in Discovery (pure): one per crossing and direction.
//
// External ids, forever:
//   to Canada (CBSA):  ext:<selector>:to-canada:<slug of the English office name>
//   to the U.S. (CBP): ext:<selector>:to-usa:<CBP port number>
// The features are fixed per direction (a lane the crossing does not have
// simply never gets a value): waits in minutes (`duration` / `integer`, the
// core unit `minutes`) and a status text. Read-only, no poll by Gladys: the
// app reads the sources itself at its own pace.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as TY,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { FEATURE_NAMES, deviceName } from './i18n.js';

export const KINDS = { ca: 'to-canada', us: 'to-usa' };

/** The wait features of each direction, in order; `status` comes last. */
export const WAIT_KEYS = {
  ca: ['travellers', 'commercial'],
  us: ['passenger', 'nexus', 'ready', 'commercial', 'fast'],
};

const ID = { ca: /^[a-z0-9]+(-[a-z0-9]+)*$/, us: /^[A-Z0-9]{6}$/ };

/** Whether an id is valid for its direction (no `.`, `:` nor anything else). */
export const validId = (kind, id) =>
  typeof id === 'string' && id.length <= 48 && Boolean(ID[kind]?.test(id));

export const idsOf = (gladys, kind, id) => gladys.externalIds(KINDS[kind], id);

/**
 * @param {{ kind: 'ca'|'us', id: string, name: string, nameFr?: string, location?: string }} entry
 */
export function buildDevice(gladys, entry, language) {
  const ids = idsOf(gladys, entry.kind, entry.id);
  const names = FEATURE_NAMES[language] ?? FEATURE_NAMES.en;
  const features = WAIT_KEYS[entry.kind].map((key) => ({
    name: names[key],
    external_id: ids.feature(key),
    category: C.DURATION,
    type: TY.DURATION.INTEGER,
    unit: U.MINUTES,
    min: 0,
    max: 1440,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  }));
  features.push({
    name: names.status,
    external_id: ids.feature('status'),
    category: C.TEXT,
    type: TY.TEXT.TEXT,
    min: 0,
    max: 0,
    read_only: true,
    has_feedback: false,
    keep_history: false,
  });
  return {
    name: deviceName(language, entry),
    external_id: ids.device,
    should_poll: false,
    features,
  };
}

/**
 * The device external id -> { kind, id } for the devices of this integration.
 */
export function parseDeviceId(gladys, externalId) {
  for (const [kind, type] of Object.entries(KINDS)) {
    const prefix = gladys.externalId(`${type}:`);
    if (typeof externalId === 'string' && externalId.startsWith(prefix)) {
      const id = externalId.slice(prefix.length);
      return validId(kind, id) ? { kind, id } : undefined;
    }
  }
  return undefined;
}

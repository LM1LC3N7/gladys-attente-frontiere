// -----------------------------------------------------------------------------
// Runtime texts. The connection status is multi-language ({ en, fr }, Gladys
// picks); the names given in Discovery and the status texts of the devices
// are in the language of the form (`language`): one string per state.
// -----------------------------------------------------------------------------

import { MAX_STATUS_LENGTH } from './constants.js';

const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
const bound = (text) => (text.length > MAX_STATUS_LENGTH ? text.slice(0, MAX_STATUS_LENGTH) : text);

/** Feature names, by language and key. */
export const FEATURE_NAMES = {
  fr: {
    travellers: 'Attente voyageurs',
    passenger: 'Attente véhicules de tourisme',
    nexus: 'Attente NEXUS',
    ready: 'Attente Ready Lane',
    commercial: 'Attente véhicules commerciaux',
    fast: 'Attente FAST',
    status: 'État',
  },
  en: {
    travellers: 'Travellers wait',
    passenger: 'Passenger vehicles wait',
    nexus: 'NEXUS wait',
    ready: 'Ready Lane wait',
    commercial: 'Commercial vehicles wait',
    fast: 'FAST wait',
    status: 'Status',
  },
};

/** The name of a crossing in Discovery. */
export function deviceName(language, entry) {
  if (entry.kind === 'ca') {
    const name = language === 'fr' ? entry.nameFr || entry.name : entry.name;
    const where = entry.location ? ` (${entry.location})` : '';
    return (language === 'fr' ? `Vers le Canada : ${name}${where}` : `To Canada: ${name}${where}`)
      .slice(0, 120)
      .trim();
  }
  return (
    language === 'fr' ? `Vers les États-Unis : ${entry.name}` : `To the U.S.: ${entry.name}`
  ).slice(0, 120);
}

/** "2026-10-29 17:00" from naive local ms (UTC fields). */
export function localText(naive) {
  return new Date(naive).toISOString().slice(0, 16).replace('T', ' ');
}

const DEVICE_STATUS = {
  fr: {
    open: (t) => `Ouvert, relevé du ${t}`,
    closed: (t) => `Fermé, relevé du ${t}`,
    lanes_closed: (t) => `Voies fermées, relevé du ${t}`,
    pending: () => 'Mise à jour en attente à la source',
    na: () => 'Sans objet pour ce passage',
    none: () => 'Pas de mesure publiée par la source',
    stale: (t) => `Relevé périmé (plus de 2 h) : ${t}`,
    undated: () => 'Heure du relevé illisible : rien publié',
    unreadable: () => 'Valeur illisible : rien publié',
    missing: () => 'Absent du dernier fichier de la source',
    source_stale: () => 'Source muette depuis plus de 2 h : rien publié',
    waiting: () => 'En attente de la première lecture',
  },
  en: {
    open: (t) => `Open, reading of ${t}`,
    closed: (t) => `Closed, reading of ${t}`,
    lanes_closed: (t) => `Lanes closed, reading of ${t}`,
    pending: () => 'Update pending at the source',
    na: () => 'Not applicable to this crossing',
    none: () => 'No reading published by the source',
    stale: (t) => `Stale reading (over 2 h): ${t}`,
    undated: () => 'Reading time unreadable: nothing published',
    unreadable: () => 'Unreadable value: nothing published',
    missing: () => 'Missing from the last file of the source',
    source_stale: () => 'Source silent for over 2 h: nothing published',
    waiting: () => 'Waiting for the first read',
  },
};

/** The status text of a device: `code` among DEVICE_STATUS, `time` the reading time shown. */
export function deviceStatus(language, code, time = '') {
  const table = DEVICE_STATUS[language] ?? DEVICE_STATUS.en;
  return bound((table[code] ?? table.unreadable)(time));
}

/** CBP times are local times of the port, its zone not trusted. */
export const portTime = (language, naive) =>
  language === 'fr' ? `${localText(naive)}, heure du poste` : `${localText(naive)}, port time`;

const SOURCE_NAMES = {
  cbsa: { en: 'CBSA (to Canada)', fr: 'ASFC (vers le Canada)' },
  cbsa_fr: { en: 'CBSA French names', fr: 'noms français de l’ASFC' },
  cbp: { en: 'CBP (to the U.S.)', fr: 'CBP (vers les États-Unis)' },
};

/** What went wrong with one source, both languages. */
export function problemText(source, problem, now = 0) {
  const name = SOURCE_NAMES[source] ?? { en: source, fr: source };
  const left = problem.until !== undefined ? problem.until - now : 0;
  const status = problem.status ? ` ${problem.status}` : '';
  const texts = {
    network: { en: 'unreachable', fr: 'injoignable' },
    timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
    rate_limited: {
      en: `too many requests (HTTP 429), paused ${minutes(left)} min`,
      fr: `trop de requêtes (HTTP 429), pause de ${minutes(left)} min`,
    },
    server: {
      en: `server error (HTTP${status}), paused ${minutes(left)} min`,
      fr: `erreur du serveur (HTTP${status}), pause de ${minutes(left)} min`,
    },
    paused: {
      en: `paused for ${minutes(left)} more min`,
      fr: `en pause encore ${minutes(left)} min`,
    },
    http: { en: `answered HTTP${status}`, fr: `réponse HTTP${status}` },
    redirect: { en: 'redirect refused', fr: 'redirection refusée' },
    too_large: { en: 'answer too large, cut', fr: 'réponse trop grosse, coupée' },
    encoding: { en: 'text is not UTF-8', fr: 'texte illisible (pas en UTF-8)' },
    format: { en: 'unexpected format', fr: 'format inattendu' },
    stale: {
      en: 'feed frozen for over 2 h, nothing published',
      fr: 'flux figé depuis plus de 2 h, rien publié',
    },
  };
  const what = texts[problem.code] ?? { en: 'read failed', fr: 'lecture en échec' };
  return { en: `${name.en}: ${what.en}`, fr: `${name.fr} : ${what.fr}` };
}

export const T = {
  waiting: (ms) => ({
    en: `Waiting for the first read (in ${minutes(ms)} min)`,
    fr: `En attente de la première lecture (dans ${minutes(ms)} min)`,
  }),
  nextRead: (ms) => ({
    en: `Last read fine before the restart; next read in ${minutes(ms)} min`,
    fr: `Dernière lecture réussie avant le redémarrage ; prochaine lecture dans ${minutes(ms)} min`,
  }),
  configUnread: (ms) => ({
    en: `The configuration could not be read from Gladys: next try in ${seconds(ms)} s`,
    fr: `Configuration illisible depuis Gladys : nouvel essai dans ${seconds(ms)} s`,
  }),
  notes: {
    interval: {
      en: 'interval out of 10-60 min: the nearest bound or 15 min used',
      fr: 'intervalle hors 10-60 min : la borne la plus proche ou 15 min utilisée',
    },
    language: {
      en: 'unknown language: French used',
      fr: 'langue inconnue : français utilisé',
    },
  },
  dataUnreadable: {
    en: '/data could not be read: the file was set aside, values already published are not sent again before a newer reading',
    fr: '/data illisible : fichier mis de côté, les valeurs déjà publiées ne sont renvoyées qu’à un relevé plus récent',
  },
  dataUnwritable: {
    en: '/data cannot be written: the pace and the readings published are kept in memory only',
    fr: '/data non inscriptible : le rythme et les relevés publiés ne sont gardés qu’en mémoire',
  },
  budget: {
    en: 'some values wait for the next read (the module sends 250 states a minute at most, the core accepts 300)',
    fr: 'des valeurs attendent la lecture suivante (le module envoie 250 états par minute au plus, le cœur en accepte 300)',
  },
};

/** Joins status parts (each { en, fr }) into one bounded message. */
export function joinMessages(parts) {
  if (parts.length === 0) return undefined;
  const join = (lang) => parts.map((p) => p[lang]).join(lang === 'fr' ? ' ; ' : '; ');
  return { en: join('en').slice(0, 500), fr: join('fr').slice(0, 500) };
}

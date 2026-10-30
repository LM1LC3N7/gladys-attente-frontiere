// -----------------------------------------------------------------------------
// The app on the SDK's fake Gladys, scripted sources and a virtual clock: the
// pace (kept across restarts), the waits published once per reading and only
// while fresh, the statuses, the pauses, a source never blocking the other,
// getConfig retried, /data slow, failing or unreadable, the state budget.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { MAX_AGE } from '../src/constants.js';
import {
  D,
  F,
  HOUR,
  MINUTE,
  NOW,
  SECOND,
  cbpPort,
  cbsaCsv,
  cbsaTime,
  edt,
  realWorld,
  setup,
  text,
} from './helpers/app.js';
import { testClock } from './helpers/clock.js';
import { localNaive } from '../src/zones.js';

const INTERVAL = 15 * MINUTE;

/** Sources that follow the clock: a CBSA reading and a CBP port dated at the time of the request. */
function liveWorld(clock, { travellers = '5 minutes', passenger = 10, every = 15 * MINUTE } = {}) {
  // A reading every `every` (the sources update hourly or so): dated at its slot.
  const slot = () => Math.floor(clock.now() / every) * every;
  const values = { travellers, passenger };
  const world = {
    values,
    cbsa: () =>
      cbsaCsv([
        {
          office: 'Peace Bridge',
          updated: cbsaTime(slot()),
          travellers: values.travellers,
          commercial: 'No Delay',
        },
        { office: 'Rainbow Bridge', updated: cbsaTime(slot()), travellers: 'Closed' },
      ]),
    cbsaFr: () =>
      cbsaCsv([
        { office: 'Pont Peace', updated: cbsaTime(slot()) },
        { office: 'Pont Rainbow', updated: cbsaTime(slot()) },
      ])
        .replace('Customs Office', "Bureau de l'ASFC")
        .replace('Location', 'Emplacement'),
    cbp: () => [
      cbpPort({ local: edt(clock.now()), updated: edt(slot()), passenger: values.passenger }),
      cbpPort({
        local: edt(clock.now()),
        number: '070801',
        crossing: 'Thousand Islands Bridge',
        passenger: 'Lanes Closed',
      }),
    ],
  };
  return world;
}

async function live(options = {}) {
  const clock = options.clock ?? testClock({ start: NOW });
  const world = options.world ?? liveWorld(clock, options);
  const ctx = await setup({ ...options, clock, world });
  return { ...ctx, world };
}

test('first start: one read at once, the Discovery list of both sources, connected', async () => {
  const { begin, gladys, sources } = await setup();
  await begin();
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(sources.count('cbsaFr'), 1);
  assert.equal(sources.count('cbp'), 1);
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.equal(names.length, 60);
  assert.ok(names.includes('Vers le Canada : Pont Peace (Fort Erie, ON/Buffalo, NY)'));
  assert.ok(names.includes('Vers les États-Unis : Buffalo/Niagara Falls - Peace Bridge'));
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
  // One request at a time, in order: CBSA, its French names, then CBP.
  assert.deepEqual(
    sources.requests.map((r) => r.key),
    ['cbsa', 'cbsaFr', 'cbp'],
  );
  // An honest User-Agent and an explicit Accept.
  for (const r of sources.requests) {
    assert.match(
      r.headers['User-Agent'],
      /^gladys-attente-frontiere\/0\.1\.0 \(\+https:\/\/github\.com\//,
    );
    assert.ok(!/Mozilla/.test(r.headers['User-Agent']));
    assert.ok(r.headers.Accept);
  }
});

test('in English: no French file read, English names', async () => {
  const { begin, gladys, sources } = await setup({ config: { language: 'en' } });
  await begin();
  assert.equal(sources.count('cbsaFr'), 0);
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.ok(names.includes('To Canada: Peace Bridge (Fort Erie, ON/Buffalo, NY)'));
  assert.ok(names.includes('To the U.S.: Buffalo/Niagara Falls - Peace Bridge'));
});

test('the waits of the real captures: published once, the stale and the closed never', async () => {
  const { begin, create, gladys, app, statesOf } = await setup();
  await begin();
  await create('to-canada', 'peace-bridge');
  await create('to-canada', 'st-stephen');
  await create('to-canada', 'thousand-islands-bridge');
  await create('to-usa', '090101');
  await create('to-usa', '070101');
  await app.publishValues(app.run);
  const last = (fid) => gladys.fake.lastState(fid);
  assert.equal(last(F('to-canada', 'peace-bridge', 'travellers')), 0);
  assert.equal(last(F('to-canada', 'peace-bridge', 'commercial')), 4);
  assert.equal(
    last(F('to-canada', 'peace-bridge', 'status')),
    'Ouvert, relevé du 2026-10-29 16:40 EDT',
  );
  // St. Stephen: "Closed" on 2026-10-16: stale, no value.
  assert.equal(statesOf(F('to-canada', 'st-stephen', 'travellers')).length, 0);
  assert.match(
    last(F('to-canada', 'st-stephen', 'status')),
    /^Relevé périmé \(plus de 2 h\) : 2026-10-16/,
  );
  // Thousand Islands: 03:15 EDT, 14 h old: nothing.
  assert.equal(statesOf(F('to-canada', 'thousand-islands-bridge', 'travellers')).length, 0);
  assert.equal(last(F('to-usa', '090101', 'passenger')), 20);
  assert.equal(last(F('to-usa', '090101', 'nexus')), 12);
  assert.equal(statesOf(F('to-usa', '090101', 'ready')).length, 0);
  assert.equal(
    last(F('to-usa', '090101', 'status')),
    'Ouvert, relevé du 2026-10-29 16:57, heure du poste',
  );
  // Ogdensburg: 23:00 the day before: stale.
  assert.equal(statesOf(F('to-usa', '070101', 'passenger')).length, 0);
  assert.match(last(F('to-usa', '070101', 'status')), /^Relevé périmé/);
  // Every wait state is a number, every status a text.
  for (const s of gladys.fake.states) {
    if (s.device_feature_external_id.endsWith(':status')) assert.equal(typeof s.text, 'string');
    else assert.equal(typeof s.state, 'number');
  }
  // The same readings again: nothing new.
  const count = gladys.fake.states.length;
  await app.publishValues(app.run);
  assert.equal(gladys.fake.states.length, count);
});

test('pace: reads at 0, the interval and twice the interval; nothing else asks for one', async () => {
  const { begin, wait, sources, app, gladys } = await live();
  await begin();
  assert.equal(sources.count('cbsa'), 1);
  await wait(INTERVAL - 1000);
  // A save of the form, a reconnection, a scan, a device created: no read.
  await app.configUpdated({ language: 'fr' });
  await app.connected(() => gladys.getConfig());
  await app.scan();
  await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
  await wait(500);
  assert.equal(sources.count('cbsa'), 1);
  await wait(600);
  assert.equal(sources.count('cbsa'), 2);
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 3);
  assert.equal(sources.count('cbp'), 3);
  const gaps = sources.requests
    .filter((r) => r.key === 'cbsa')
    .map((r, i, all) => (i ? r.at - all[i - 1].at : 0))
    .slice(1);
  for (const gap of gaps) assert.ok(gap >= INTERVAL && gap < INTERVAL + SECOND, `${gap}`);
});

test('the interval of the form, bounded to 10-60 min, said in the status when replaced', async () => {
  const { begin, wait, sources, gladys } = await live({ config: { interval_minutes: 3 } });
  await begin();
  await wait(9 * MINUTE);
  assert.equal(sources.count('cbsa'), 1);
  await wait(MINUTE + SECOND);
  assert.equal(sources.count('cbsa'), 2);
  assert.match(gladys.fake.connectionStatus.message.fr, /intervalle hors 10-60 min/);
});

test('restart: the attempt time is in /data before the request; never sooner than the interval', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  let savedBefore;
  const first = await setup({
    store,
    clock,
    world: { ...world, cbsa: () => ((savedBefore = store.data.lastAttemptAt), world.cbsa()) },
  });
  await first.begin();
  assert.ok(Math.abs(savedBefore - NOW) < 10);
  await first.wait(5 * MINUTE);
  await first.app.stop();
  const second = await setup({ store, clock, world });
  await second.begin();
  assert.equal(second.sources.count('cbsa'), 0);
  // The last read was fine (kept in /data): shown connected, waiting for its pace.
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.match(
    second.gladys.fake.connectionStatus.message.fr,
    /Dernière lecture réussie avant le redémarrage ; prochaine lecture dans 10 min/,
  );
  await second.wait(10 * MINUTE - SECOND);
  assert.equal(second.sources.count('cbsa'), 0);
  await second.wait(2 * SECOND);
  assert.equal(second.sources.count('cbsa'), 1);
});

test('a reading is published once, across reads and restarts; a newer one is', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: HOUR });
  const a = await setup({ store, clock, world });
  await a.begin();
  await a.create('to-canada', 'peace-bridge');
  await a.create('to-usa', '090101');
  await a.wait(INTERVAL);
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  const us = F('to-usa', '090101', 'passenger');
  assert.equal(a.statesOf(fid).length, 1);
  assert.equal(a.statesOf(us).length, 1);
  await a.wait(INTERVAL);
  assert.equal(a.statesOf(fid).length, 1, 'same reading, not again');
  await a.app.stop();
  // A restart (and a Gladys that keeps its values): the same readings are not sent again.
  const devices = a.gladys.devices;
  const b = await setup({ store, clock, world, devices });
  await b.begin();
  await b.wait(INTERVAL);
  assert.equal(b.statesOf(fid).length, 0);
  assert.equal(b.statesOf(us).length, 0);
  // The next hourly reading: published, without created_at (a scene fires on it).
  await b.wait(HOUR);
  assert.equal(b.statesOf(fid).length, 1);
  assert.equal(b.statesOf(fid)[0].created_at, undefined);
  assert.equal(b.statesOf(us).length, 1);
});

test('a reading older than 2 h is never published; the status says so', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const old = NOW - MAX_AGE - MINUTE;
  world.cbsa = () =>
    cbsaCsv([{ office: 'Peace Bridge', updated: cbsaTime(old), travellers: '5 minutes' }]);
  world.cbp = () => [cbpPort({ local: edt(clock.now()), updated: edt(old), passenger: 7 })];
  const { begin, create, app, statesOf, gladys } = await live({ clock, world });
  await begin();
  await create('to-canada', 'peace-bridge');
  await create('to-usa', '090101');
  await app.publishValues(app.run);
  assert.equal(statesOf(F('to-canada', 'peace-bridge', 'travellers')).length, 0);
  assert.equal(statesOf(F('to-usa', '090101', 'passenger')).length, 0);
  assert.match(gladys.fake.lastState(F('to-canada', 'peace-bridge', 'status')), /^Relevé périmé/);
  assert.match(gladys.fake.lastState(F('to-usa', '090101', 'status')), /^Relevé périmé/);
});

test('a reading just under 2 h old is published; after a failed source it ages and stops', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const at = NOW - MAX_AGE + 20 * MINUTE;
  world.cbsa = () =>
    cbsaCsv([{ office: 'Peace Bridge', updated: cbsaTime(at), travellers: '5 minutes' }]);
  const { begin, create, wait, statesOf, gladys, app } = await live({ clock, world });
  await begin();
  await create('to-canada', 'peace-bridge');
  await app.publishValues(app.run);
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  assert.equal(statesOf(fid).length, 1);
  world.cbsa = () => new Error('down');
  await wait(2 * INTERVAL);
  assert.match(gladys.fake.lastState(F('to-canada', 'peace-bridge', 'status')), /^Relevé périmé/);
  assert.match(gladys.fake.connectionStatus.message.fr, /ASFC \(vers le Canada\) : injoignable/);
  // CBP still read: connected.
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('closed, not applicable, no value, unreadable: never a number, the status says it', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const t = cbsaTime(NOW - 10 * MINUTE);
  world.cbsa = () =>
    cbsaCsv([
      { office: 'A', updated: t, travellers: 'Closed', commercial: 'Not Applicable' },
      { office: 'B', updated: t, travellers: '--', commercial: '--' },
      { office: 'C', updated: t, travellers: 'Heavy', commercial: 'Not Applicable' },
      { office: 'D', updated: 'soon', travellers: '5 minutes' },
    ]);
  const { begin, create, app, gladys } = await live({ clock, world });
  await begin();
  for (const id of ['a', 'b', 'c', 'd']) await create('to-canada', id);
  await app.publishValues(app.run);
  const waits = gladys.fake.states.filter(
    (s) =>
      s.device_feature_external_id.startsWith(D('to-canada', '')) &&
      !s.device_feature_external_id.endsWith(':status'),
  );
  assert.deepEqual(waits, []);
  const status = (id) => gladys.fake.lastState(F('to-canada', id, 'status'));
  assert.match(status('a'), /^Fermé, relevé du/);
  assert.equal(status('b'), 'Pas de mesure publiée par la source');
  assert.equal(status('c'), 'Valeur illisible : rien publié');
  assert.equal(status('d'), 'Heure du relevé illisible : rien publié');
});

test('CBP: a closed port, closed lanes, a pending update: no number', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const local = edt(NOW);
  world.cbp = () => [
    cbpPort({ local, number: '000001', status: 'Closed', passenger: 5 }),
    cbpPort({ local, number: '000002', passenger: 'Lanes Closed', commercial: 'Lanes Closed' }),
    cbpPort({ local, number: '000003', passenger: 'Update Pending', commercial: 'Update Pending' }),
  ];
  const { begin, create, app, gladys } = await live({ clock, world });
  await begin();
  for (const id of ['000001', '000002', '000003']) await create('to-usa', id);
  await app.publishValues(app.run);
  const waits = gladys.fake.states.filter(
    (s) =>
      s.device_feature_external_id.startsWith(D('to-usa', '')) &&
      !s.device_feature_external_id.endsWith(':status'),
  );
  assert.deepEqual(waits, []);
  assert.match(gladys.fake.lastState(F('to-usa', '000001', 'status')), /^Fermé/);
  assert.match(gladys.fake.lastState(F('to-usa', '000002', 'status')), /^Voies fermées/);
  assert.equal(
    gladys.fake.lastState(F('to-usa', '000003', 'status')),
    'Mise à jour en attente à la source',
  );
});

test('a CBP feed whose time no longer moves for over 2 h is stale: nothing published', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: 10 * MINUTE });
  const frozen = edt(NOW);
  let freeze = false;
  const liveCbp = world.cbp;
  world.cbp = () =>
    freeze ? [cbpPort({ local: frozen, updated: frozen, passenger: 3 })] : liveCbp();
  const { begin, create, wait, statesOf, gladys } = await live({ clock, world });
  await begin();
  await create('to-usa', '090101');
  freeze = true;
  // Each read gives the same feed time: after 2 h it is stale (even though each lane "age" looks small).
  await wait(2 * HOUR + INTERVAL);
  const fid = F('to-usa', '090101', 'passenger');
  const before = statesOf(fid).length;
  assert.equal(
    gladys.fake.lastState(F('to-usa', '090101', 'status')),
    'Source muette depuis plus de 2 h : rien publié',
  );
  assert.match(gladys.fake.connectionStatus.message.fr, /CBP \(vers les États-Unis\) : flux figé/);
  await wait(INTERVAL);
  assert.equal(statesOf(fid).length, before);
  // The feed moves again: values come back.
  freeze = false;
  await wait(INTERVAL);
  assert.equal(gladys.fake.lastState(F('to-usa', '090101', 'status')).startsWith('Ouvert'), true);
});

test('a frozen CBP feed is remembered across a restart (its last move is in /data)', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const frozen = edt(NOW);
  world.cbp = () => [cbpPort({ local: frozen, updated: frozen, passenger: 3 })];
  const a = await live({ store, clock, world });
  await a.begin();
  await a.wait(HOUR + 50 * MINUTE);
  await a.app.stop();
  const b = await live({ store, clock, world, devices: [] });
  await b.begin();
  await b.wait(INTERVAL);
  assert.match(b.gladys.fake.connectionStatus.message.fr, /flux figé/);
});

test('429 with Retry-After pauses that source only, kept across a restart; 5xx doubles', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const good = world.cbp;
  world.cbp = () => text('slow down', { status: 429, headers: { 'retry-after': '3600' } });
  const a = await live({ store, clock, world });
  await a.begin();
  assert.equal(a.sources.count('cbp'), 1);
  assert.match(a.gladys.fake.connectionStatus.message.fr, /HTTP 429\), pause de 60 min/);
  assert.equal(a.gladys.fake.connectionStatus.connected, true, 'CBSA read');
  await a.wait(3 * INTERVAL);
  assert.equal(a.sources.count('cbp'), 1, 'paused');
  assert.equal(a.sources.count('cbsa'), 4, 'the other source goes on');
  await a.app.stop();
  world.cbp = good;
  const b = await live({ store, clock, world });
  await b.begin();
  await b.wait(INTERVAL);
  assert.equal(b.sources.count('cbp'), 0, 'the pause survives a restart');
  await b.wait(INTERVAL);
  assert.equal(b.sources.count('cbp'), 1);
  assert.equal(b.store.data.pauses.cbp, undefined);
  // 5xx: 5 min, then 10 min (doubled), bounded to 6 h.
  world.cbp = () => text('down', { status: 503 });
  await b.wait(INTERVAL);
  assert.equal(b.store.data.pauses.cbp.count, 1);
  assert.match(b.gladys.fake.connectionStatus.message.fr, /HTTP 503\), pause de 5 min/);
  await b.wait(INTERVAL);
  assert.equal(b.store.data.pauses.cbp.count, 2);
  assert.ok(b.store.data.pauses.cbp.until - clock.now() <= 10 * MINUTE + SECOND);
});

test('a pause read back from /data is capped to 6 h', async () => {
  const store = createMemoryStore({
    pauses: { cbsa: { until: NOW + 100 * HOUR, count: 3, code: 'server' } },
  });
  const { begin, wait, sources } = await live({ store });
  await begin();
  assert.equal(sources.count('cbsa'), 0);
  await wait(6 * HOUR + INTERVAL);
  assert.ok(sources.count('cbsa') >= 1);
});

test('a source that never answers: cut after 20 s, the other read, the next read on time', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbsa = () => 'hang';
  const { wait, sources, gladys, app } = await live({ clock, world });
  await app.connected(() => gladys.getConfig());
  await wait(0);
  assert.equal(sources.count('cbp'), 0);
  await wait(20 * SECOND + 100);
  await wait(SECOND);
  assert.equal(sources.count('cbp'), 1);
  assert.match(gladys.fake.connectionStatus.message.fr, /pas de réponse à temps/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 2);
});

test('a frozen /data never holds the read back nor the next one', async () => {
  const store = createMemoryStore();
  store.hold = new Promise(() => {});
  const { app, gladys, wait, sources } = await live({ store });
  await app.connected(() => gladys.getConfig());
  await wait(6 * SECOND);
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(sources.count('cbp'), 1);
  await wait(INTERVAL + 20 * SECOND);
  assert.equal(sources.count('cbsa'), 2);
});

test('/data that cannot be written: reads go on, the status says it', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const { begin, gladys, sources, wait } = await live({ store });
  await begin();
  assert.equal(sources.count('cbsa'), 1);
  assert.match(gladys.fake.connectionStatus.message.fr, /\/data non inscriptible/);
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 2);
});

test('/data unreadable: set aside, never overwritten; what is there at the first read is a baseline', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW });
  store.broken = true;
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: HOUR });
  const ctx = await live({ store, clock, world });
  await ctx.begin();
  assert.equal(store.asides, 1);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /\/data illisible/);
  // A device created after the baseline: Gladys holds nothing for it.
  await ctx.create('to-canada', 'peace-bridge');
  await ctx.app.publishValues(ctx.app.run);
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  assert.equal(ctx.statesOf(fid).length, 1);
});

test('/data unreadable with devices already created: the current readings are not sent again', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: HOUR });
  const first = await live({ clock, world });
  await first.begin();
  await first.create('to-canada', 'peace-bridge');
  await first.app.publishValues(first.app.run);
  const devices = first.gladys.devices;
  const store = createMemoryStore();
  store.broken = true;
  const ctx = await live({ store, clock, world, devices });
  await ctx.begin();
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  assert.equal(ctx.statesOf(fid).length, 0, 'baseline');
  await ctx.wait(HOUR);
  assert.equal(ctx.statesOf(fid).length, 1, 'a newer reading');
});

test('/data unreadable and impossible to set aside: never written', async () => {
  const store = createMemoryStore({ keep: 'me' });
  store.broken = true;
  store.failAside = true;
  const { begin, wait } = await live({ store });
  await begin();
  await wait(INTERVAL);
  assert.deepEqual(store.data, { keep: 'me' });
  assert.equal(store.saves, 0);
});

test('getConfig failing at a connection is tried again without end, then the reads start', async () => {
  const { app, gladys, wait, sources } = await live();
  let fails = 3;
  const getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('busy');
    }
    return gladys.getConfig();
  };
  await app.connected(getConfig);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /Configuration illisible depuis Gladys : nouvel essai dans 5 s/,
  );
  assert.equal(sources.count('cbsa'), 0);
  await wait(5 * SECOND);
  assert.match(gladys.fake.connectionStatus.message.fr, /nouvel essai dans 10 s/);
  await wait(10 * SECOND);
  await wait(20 * SECOND);
  await wait(SECOND);
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reconnection sends the Discovery and the statuses again, never the waits nor a read', async () => {
  const { begin, create, gladys, app, wait, sources, statesOf } = await live();
  await begin();
  await create('to-canada', 'peace-bridge');
  await wait(INTERVAL);
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  const status = F('to-canada', 'peace-bridge', 'status');
  const values = statesOf(fid).length;
  const statuses = statesOf(status).length;
  const reads = sources.count('cbsa');
  await app.disconnected();
  gladys.fake.discoveredDevices.length = 0;
  await app.connected(() => gladys.getConfig());
  await wait(SECOND);
  assert.equal(sources.count('cbsa'), reads);
  assert.equal(statesOf(fid).length, values);
  assert.equal(statesOf(status).length, statuses + 1);
  assert.ok(gladys.fake.discoveredDevices.length > 0);
});

test('a device created after a reading gets its waits at once, from memory (no read)', async () => {
  const { begin, gladys, wait, create, statesOf, sources } = await live({ every: 2 * HOUR });
  await begin();
  await create('to-canada', 'peace-bridge');
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  assert.equal(statesOf(fid).length, 1, 'published at the creation');
  assert.equal(sources.count('cbsa'), 1, 'no read for a creation');
  await wait(INTERVAL);
  assert.equal(statesOf(fid).length, 1, 'the same reading not again');
  // Renamed (updated): Gladys keeps its values, nothing sent again.
  const device = structuredClone(
    gladys.devices.find((d) => d.external_id === D('to-canada', 'peace-bridge')),
  );
  device.name = 'Renamed';
  await gladys.fake.deviceUpdated(device);
  await wait(INTERVAL);
  assert.equal(statesOf(fid).length, 1, 'not again after an update');
  // Deleted then created again: the same reading is sent again (Gladys lost it).
  await gladys.fake.deviceDeleted(
    gladys.devices.find((d) => d.external_id === D('to-canada', 'peace-bridge')),
  );
  await create('to-canada', 'peace-bridge');
  assert.equal(statesOf(fid).length, 2);
});

test('Gladys refusing the states: nothing marked, sent at the next read', async (t) => {
  const { begin, gladys, wait, create, statesOf } = await live({ every: HOUR });
  await begin();
  const original = gladys.publishStates.bind(gladys);
  let refuse = true;
  t.mock.method(gladys, 'publishStates', async (states) => {
    if (refuse) throw new Error('429');
    return original(states);
  });
  await create('to-canada', 'peace-bridge');
  await wait(INTERVAL);
  const fid = F('to-canada', 'peace-bridge', 'travellers');
  assert.equal(statesOf(fid).length, 0);
  refuse = false;
  await wait(INTERVAL);
  assert.equal(statesOf(fid).length, 1);
});

test('the state budget: never more than 250 states a minute, the rest at the next read', async () => {
  const { begin, gladys, create, app } = await setup();
  await begin();
  for (const device of [...gladys.fake.discoveredDevices]) {
    const kind = device.external_id.includes(':to-canada:') ? 'to-canada' : 'to-usa';
    await create(kind, device.external_id.split(':').pop());
  }
  const before = gladys.fake.states.length;
  await app.publishValues(app.run);
  await app.updateStatus();
  const sent = gladys.fake.states.length - before;
  assert.ok(sent <= 250, `${sent}`);
  // Restarts in a row within a minute: still bounded.
  for (let i = 0; i < 3; i += 1) await app.start({});
  assert.ok(gladys.fake.states.length - before <= 250);
});

test('a scan publishes the crossings known, never a read; the catalog survives a restart', async () => {
  const store = createMemoryStore();
  const a = await setup({ store });
  await a.begin();
  await a.app.stop();
  const b = await setup({ store });
  await b.app.connected(() => b.gladys.getConfig());
  await b.app.scan();
  assert.equal(b.gladys.fake.discoveredDevices.length, 60);
  // The first read of b comes at the interval after a's (no request yet).
  assert.equal(b.sources.count('cbsa'), 0);
});

test('a source answering a wrong format: no value, the other source unharmed', async () => {
  const world = realWorld();
  world.cbsa = () => '<html>maintenance</html>';
  const { begin, gladys } = await setup({ world });
  await begin();
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /ASFC \(vers le Canada\) : format inattendu/,
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.discoveredDevices.length, 30);
});

test('both sources down: not connected (the French names alone are not enough)', async () => {
  const world = {
    cbsa: () => new Error('x'),
    cbsaFr: () => realWorld().cbsaFr(),
    cbp: () => text('no', { status: 404 }),
  };
  const { begin, gladys } = await setup({ world });
  await begin();
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /ASFC \(vers le Canada\) : injoignable/);
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /CBP \(vers les États-Unis\) : réponse HTTP 404/,
  );
});

test('the French names failing never blocks: English names, values published', async () => {
  const world = realWorld();
  world.cbsaFr = () => text('x', { status: 500 });
  const { begin, gladys, create, app } = await setup({ world });
  await begin();
  assert.ok(
    gladys.fake.discoveredDevices.some((d) => d.name.startsWith('Vers le Canada : Peace Bridge')),
  );
  assert.equal(gladys.fake.connectionStatus.connected, true);
  await create('to-canada', 'peace-bridge');
  await app.publishValues(app.run);
  assert.equal(gladys.fake.lastState(F('to-canada', 'peace-bridge', 'travellers')), 0);
});

test('stop during a read: the request is cut, nothing published after', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbsa = () => 'hang';
  const { app, gladys, wait, sources } = await live({ clock, world });
  await app.connected(() => gladys.getConfig());
  await wait(10);
  const states = gladys.fake.states.length;
  await app.stop();
  await wait(INTERVAL * 2);
  assert.equal(sources.count('cbp'), 0);
  assert.equal(gladys.fake.states.length, states);
});

test('the conditional headers of the CBSA are sent back; a 304 keeps the readings', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const body = world.cbsa();
  let calls = 0;
  world.cbsa = (init) => {
    calls += 1;
    if (calls === 1)
      return text(body, {
        headers: { etag: '"abc"', 'last-modified': 'Thu, 29 Oct 2026 21:00:01 GMT' },
      });
    assert.equal(init.headers['If-None-Match'], '"abc"');
    assert.equal(init.headers['If-Modified-Since'], 'Thu, 29 Oct 2026 21:00:01 GMT');
    return new Response(null, { status: 304 });
  };
  const { begin, wait, create, gladys } = await live({ clock, world });
  await begin();
  await create('to-canada', 'peace-bridge');
  await wait(INTERVAL);
  assert.equal(calls, 2);
  assert.equal(gladys.fake.lastState(F('to-canada', 'peace-bridge', 'travellers')), 5);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a reading dated in the future (beyond 15 min) is unreadable: nothing published', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbsa = () =>
    cbsaCsv([
      { office: 'Peace Bridge', updated: cbsaTime(NOW + HOUR), travellers: '5 minutes' },
      { office: 'Rainbow Bridge', updated: cbsaTime(NOW + 10 * MINUTE), travellers: '6 minutes' },
    ]);
  const { begin, create, app, statesOf, gladys } = await live({ clock, world });
  await begin();
  await create('to-canada', 'peace-bridge');
  await create('to-canada', 'rainbow-bridge');
  await app.publishValues(app.run);
  assert.equal(statesOf(F('to-canada', 'peace-bridge', 'travellers')).length, 0);
  assert.equal(
    gladys.fake.lastState(F('to-canada', 'peace-bridge', 'status')),
    'Heure du relevé illisible : rien publié',
  );
  // Within the slack (a clock a little ahead at the agency): published.
  assert.equal(gladys.fake.lastState(F('to-canada', 'rainbow-bridge', 'travellers')), 6);
});

test('the server Date is the reference of the CBSA ages; a Date a day off is not used', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const body = () =>
    cbsaCsv([
      { office: 'Peace Bridge', updated: cbsaTime(NOW - 30 * MINUTE), travellers: '5 minutes' },
    ]);
  // Server 2 h ahead of us: the reading is 2.5 h old for the agency.
  world.cbsa = () => text(body(), { headers: { date: new Date(NOW + 2 * HOUR).toUTCString() } });
  const a = await live({ clock, world });
  await a.begin();
  await a.create('to-canada', 'peace-bridge');
  await a.app.publishValues(a.app.run);
  assert.equal(a.statesOf(F('to-canada', 'peace-bridge', 'travellers')).length, 0);
  // Server 2 days off: our clock is used, the reading is 30 min old.
  const clock2 = testClock({ start: NOW });
  const world2 = liveWorld(clock2);
  world2.cbsa = () => text(body(), { headers: { date: new Date(NOW + 48 * HOUR).toUTCString() } });
  const b = await live({ clock: clock2, world: world2 });
  await b.begin();
  await b.create('to-canada', 'peace-bridge');
  await b.app.publishValues(b.app.run);
  assert.equal(b.statesOf(F('to-canada', 'peace-bridge', 'travellers')).length, 1);
});

test('a last read dated in the future in /data never delays the reads beyond the interval', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW + 10 * HOUR });
  const { begin, wait, sources } = await live({ store });
  await begin();
  assert.equal(sources.count('cbsa'), 0);
  await wait(INTERVAL + SECOND);
  assert.equal(sources.count('cbsa'), 1);
});

test('stop aborts the request in flight', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  let aborted = false;
  world.cbsa = (init) => {
    init.signal.addEventListener('abort', () => (aborted = true));
    return 'hang';
  };
  const { app, gladys, wait } = await live({ clock, world });
  await app.connected(() => gladys.getConfig());
  await wait(10);
  await app.stop();
  assert.equal(aborted, true);
});

test('the wiring of index.js: a connection of Gladys starts the reads', async () => {
  const { createFakeGladys } = await import('@gladysassistant/integration-sdk/testing');
  const { BorderApp } = await import('../src/app.js');
  const { wire } = await import('../src/wire.js');
  const { createSources, quiet: q, URLS } = await import('./helpers/app.js');
  const clock = testClock({ start: NOW });
  const gladys = createFakeGladys({ selector: 'af', config: {} });
  const sources = createSources(clock, realWorld());
  const logger = q();
  const app = new BorderApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    fetchImpl: sources.fetch,
    urls: URLS,
  });
  wire(gladys, app, logger);
  await gladys.connect();
  await app.idle();
  await clock.advance(0);
  await app.idle();
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(gladys.fake.discoveredDevices.length, 60);
  await gladys.fake.configUpdated({ language: 'en' });
  assert.equal(sources.count('cbsa'), 1, 'a save of the form reads nothing');
  await gladys.fake.shutdown();
});

test('more fresh values than the budget: 250 at most, the rest at the next read', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: 4 * HOUR });
  const ports = Array.from({ length: 70 }, (_, i) => String(100000 + i));
  world.cbp = () =>
    ports.map((number) =>
      cbpPort({
        local: edt(clock.now()),
        updated: edt(NOW),
        number,
        passenger: 1,
        nexus: 2,
        ready: 3,
        commercial: 4,
        fast: 5,
      }),
    );
  const { begin, create, app, gladys, wait } = await live({ clock, world });
  await begin();
  const before = gladys.fake.states.length;
  // Each creation publishes from memory: all within the same minute, 250 at most.
  for (const id of ports) await create('to-usa', id);
  await app.publishValues();
  const first = gladys.fake.states.length - before;
  assert.equal(first, 250);
  await app.updateStatus();
  assert.match(
    gladys.fake.connectionStatus.message.fr,
    /des valeurs attendent la lecture suivante/,
  );
  await wait(INTERVAL);
  const waits = gladys.fake.states.filter((st) => typeof st.state === 'number');
  assert.equal(waits.length, 350, 'every value once, none twice');
  assert.equal(new Set(waits.map((st) => st.device_feature_external_id)).size, 350);
});

test('a 5xx pause never goes beyond 6 h, however many failures', async () => {
  const store = createMemoryStore({ pauses: { cbp: { until: NOW, count: 20, code: 'server' } } });
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbp = () => text('down', { status: 503 });
  const { begin } = await live({ store, clock, world });
  await begin();
  assert.equal(store.data.pauses.cbp.count, 21);
  assert.ok(store.data.pauses.cbp.until - NOW <= 6 * HOUR + SECOND);
  assert.ok(store.data.pauses.cbp.until - NOW >= 6 * HOUR - SECOND);
});

test('a late answer of a read stopped meanwhile changes nothing', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  let release;
  const body = world.cbsa();
  world.cbsa = () => new Promise((resolve) => (release = () => resolve(body)));
  const { app, gladys, wait } = await live({ clock, world });
  await app.connected(() => gladys.getConfig());
  await wait(10);
  // stop() waits 3 s at most for the read running, then writes /data.
  const stopped = app.stop();
  await wait(0);
  await wait(4 * SECOND);
  await stopped;
  release();
  await wait(SECOND);
  assert.equal(app.cbsa, undefined);
  assert.equal(app.outcome.cbsa, undefined);
});

test('a read held longer than the interval (a stuck Gladys): the reads go on after it', async (t) => {
  const { begin, gladys, wait, sources, create } = await live({ every: 10 * MINUTE });
  await begin();
  await create('to-canada', 'peace-bridge');
  let release;
  const original = gladys.publishStates.bind(gladys);
  t.mock.method(gladys, 'publishStates', async (states) => {
    if (!release) await new Promise((resolve) => (release = resolve));
    return original(states);
  });
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 2);
  await wait(INTERVAL + 5 * MINUTE);
  assert.equal(sources.count('cbsa'), 2, 'one read at a time');
  release();
  await wait(2 * MINUTE);
  await wait(INTERVAL);
  assert.ok(sources.count('cbsa') >= 3, `${sources.count('cbsa')} reads`);
});

test('a timer that fires early never brings a read sooner than the interval', async () => {
  const clock = testClock({ start: NOW });
  const early = {
    ...clock,
    advance: (ms) => clock.advance(ms),
    timers: {
      setTimeout: (fn, ms, ...args) => clock.timers.setTimeout(fn, ms / 2, ...args),
      clearTimeout: clock.timers.clearTimeout,
    },
  };
  const { begin, wait, sources } = await live({ clock: early });
  await begin();
  await wait(3 * INTERVAL + SECOND);
  const at = sources.requests.filter((r) => r.key === 'cbsa').map((r) => r.at);
  assert.equal(at.length, 4);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= INTERVAL, `${at}`);
});

// --- Review r1 -------------------------------------------------------------------------

/** Waits states sent per feature: none twice. */
const twice = (gladys) => {
  const seen = new Map();
  for (const st of gladys.fake.states) {
    if (typeof st.state !== 'number') continue;
    seen.set(st.device_feature_external_id, (seen.get(st.device_feature_external_id) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
};

/** 40 CBP ports x 5 lanes = 200 fresh values. */
function bigWorld(clock) {
  const world = liveWorld(clock, { every: 4 * HOUR });
  const ports = Array.from({ length: 40 }, (_, i) => String(100000 + i));
  world.cbp = () =>
    ports.map((number) =>
      cbpPort({
        local: edt(clock.now()),
        updated: edt(NOW),
        number,
        passenger: 1,
        nexus: 2,
        ready: 3,
        commercial: 4,
        fast: 5,
      }),
    );
  return { world, ports };
}

/** publishStates held until released: the batches in flight are visible. */
function slowGladys(t, gladys) {
  const original = gladys.publishStates.bind(gladys);
  const held = [];
  const calls = [];
  t.mock.method(gladys, 'publishStates', async (states) => {
    calls.push(states);
    await new Promise((resolve) => held.push(resolve));
    return original(states);
  });
  const release = async (wait) => {
    for (let i = 0; i < 50; i += 1) {
      while (held.length) held.shift()();
      await wait(0);
    }
  };
  return { calls, release };
}

for (const how of ['a save of the form', 'a reconnection']) {
  test(`${how} during a publication never sends a wait twice nor passes the budget`, async (t) => {
    const clock = testClock({ start: NOW });
    const { world, ports } = bigWorld(clock);
    const ctx = await live({ clock, world });
    await ctx.begin();
    for (const id of ports.slice(0, 1)) await ctx.create('to-usa', id);
    // All the devices exist; their values come at the next read.
    for (const id of ports.slice(1)) {
      const device = ctx.gladys.fake.discoveredDevices.find(
        (d) => d.external_id === D('to-usa', id),
      );
      ctx.gladys.devices.push(structuredClone(device));
    }
    const slow = slowGladys(t, ctx.gladys);
    await ctx.wait(INTERVAL);
    assert.ok(slow.calls.length >= 1, 'a batch in flight');
    if (how === 'a save of the form') {
      ctx.app.configUpdated({ language: 'fr', interval_minutes: 15 });
    } else {
      ctx.app.disconnected();
      ctx.app.connected(() => ctx.gladys.getConfig());
    }
    await slow.release(ctx.wait);
    await ctx.app.idle();
    await slow.release(ctx.wait);
    assert.equal(twice(ctx.gladys), 0);
    const sent = slow.calls.flat().length;
    assert.ok(sent <= 250, `${sent} states within the minute`);
  });
}

test('the budget window is a rolling minute: two publications 30 s apart share 250', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: 4 * HOUR });
  const ports = Array.from({ length: 50 }, (_, i) => String(100000 + i));
  world.cbp = () =>
    ports.map((number) =>
      cbpPort({
        local: edt(clock.now()),
        updated: edt(NOW),
        number,
        passenger: 1,
        nexus: 2,
        ready: 3,
        commercial: 4,
        fast: 5,
      }),
    );
  const { begin, create, gladys, wait, app } = await live({ clock, world });
  await begin();
  const start = gladys.fake.states.length;
  for (const id of ports.slice(0, 40)) await create('to-usa', id); // 40 x 6 = 240 states
  assert.equal(gladys.fake.states.length - start, 240);
  const first = gladys.fake.states.length;
  await wait(30 * SECOND);
  for (const id of ports.slice(40)) await create('to-usa', id); // 10 x 6 = 60 more: 10 allowed
  assert.equal(gladys.fake.states.length - first, 10, 'the 240 of 30 s ago still count');
  await wait(31 * SECOND);
  await app.publishValues();
  assert.equal(twice(gladys), 0);
  const waits = gladys.fake.states.filter((st) => typeof st.state === 'number');
  assert.equal(waits.length, 250, 'everything once the minute is over');
});

test('beyond the budget at every read, every feature gets its turn (fair rotation)', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: INTERVAL });
  const ports = Array.from({ length: 70 }, (_, i) => String(100000 + i));
  // A new reading of every lane at each read: 350 values, more than 250 every time.
  world.cbp = () =>
    ports.map((number) =>
      cbpPort({
        local: edt(clock.now()),
        updated: edt(Math.floor(clock.now() / INTERVAL) * INTERVAL),
        number,
        passenger: 1,
        nexus: 2,
        ready: 3,
        commercial: 4,
        fast: 5,
      }),
    );
  const { begin, gladys, wait } = await live({ clock, world });
  await begin();
  for (const id of ports) {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D('to-usa', id));
    gladys.devices.push(structuredClone(device));
  }
  await wait(3 * INTERVAL);
  const fed = new Set(
    gladys.fake.states
      .filter((st) => typeof st.state === 'number')
      .map((st) => st.device_feature_external_id),
  );
  assert.equal(fed.size, 350);
});

test('a CBP reading 119 min old at the read, created 3 min later: 122 min, not published from memory', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbp = () => [
    cbpPort({ local: edt(clock.now()), updated: edt(NOW - 119 * MINUTE), passenger: 7 }),
  ];
  world.cbsa = () =>
    cbsaCsv([
      { office: 'Peace Bridge', updated: cbsaTime(NOW - 119 * MINUTE), travellers: '5 minutes' },
    ]);
  const { begin, create, wait, statesOf, gladys } = await live({
    clock,
    world,
    config: { interval_minutes: 60 },
  });
  await begin();
  await wait(3 * MINUTE);
  await create('to-usa', '090101');
  await create('to-canada', 'peace-bridge');
  assert.equal(statesOf(F('to-usa', '090101', 'passenger')).length, 0);
  assert.equal(statesOf(F('to-canada', 'peace-bridge', 'travellers')).length, 0);
  assert.match(gladys.fake.lastState(F('to-usa', '090101', 'status')), /^Relevé périmé/);
  // A minute after the read it was still fresh: published.
  const clock2 = testClock({ start: NOW });
  const world2 = liveWorld(clock2);
  world2.cbp = () => [
    cbpPort({ local: edt(clock2.now()), updated: edt(NOW - 119 * MINUTE), passenger: 7 }),
  ];
  const b = await live({ clock: clock2, world: world2, config: { interval_minutes: 60 } });
  await b.begin();
  await b.wait(30 * SECOND);
  await b.create('to-usa', '090101');
  assert.equal(b.statesOf(F('to-usa', '090101', 'passenger')).length, 1);
});

test('fall-back (1 November): a new reading of the repeated hour is published, a stale one is not', async () => {
  const zone = 'America/Detroit';
  const start = Date.UTC(2026, 10, 1, 5, 30); // 01:30 EDT
  const clock = testClock({ start });
  const world = liveWorld(clock);
  let lane = localNaive(zone, Date.UTC(2026, 10, 1, 5, 20)); // 01:20 EDT
  world.cbp = () => [
    cbpPort({
      number: '380001',
      local: localNaive(zone, clock.now()),
      updated: lane,
      passenger: 9,
    }),
  ];
  world.cbsa = () =>
    cbsaCsv([
      {
        office: 'Ambassador Bridge',
        updated: cbsaTime(start - 10 * MINUTE),
        travellers: '4 minutes',
      },
    ]);
  const { begin, create, wait, statesOf } = await live({
    clock,
    world,
    config: { interval_minutes: 40 },
  });
  await begin();
  await create('to-usa', '380001');
  const fid = F('to-usa', '380001', 'passenger');
  assert.equal(statesOf(fid).length, 1);
  // 40 min later: 01:10 EST (06:10 UTC); a new reading "1:05 am" (06:05 UTC) looks older locally.
  lane = localNaive(zone, Date.UTC(2026, 10, 1, 6, 5));
  assert.equal(lane, Date.UTC(2026, 10, 1, 1, 5));
  await wait(40 * MINUTE);
  assert.equal(statesOf(fid).length, 2, 'the new reading of the repeated hour');
  // Two hours later the reading of 01:05 EST is not refreshed: stale at 03:06 EST.
  await wait(80 * MINUTE);
  await wait(40 * MINUTE);
  assert.equal(statesOf(fid).length, 2);
});

test('fall-back: a reading of 23:30 EDT seen at 01:00 EST is 2.5 h old: never published', async () => {
  const zone = 'America/Detroit';
  const start = Date.UTC(2026, 10, 1, 6, 0); // 01:00 EST
  const clock = testClock({ start });
  const world = liveWorld(clock);
  world.cbp = () => [
    cbpPort({
      number: '380001',
      local: localNaive(zone, clock.now()),
      updated: localNaive(zone, Date.UTC(2026, 10, 1, 3, 30)),
      passenger: 9,
    }),
  ];
  const { begin, create, statesOf, gladys } = await live({ clock, world });
  await begin();
  await create('to-usa', '380001');
  assert.equal(statesOf(F('to-usa', '380001', 'passenger')).length, 0);
  assert.match(gladys.fake.lastState(F('to-usa', '380001', 'status')), /^Relevé périmé/);
});

test('spring-forward (8 March): a reading of 01:45 EST seen at 04:30 EDT (105 min) is published', async () => {
  const zone = 'America/New_York';
  const start = Date.UTC(2026, 2, 8, 8, 30); // 04:30 EDT
  const clock = testClock({ start });
  const world = liveWorld(clock);
  world.cbp = () => [
    cbpPort({
      local: localNaive(zone, clock.now()),
      updated: localNaive(zone, Date.UTC(2026, 2, 8, 6, 45)),
      passenger: 9,
    }),
  ];
  const { begin, create, statesOf } = await live({ clock, world });
  await begin();
  await create('to-usa', '090101');
  assert.equal(statesOf(F('to-usa', '090101', 'passenger')).length, 1);
});

test('a 304 of the CBSA keeps the source read fine (no format error said)', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const body = world.cbsa();
  let calls = 0;
  world.cbsa = () => {
    calls += 1;
    return calls === 1
      ? text(body, { headers: { etag: '"a"' } })
      : new Response(null, { status: 304 });
  };
  world.cbp = () => new Error('down');
  const { begin, wait, app, gladys } = await live({ clock, world });
  await begin();
  await wait(INTERVAL);
  assert.equal(calls, 2);
  assert.deepEqual(app.outcome.cbsa, { ok: true });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.doesNotMatch(gladys.fake.connectionStatus.message.fr, /format inattendu/);
});

test('a 429 of the English CBSA file: the French one (same host) is not asked', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbsa = () => text('no', { status: 429, headers: { 'retry-after': '1800' } });
  const { begin, wait, sources } = await live({ clock, world });
  await begin();
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(sources.count('cbsaFr'), 0);
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 1, 'paused');
  assert.equal(sources.count('cbsaFr'), 0, 'paused with it');
  assert.equal(sources.count('cbp'), 2);
});

test('a read cut by a save: the sources it had not asked yet are read a minute later, the others at their interval', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const cbsa = world.cbsa;
  let hold = true;
  world.cbsa = (init) => (hold ? 'hang' : cbsa(init));
  const { app, gladys, wait, sources } = await live({ clock, world });
  await app.connected(() => gladys.getConfig());
  await wait(10);
  assert.equal(sources.count('cbsa'), 1);
  assert.equal(sources.count('cbp'), 0);
  hold = false;
  await app.configUpdated({ language: 'fr', interval_minutes: 15 });
  await wait(MINUTE + SECOND);
  assert.equal(sources.count('cbp'), 1, 'never asked: read a minute later');
  assert.equal(sources.count('cbsa'), 1, 'asked (even if cut): not again before its interval');
  assert.ok(app.cbp, 'CBP read');
  await wait(INTERVAL);
  assert.equal(sources.count('cbsa'), 2);
  assert.equal(sources.count('cbp'), 2);
  const at = (key) => sources.requests.filter((r) => r.key === key).map((r) => r.at);
  for (const key of ['cbsa', 'cbp']) {
    const [a, b] = at(key);
    assert.ok(b - a >= INTERVAL, `${key}: ${b - a}`);
  }
});

test('restart between two reads: device statuses are left as they are (no "waiting" text)', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const a = await live({ store, clock, world });
  await a.begin();
  await a.create('to-canada', 'peace-bridge');
  await a.app.stop();
  const b = await live({ store, clock, world, devices: a.gladys.devices });
  await b.begin();
  assert.equal(b.sources.count('cbsa'), 0);
  assert.equal(b.statesOf(F('to-canada', 'peace-bridge', 'status')).length, 0);
  assert.equal(b.gladys.fake.connectionStatus.connected, true);
});

test('a device without a wait feature (an older structure) never gets a state for it', async () => {
  const { begin, gladys, app } = await live();
  await begin();
  const device = structuredClone(
    gladys.fake.discoveredDevices.find((d) => d.external_id === D('to-canada', 'peace-bridge')),
  );
  device.features = device.features.filter((f) => f.external_id.endsWith(':status'));
  await gladys.fake.deviceCreated(device);
  await app.publishValues();
  const sent = gladys.fake.states.filter((st) =>
    st.device_feature_external_id.startsWith(D('to-canada', 'peace-bridge')),
  );
  assert.ok(sent.length >= 1);
  assert.ok(sent.every((st) => st.device_feature_external_id.endsWith(':status')));
});

// --- Review r2 -------------------------------------------------------------------------

test('stop() before /data was read never writes the default state over the real one', async () => {
  const store = createMemoryStore({ v: 1, lastAttemptAt: NOW - MINUTE, published: { x: 1 } });
  const { app } = await setup({ store });
  await app.stop();
  await app.disconnected();
  assert.equal(store.saves, 0);
  assert.deepEqual(store.data, { v: 1, lastAttemptAt: NOW - MINUTE, published: { x: 1 } });
});

test('a NEWER reading refused by Gladys keeps the older mark and is sent at the next publication', async (t) => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: HOUR });
  const { begin, create, gladys, wait, app, statesOf } = await live({ clock, world });
  await begin();
  await create('to-usa', '090101');
  const fid = F('to-usa', '090101', 'passenger');
  const status = F('to-usa', '090101', 'status');
  assert.equal(statesOf(fid).length, 1);
  const statuses = statesOf(status).length;
  const original = gladys.publishStates.bind(gladys);
  let refuse = true;
  t.mock.method(gladys, 'publishStates', async (states) => {
    if (refuse) throw new Error('429');
    return original(states);
  });
  // The next hourly reading (newer), refused during its read.
  await wait(HOUR);
  assert.equal(statesOf(fid).length, 1);
  const older = app.published.get(fid);
  assert.ok(older !== undefined, 'the older mark is restored, not dropped');
  refuse = false;
  await wait(2 * MINUTE);
  await app.publishValues();
  assert.equal(statesOf(fid).length, 2, 'the refused newer reading is sent again');
  assert.ok(app.published.get(fid) > older);
  // The refused status text is sent again too.
  assert.ok(statesOf(status).length > statuses);
  assert.match(statesOf(status).at(-1).text, /^Ouvert, relevé du/);
});

test('nothing is published once stopped, even a publication already queued', async () => {
  const { begin, create, gladys, app } = await live();
  await begin();
  await app.stop();
  const before = gladys.fake.states.length;
  await create('to-canada', 'peace-bridge');
  await app.publishValues();
  assert.equal(gladys.fake.states.length, before);
});

test('beyond the budget, every status text gets its turn too (fair rotation)', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: INTERVAL });
  const ports = Array.from({ length: 300 }, (_, i) => String(100000 + i));
  // No wait value (closed lanes); the status text changes at every read (its time).
  world.cbp = () =>
    ports.map((number) =>
      cbpPort({
        local: edt(clock.now()),
        number,
        passenger: 'Lanes Closed',
        commercial: 'Lanes Closed',
      }),
    );
  const { begin, gladys, wait } = await live({ clock, world });
  await begin();
  for (const id of ports) {
    const device = gladys.fake.discoveredDevices.find((d) => d.external_id === D('to-usa', id));
    gladys.devices.push(structuredClone(device));
  }
  await wait(3 * INTERVAL);
  const fed = new Set(
    gladys.fake.states
      .filter((st) => st.text !== undefined)
      .map((st) => st.device_feature_external_id),
  );
  assert.equal(fed.size, 300);
});

test('restart long after the last good read: not shown connected, waiting for the read', async () => {
  const store = createMemoryStore();
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  const a = await live({ store, clock, world });
  await a.begin();
  await a.app.stop();
  // The last read 50 min ago (interval 15): its success says nothing about now.
  store.data.lastOk = { cbsa: NOW - 50 * MINUTE, cbp: NOW - 50 * MINUTE };
  store.data.lastAttemptAt = NOW - 10 * MINUTE;
  const b = await live({ store, clock, world });
  await b.begin();
  assert.equal(b.sources.count('cbsa'), 0);
  assert.equal(b.gladys.fake.connectionStatus.connected, false);
  assert.match(b.gladys.fake.connectionStatus.message.fr, /En attente de la première lecture/);
});

test('a /data that cannot be set aside and never answers never blocks the start nor the stop', async () => {
  const never = () => new Promise(() => {});
  const store = { load: async () => ({ ok: false, code: 'EIO' }), save: never, setAside: never };
  const { app, gladys, wait, sources } = await setup({ store });
  app.connected(() => gladys.getConfig());
  await wait(0);
  await wait(6 * SECOND);
  assert.equal(sources.count('cbsa'), 1, 'started and read');
  assert.equal(app.dataBlocked, true, 'never written');
  const stopped = app.stop();
  await wait(0);
  await wait(10 * SECOND);
  await stopped;
});

for (const [name, behind] of [
  ['5 h', 5 * HOUR],
  ['3 days', 72 * HOUR],
]) {
  test(`a CBP feed ${name} behind the server Date (a cache): nothing published, said stale`, async () => {
    const clock = testClock({ start: NOW });
    const world = liveWorld(clock);
    world.cbp = () => [
      cbpPort({ local: edt(NOW - behind), updated: edt(NOW - behind - 5 * MINUTE), passenger: 7 }),
    ];
    const { begin, create, statesOf, gladys } = await live({ clock, world });
    await begin();
    await create('to-usa', '090101');
    assert.equal(statesOf(F('to-usa', '090101', 'passenger')).length, 0);
    assert.equal(
      gladys.fake.lastState(F('to-usa', '090101', 'status')),
      'Source muette depuis plus de 2 h : rien publié',
    );
    assert.match(
      gladys.fake.connectionStatus.message.fr,
      /CBP \(vers les États-Unis\) : flux figé ou en retard/,
    );
  });
}

test('one CBP port frozen for days among fresh ones: that port publishes nothing, the others do', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock);
  world.cbp = () => [
    cbpPort({ local: edt(NOW), updated: edt(NOW - 5 * MINUTE), passenger: 7 }),
    cbpPort({
      number: '070801',
      local: edt(NOW - 72 * HOUR),
      updated: edt(NOW - 72 * HOUR - 5 * MINUTE),
      passenger: 8,
    }),
  ];
  const { begin, create, statesOf, gladys } = await live({ clock, world });
  await begin();
  await create('to-usa', '090101');
  await create('to-usa', '070801');
  assert.equal(statesOf(F('to-usa', '090101', 'passenger')).length, 1);
  assert.equal(statesOf(F('to-usa', '070801', 'passenger')).length, 0);
  assert.equal(
    gladys.fake.lastState(F('to-usa', '070801', 'status')),
    'Source muette depuis plus de 2 h : rien publié',
  );
});

test('a status text refused by Gladys is sent again at the next publication', async (t) => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: HOUR });
  const { begin, create, gladys, wait, app, statesOf } = await live({ clock, world });
  await begin();
  await create('to-usa', '090101');
  const status = F('to-usa', '090101', 'status');
  const shown = statesOf(status).length;
  const original = gladys.publishStates.bind(gladys);
  let refuseTexts = true;
  t.mock.method(gladys, 'publishStates', async (states) => {
    if (refuseTexts && states.some((st) => st.text !== undefined)) throw new Error('429');
    return original(states);
  });
  // The next hourly reading: its value goes through, its new status text is refused.
  await wait(HOUR);
  assert.equal(statesOf(status).length, shown);
  refuseTexts = false;
  await wait(2 * MINUTE);
  await app.publishValues();
  assert.equal(statesOf(status).length, shown + 1);
});

test('a frozen feed of a port of unknown district (zone guessed from the Date): stale after 2 h', async () => {
  const clock = testClock({ start: NOW });
  const world = liveWorld(clock, { every: 10 * MINUTE });
  const frozen = edt(NOW);
  world.cbp = () => [cbpPort({ number: '990101', local: frozen, updated: frozen, passenger: 3 })];
  const { begin, create, wait, gladys, statesOf } = await live({ clock, world });
  await begin();
  await create('to-usa', '990101');
  assert.equal(statesOf(F('to-usa', '990101', 'passenger')).length, 1);
  await wait(2 * HOUR + INTERVAL);
  assert.equal(
    gladys.fake.lastState(F('to-usa', '990101', 'status')),
    'Source muette depuis plus de 2 h : rien publié',
  );
  assert.equal(statesOf(F('to-usa', '990101', 'passenger')).length, 1);
});

test('a /data load that fails (rejects) is unreadable, never an empty state', async () => {
  const store = createMemoryStore({ lastAttemptAt: NOW });
  store.load = async () => {
    throw new Error('EIO');
  };
  const { app, begin } = await setup({ store });
  await begin();
  assert.equal(app.dataUnreadable, true);
  assert.equal(store.asides, 1);
});

test('the zones guessed for a port of unknown district narrow as the reads go', async () => {
  const start = Date.UTC(2026, 10, 1, 6, 32); // 01:32 EST in New York, 01:32 CDT in Chicago
  const clock = testClock({ start });
  const world = liveWorld(clock);
  world.cbp = () => [
    cbpPort({ number: '990101', local: localNaive('America/New_York', clock.now()), passenger: 3 }),
  ];
  const { begin, wait, app } = await live({ clock, world });
  await begin();
  assert.deepEqual(app.guessedZones.get('990101'), ['America/New_York', 'America/Chicago']);
  await wait(HOUR); // 02:32 EST: Chicago is on CST (UTC-6) by then
  assert.deepEqual(app.guessedZones.get('990101'), ['America/New_York']);
});

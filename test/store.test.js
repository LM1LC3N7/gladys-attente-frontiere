// -----------------------------------------------------------------------------
// /data: no file is an empty state; a file that cannot be read is NOT (set
// aside under another name, never overwritten); saves go one after the other.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createFileStore } from '../src/store.js';
import { NOW, setup } from './helpers/app.js';

const dirOf = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'attente-frontiere-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('no file yet: an empty state; a save then a load give it back', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(await store.load(), { ok: true, data: {} });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(await store.load(), { ok: true, data: { a: 2 } });
});

test('a file that cannot be read is not an empty state', async (t) => {
  const dir = await dirOf(t);
  for (const [name, content] of [
    ['broken.json', '{"published":'],
    ['array.json', '[1,2]'],
    ['big.json', `{"x":"${'a'.repeat(1100 * 1024)}"}`],
  ]) {
    const file = join(dir, name);
    await writeFile(file, content);
    assert.equal((await createFileStore(file).load()).ok, false, name);
  }
  assert.equal((await createFileStore(dir).load()).ok, false, 'a directory (EISDIR)');
});

test('the app sets an unreadable /data file aside, keeps its bytes, then writes a new one', async (t) => {
  const dir = await dirOf(t);
  const file = join(dir, 'state.json');
  await writeFile(file, '{"published":{"x":');
  const { begin } = await setup({ store: createFileStore(file) });
  await begin();
  const names = await readdir(dir);
  const aside = names.find((n) => n.startsWith('state.json.unreadable-'));
  assert.ok(aside, names.join(','));
  assert.equal(await readFile(join(dir, aside), 'utf8'), '{"published":{"x":');
  const fresh = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(Math.abs(fresh.lastAttemptAt - NOW) < 1000);
});

test('what /data keeps: no personal data, bounded, validated when read back', async () => {
  const { begin, store, app } = await setup();
  await begin();
  const data = store.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'catalog',
    'cbpFeed',
    'lastAttemptAt',
    'lastOk',
    'pauses',
    'published',
    'v',
  ]);
  assert.equal(data.catalog.length, 60);
  void app;
});

test('rubbish in /data is dropped entry by entry', async () => {
  const { createMemoryStore } = await import('../src/store.js');
  const store = createMemoryStore({
    lastAttemptAt: 'yesterday',
    pauses: {
      cbsa: { until: 'x', count: 1, code: 'server' },
      cbp: { until: NOW + 1000, count: 1, code: 'evil' },
    },
    catalog: [
      { kind: 'ca', id: '../etc', name: 'x', seenAt: NOW },
      { kind: 'us', id: '090101', name: 'Peace', seenAt: NOW },
      { kind: 'xx', id: 'a', name: 'x', seenAt: NOW },
      null,
    ],
    published: { a: 1, b: 'x', ['__proto__']: 3 },
    cbpFeed: { time: 'x' },
  });
  const { app } = await setup({ store });
  await app.load();
  assert.equal(app.lastAttemptAt, undefined);
  assert.deepEqual(Object.keys(app.pauses), []);
  assert.deepEqual([...app.catalog.keys()], ['us:090101']);
  assert.deepEqual([...app.published.keys()], ['a']);
  assert.equal(app.cbpFeed, undefined);
  assert.equal({}.polluted, undefined);
});

test('a FIFO in place of /data never blocks the start: unreadable, set aside', async (t) => {
  const dir = await dirOf(t);
  const file = join(dir, 'state.json');
  execFileSync('mkfifo', [file]);
  assert.equal((await createFileStore(file).load()).ok, false);
  const { begin, sources, app } = await setup({ store: createFileStore(file) });
  await begin();
  assert.equal(app.dataUnreadable, true);
  assert.equal(sources.count('cbsa'), 1);
  assert.ok((await readdir(dir)).some((n) => n.startsWith('state.json.unreadable-')));
});

test('a /data load that never ends is bounded: unreadable after 5 s, never empty', async () => {
  const store = {
    load: () => new Promise(() => {}),
    save: async () => {},
    setAside: async () => {},
  };
  const { app, gladys, wait, sources } = await setup({ store });
  const started = app.connected(() => gladys.getConfig());
  await wait(0);
  assert.equal(app.loaded, false);
  await wait(5000);
  await started;
  await wait(0);
  assert.equal(app.loaded, true);
  assert.equal(app.dataUnreadable, true);
  assert.equal(sources.count('cbsa'), 1);
});

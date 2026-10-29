// -----------------------------------------------------------------------------
// /data: no file is an empty state; a file that cannot be read is NOT (set
// aside under another name, never overwritten); saves go one after the other.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.deepEqual(store.load(), { ok: true, data: {} });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(store.load(), { ok: true, data: { a: 2 } });
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
    assert.equal(createFileStore(file).load().ok, false, name);
  }
  assert.equal(createFileStore(dir).load().ok, false, 'a directory (EISDIR)');
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
  assert.equal(app.lastAttemptAt, undefined);
  assert.deepEqual(Object.keys(app.pauses), []);
  assert.deepEqual([...app.catalog.keys()], ['us:090101']);
  assert.deepEqual([...app.published.keys()], ['a']);
  assert.equal(app.cbpFeed, undefined);
  assert.equal({}.polluted, undefined);
});

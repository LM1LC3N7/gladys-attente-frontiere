// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout, sped
// up 100 times: the 10 minutes of the shortest interval are 6 s) and a real
// local HTTP server playing both sources: the reads really start at 0, the
// interval and twice the interval, never sooner, with a bounded number of
// timers. The real clock moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BorderApp } from '../src/app.js';
import { MINUTE } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';
import { cbpPort, cbsaCsv, cbsaTime, edt, quiet } from './helpers/app.js';

const SPEED = 100;
const INTERVAL = 10 * MINUTE;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async () => {
  const clock = realClock({ speed: SPEED });
  const reads = [];
  const server = createServer((req, res) => {
    const now = clock.now();
    if (req.url === '/cbsa') {
      reads.push(clock.monotonic());
      res.writeHead(200, { 'content-type': 'text/csv' });
      res.end(
        cbsaCsv([
          { office: 'Peace Bridge', updated: cbsaTime(now - MINUTE), travellers: '5 minutes' },
        ]),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([cbpPort({ local: edt(now) })]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gladys = createFakeGladys({
    selector: 'af',
    config: { language: 'en', interval_minutes: 10 },
  });
  await gladys.connect();
  const app = new BorderApp({
    gladys,
    logger: quiet(),
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
    urls: { cbsa: `${base}/cbsa`, cbsaFr: `${base}/fr`, cbp: `${base}/cbp` },
  });
  const spy = spyOn(app, 'read', clock);
  const started = clock.monotonic();
  try {
    await app.connected(() => gladys.getConfig());
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.ok(spy.calls[0].at - started < MINUTE, 'the first read at once');
    for (const gap of gaps) assert.ok(gap >= INTERVAL, `never sooner than the interval: ${gaps}`);
    // Seen by the server too (the request leaves just after the decision).
    for (let i = 0; i < 400 && reads.length < 3; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(reads.length, 3);
    for (let i = 1; i < reads.length; i += 1) {
      assert.ok(reads[i] - reads[i - 1] >= 0.9 * INTERVAL, `server gaps: ${reads}`);
    }
    assert.equal(gladys.fake.connectionStatus.connected, true);
  } finally {
    await app.stop();
    clock.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.ok(clock.timersSet <= 40, `${clock.timersSet} timers`);
});

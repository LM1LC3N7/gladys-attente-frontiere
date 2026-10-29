// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEFAULT_CONFIG } from '../src/config.js';
import { INTERVAL_MAX_MIN, INTERVAL_MIN_MIN, USER_AGENT, VERSION } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const wiring = read('src/wire.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};
const devices = [
  buildDevice(
    fakeGladys,
    { kind: 'ca', id: 'peace-bridge', name: 'Peace Bridge', location: 'Fort Erie, ON/Buffalo, NY' },
    'fr',
  ),
  buildDevice(
    fakeGladys,
    { kind: 'us', id: '090101', name: 'Buffalo/Niagara Falls - Peace Bridge' },
    'en',
  ),
];

test('the store basics; one semver version in 4 places (and the User-Agent), never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.ok(manifest.name.length <= 30, 'the store caps the name at 30 characters');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(
    manifest.docker_image,
    `ghcr.io/lm1lc3n7/gladys-attente-frontiere:${manifest.version}`,
  );
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(VERSION, pkg.version);
  assert.ok(
    USER_AGENT.startsWith(`gladys-attente-frontiere/${pkg.version} (+https://github.com/LM1LC3N7/`),
  );
  assert.equal(pkg.name, 'gladys-attente-frontiere');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.categories, ['transport']);
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-attente-frontiere\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say how it was tested, that the waits are estimates, and the licence of the data', () => {
  assert.match(read('docs/fr.md'), /Essayée contre les vrais fichiers de l'ASFC et du CBP/);
  assert.match(read('docs/en.md'), /Tried\s+against the real CBSA and CBP files/);
  assert.match(read('docs/fr.md'), /estimations publiées par les agences/);
  assert.match(read('docs/en.md'), /estimates published by the agencies/);
  assert.match(read('docs/fr.md'), /Licence du gouvernement ouvert –\s+Canada/);
  assert.match(read('docs/en.md'), /Open Government Licence – Canada/);
  assert.match(
    read('THIRD_PARTY_NOTICES.md'),
    /Contains information licensed under the Open Government Licence – Canada/,
  );
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
});

test('the configuration matches the code: language and interval, nothing secret', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), ['intro', 'language', 'interval_minutes']);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(manifest.config_schema.filter((f) => f.type === 'secret').length, 0);
  assert.equal(fields.language.default, DEFAULT_CONFIG.language);
  assert.deepEqual(
    fields.language.options.map((o) => o.value),
    ['fr', 'en'],
  );
  assert.equal(fields.interval_minutes.default, DEFAULT_CONFIG.interval_minutes);
  assert.equal(fields.interval_minutes.min, INTERVAL_MIN_MIN);
  assert.equal(fields.interval_minutes.max, INTERVAL_MAX_MIN);
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
  assert.ok(!('actions' in manifest), 'no button: nothing to test that the pace would allow');
});

test('the wiring: read-only, getConfig retried by the app, the lifecycle wired', () => {
  assert.match(index, /wire\(gladys, app, logger\);\n\nlogger\.info[\s\S]*gladys\.connect\(\)/);
  for (const code of [index, wiring]) {
    assert.ok(!code.includes('onSetValue'), 'no command: read-only');
    assert.ok(!code.includes('onPoll'), 'the app reads at its own pace');
  }
  const index_ = wiring;
  assert.match(index_, /\.connected\(\(\) => gladys\.getConfig\(\)\)/);
  for (const handler of [
    'onScanRequest',
    'onDeviceCreated',
    'onConfigUpdated',
    "on('disconnected'",
    'handleShutdown',
  ]) {
    assert.ok(index_.includes(handler), handler);
  }
  const strip = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const http = strip(read('src/http.js'));
  assert.match(http, /method: 'GET'/);
  assert.match(http, /redirect: 'manual'/);
  assert.ok(!/Mozilla|Chrome|Safari/.test(read('src/constants.js')), 'never a browser User-Agent');
});

test('the devices: core units only, nothing writable, no switch, no poll', () => {
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.ok(!('poll_frequency' in device));
    for (const feature of device.features) {
      assert.equal(feature.read_only, true);
      assert.notEqual(feature.category, 'switch');
      assert.notEqual(feature.type, 'binary');
      if (feature.category === 'duration') {
        assert.equal(feature.type, 'integer');
        assert.equal(feature.unit, 'minutes');
      } else {
        assert.equal(feature.category, 'text');
        assert.equal(feature.unit, undefined);
      }
      assert.ok(!/[.]|:$/.test(feature.external_id.split(':').pop()));
    }
  }
  assert.deepEqual(
    devices[0].features.map((f) => f.external_id.split(':').pop()),
    ['travellers', 'commercial', 'status'],
  );
  assert.deepEqual(
    devices[1].features.map((f) => f.external_id.split(':').pop()),
    ['passenger', 'nexus', 'ready', 'commercial', 'fast', 'status'],
  );
  assert.equal(devices[0].name, 'Vers le Canada : Peace Bridge (Fort Erie, ON/Buffalo, NY)');
  assert.equal(devices[1].name, 'To the U.S.: Buffalo/Niagara Falls - Peace Bridge');
});

test('the units are in the list of the core for their category', () => {
  const core = new URL('../../../Gladys/server/utils/constants.js', import.meta.url);
  if (!existsSync(core)) return;
  const constants = createRequire(core)(core.pathname);
  const allowed = constants.DEVICE_FEATURE_UNITS_BY_CATEGORY.duration;
  assert.ok(allowed.includes('minutes'));
});

test('supported_options of every published feature pass the rules of the core', () => {
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  let normalize;
  if (existsSync(core)) {
    try {
      normalize = createRequire(core)(core.pathname);
    } catch {
      normalize = undefined;
    }
  }
  let count = 0;
  for (const feature of devices.flatMap((d) => d.features)) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    count += 1;
    const values = options.map((o) => `${o.value}`);
    assert.equal(new Set(values).size, values.length, 'unique values');
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() !== '' && o.label === o.label.trim(), 'plain label');
      assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
    }
    if (typeof normalize === 'function') normalize(feature);
  }
  // This integration publishes no select today: the rule holds for any added later.
  assert.equal(count, 0);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
});

test('the code never feeds the energy endpoints nor scene events', () => {
  for (const file of ['index.js', 'src/wire.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});

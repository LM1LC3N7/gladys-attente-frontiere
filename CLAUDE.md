# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

It reads the **border wait times between Canada and the U.S.** from open data:
the CBSA CSV files (to Canada, Open Government Licence – Canada) and the CBP
JSON feed (to the U.S., public domain). Unofficial. **Read-only**: never
`onSetValue`, only GET requests. No neighbour module; structure taken from
`gladys-droplet` / `gladys-iskra` (app, store, clock helpers, tests).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/app.test.js              # one file
node --test --test-name-pattern "pace"    # tests whose name matches
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png, 800 x 534, plain Node
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                entry point: the SDK client, the app, src/wire.js, connect()
src/wire.js             the SDK handlers wired to the app (also used by the tests)
src/app.js              BorderApp: getConfig retries, pace, reads, freshness, publication, status, /data
src/http.js             the only network access (GET, bounded in time and size, strict UTF-8)
src/cbsa.js             the CBSA CSV files -> rows (pure)
src/cbp.js              the CBP JSON feed -> ports and lanes (pure)
src/devices.js          the devices, feature keys, external ids (pure)
src/store.js            what /data keeps across restarts (unreadable is not empty)
src/config.js           the form, normalized
src/constants.js        URLs, pacing, limits
src/i18n.js             runtime texts (en/fr)
test/helpers/app.js     the app on a fake Gladys, scripted sources and a virtual clock
test/helpers/clock.js   virtual and real clocks (copied from the test kit)
test/fixtures/          real captures of 2026-10-29
```

## Rules

- **External ids are forever**: `ext:<selector>:to-canada:<slug>` and
  `ext:<selector>:to-usa:<port number>`, feature keys `travellers`,
  `passenger`, `nexus`, `ready`, `commercial`, `fast`, `status`.
- **Never a text as a number**: only "no delay" is 0; closed, N/A, "--",
  pending, unknown texts go to the status feature only.
- **Freshness**: a reading published once (source time in /data), only while
  at most 2 h old, without `created_at`.
- **Pace**: never two reads less than the interval apart, the attempt time in
  /data before the requests; one request at a time; a source never blocks the
  other; 429/5xx pause per source.
- **Clocks**: `monotonic` for every timer, pace, pause, budget and age; the
  wall clock only for /data and a source without a usable `Date` header.
- Units: only `DEVICE_FEATURE_UNITS_BY_CATEGORY` of the core.
- **Versions belong to the Release workflow**; `test/manifest.test.js` checks
  they agree. **Changelog** under `## [Unreleased]`. **User-facing text**
  bilingual (en/fr), docs in sync with the code.
- **Style**: Prettier, ESLint; comments in English explain why; tests never
  touch the network beyond 127.0.0.1.

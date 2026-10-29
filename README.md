# gladys-attente-frontiere

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the
**wait times at the land border crossings between Canada and the United
States**, both ways, from open data: the Canada Border Services Agency (CBSA,
to Canada) and U.S. Customs and Border Protection (CBP, to the U.S.). No
account, no key. Read-only. Not affiliated with either agency.

Tried against the real CBSA and CBP feeds on 2026-10-29 (anonymous public data,
captured as test fixtures); never used yet in a real Gladys install by a
traveller. Reports are welcome.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Open points: [TODO.md](TODO.md).
- Security: [SECURITY.md](SECURITY.md).

## How it works

- One read every 10 to 60 minutes (15 by default), never more often, the time
  of the last attempt kept in /data: the English CSV of the CBSA
  (`cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv`), its French one for the names when
  the form is in French, then the CBP JSON (`bwt.cbp.gov/api/bwtnew`), one
  request at a time, bounded in time (20 s) and size, honest User-Agent,
  conditional headers for the CBSA.
- One Gladys device per crossing and direction: waits in minutes (travellers
  and commercial to Canada; passenger, NEXUS, Ready Lane, commercial and FAST
  to the U.S.) and a status text.
- A reading is published once (deduplicated on the source time, kept in
  /data), only while at most 2 hours old, without `created_at`: a scene "wait
  below X min" fires on it. "Closed", "N/A", "--" and the like are never a
  number; the status text says them.
- 429/5xx pause the source concerned only (5 min doubled, `Retry-After`, 60 s
  to 6 h, kept across restarts); a frozen CBP feed (time unchanged for over
  2 h) is stale.

## Development

```bash
npm install
npm test               # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run audit          # npm audit --omit=dev
npm run cover          # cover.png
```

Tests run against the SDK's fake Gladys, scripted sources on a virtual clock
(`test/helpers/app.js`), the real captures of `test/fixtures/` and a real local
HTTP server (`test/http.test.js`, real clock in `test/realclock.test.js`). See
[CLAUDE.md](CLAUDE.md) for the architecture and the rules.

## License

Apache-2.0 (see [LICENSE](LICENSE)). Data: see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (Open Government Licence –
Canada for the CBSA data; CBP data in the public domain).

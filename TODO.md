# TODO

## Before announcing

- [ ] Review r1 (high).
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic at publication only.

## To watch on the real feeds

- [ ] The texts of the CBSA file beyond those seen on 2026-10-29 ("No Delay",
      "<n> minutes", "Closed", "Not Applicable", "--"): "Temporarily closed"
      and "<h> hour(s) <m> minutes" are accepted by guess; anything else is
      "unreadable" (status text, nothing published). Look at
      `bwt-taf--ref.odt` of the historical dataset if a new one shows up.
- [ ] The zone abbreviations of the CBSA file: NST/NDT to PST/PDT and
      AKST/AKDT accepted; North Portal (Saskatchewan) is on CST all year
      (correct). Another one makes the row undated.
- [ ] The CBP JSON has no formal documentation (the XML feed is the documented
      one, same fields). If the JSON goes away, switch to the XML (bounded
      parse) in `src/cbp.js`.
- [ ] CBP `update_time` without a time (only "At noon"/"At midnight" handled
      besides "At h:mm am/pm").
- [ ] Whether the CBSA ever answers 304 (it ignored If-None-Match and
      If-Modified-Since on 2026-10-29; both are sent anyway).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`).
- SDK `^0.16.0` (the template's; the latest published, checked on the
  registry on 2026-10-29). No other runtime dependency.
- Manifest: `categories: ["transport"]` (traffic, §3 of the catalog spec),
  `transports: ["cloud"]`, `gladys_version: ">=5.1.0"`; no `keywords` /
  `countries` yet (to add when the core accepts them: `CA`, `US`).
- No library exists for either feed: both parsers written from the files and
  the agencies' pages. CBSA data under the Open Government Licence – Canada
  (attribution in THIRD_PARTY_NOTICES.md, docs); CBP data public domain.
- Sources: the JSON of CBP rather than its XML (same data, no XML parser to
  bound); the English CSV of the CBSA for values, dates and ids, the French
  one only for the French names (fetched only when the form is in French,
  matched on position and location, never blocking).
- Only the Canada-bound columns of the CBSA are read (its U.S.-bound columns
  are "--"); only the Canadian border of CBP.
- External ids: `to-canada:<slug of the English office name>` and
  `to-usa:<CBP port number>`. A renamed CBSA office would be a new device
  (the file has no code).
- "No Delay" / "no delay" published as 0 minutes (a wait announced as nil);
  every other text only in the status feature.
- Freshness: at most 2 hours (`MAX_AGE`), a reading published once (source
  time kept in /data), without `created_at` so that scenes fire. The CBSA
  age is counted from the server `Date` header (within a day of our clock),
  CBP's from the feed time of the port (both in UTC with the port's zone),
  plus the time since the read (monotonic). The CBP zone abbreviation is never used (typed by hand, wrong
  at times: "EST" in October at Port Huron).
- A CBP feed whose latest port time (UTC) does not move forward for over
  2 hours is stale (time and date of its last move in /data).
- Pace: interval 10 to 60 min (default 15), one read at a time, the next one
  armed before anything is awaited; /data saves awaited 5 s at most.
- 429/5xx: pause per source, 5 min doubled, `Retry-After` honoured, 60 s to
  6 h, in /data. Other failures: retried at the next read.
- /data unreadable: renamed aside (`.unreadable-<time>`), never overwritten;
  the readings present at the first read after it are taken as already
  published (a baseline), the newer ones are published. If it cannot be set
  aside, /data is never written.
- State budget: 250 states per rolling minute (the core accepts 300); the
  rest at the next read, said in the status.
- Discovery: the crossings seen in the last 30 days, kept in /data (offered
  right after a restart, before the first read).
- Real-clock test at ×20 (the project rule): two reads, one period of the
  shortest interval (10 min = 30 s), within the 60 s test timeout (three
  reads would take 90 s).
- CBP times (review r1, I2): each port gets its IANA zone from its CBP
  district (`src/zones.js`; Eastport and Porthill, Idaho, Pacific), an unknown
  district the zone matching its feed time against the `Date` header; local
  times become UTC (Intl, full ICU of the Node image), deduplicated on UTC. The
  repeated hour of November: the earlier instant, unless a reading of the same
  lane was already published at or after it (then the later): never a stale
  reading as fresh; a fresh reading of that hour, never seen before, is left
  out (once a year, said in the docs).
- Publication (review r1, I1): one at a time (queued); each batch counted in
  the budget and marked published before the request, unmarked only if
  Gladys refuses it. A device created publishes from memory at once; an
  update sends nothing again.
- A read cut by a save or a reconnection resumes a minute later for the
  sources not asked yet (review r1, m8; a source asked, even cut, waits for its
  interval, as s11 checks); each source keeps its own interval.
- After a restart, a source read fine within the interval (time in /data)
  shows the integration connected; device statuses are not replaced before the
  next read (review r1, m2).
- /data is read asynchronously, at most 1 MB, raced against 5 s (review r1,
  m5): a /data that never answers is unreadable, not empty.
- Kept as it is (review r1, m6): a restart with /data unreadable or not
  writable reads at once (documented).
- Equivalent mutants: the 60 s floor of a pause (the base is 5 min, review r1
  P2).

## Later

- The pedestrian lanes of CBP.
- The Mexican border (out of the scope of this module).

# Border wait times Canada / U.S.

Unofficial integration, not affiliated with the Canada Border Services Agency
(CBSA) nor with U.S. Customs and Border Protection (CBP). It reads the **wait
times at the land border crossings between Canada and the United States**,
both ways, from the open data of both agencies: no account, no key.

- **To Canada**: the CBSA file (`bwt-eng.csv`, and `bwt-fra.csv` for the
  French names), travellers and commercial vehicles.
- **To the U.S.**: the CBP feed (`bwt.cbp.gov`), passenger vehicles, NEXUS and
  Ready Lane lanes, commercial vehicles and FAST lanes. Only the Canadian border
  is kept.

**Read-only**: nothing is ever sent to the agencies but GET requests. Tried
against the real CBSA and CBP files on 29 October 2026; the module has not
been used yet in a real Gladys install by a traveller: tell us what you see.

The times shown are **estimates published by the agencies**, for information
only: they can change quickly and do not replace the official information.

## Setup

1. Install the integration, pick the language of the names and the read
   interval (10 to 60 minutes, 15 by default), then save.
2. The first read starts at once (or an interval after the previous one when
   the container just restarted). Open the **Discovery** tab: each crossing
   shows up at most twice, one device per direction ("To Canada: …" and
   "To the U.S.: …").
3. Create the crossings you care about.

## What you get

| Device      | Feature                  | Unit |
| ----------- | ------------------------ | ---- |
| To Canada   | Travellers wait          | min  |
| To Canada   | Commercial vehicles wait | min  |
| To the U.S. | Passenger vehicles wait  | min  |
| To the U.S. | NEXUS wait               | min  |
| To the U.S. | Ready Lane wait          | min  |
| To the U.S. | Commercial vehicles wait | min  |
| To the U.S. | FAST wait                | min  |
| Both        | Status                   | text |

A lane the crossing does not have simply never gets a value.

- "No Delay" (CBSA) and "no delay" (CBP) are **0 minutes**: a zero wait
  announced by the agency.
- "Closed", "Not Applicable", "--", "Lanes Closed", "Update Pending", "N/A"
  or an unknown text are **never published as a number**: the **Status**
  feature says it ("Closed", "Lanes closed", "Update pending at the source",
  "Not applicable to this crossing", "No reading published by the source",
  "Unreadable value: nothing published").
- The status also gives the time of the reading: the CBSA one with its zone
  (e.g. `2026-10-29 16:40 EDT`), the CBP one in the local time of the port.

## Freshness

- Each reading is published **once** (deduplicated on the time given by the
  source, kept in /data): a scene "wait below X minutes" fires on a new
  reading, not at every read.
- A reading **older than 2 hours** (age counted as below) is never published; the status becomes
  "Stale reading (over 2 h)" with its time. The age is counted from the
  server `Date` header (CBSA) or the local time of the port (CBP).
- The CBP feed gives the time of each port: when it no longer moves for over
  2 hours, nothing of it is published and the status becomes "Source silent
  for over 2 h: nothing published".
- CBP types the time zone by hand (an "EST" shows up in October): it is not
  used, the time is read as the local time of the port, the day before when it
  is later than the time of the port.
- Gladys keeps the last value published of a feature: when a wait is no longer
  known, the **Status** feature says it, not the value.

## A scene "wait below X minutes"

In a scene, pick the **Device state change** trigger, the wait feature you want
and the condition "lower than X". It fires on the first fresh reading below X.

## Pace and sources

- One read every N minutes (10 to 60), never more often: saving the form, a
  reconnection, the Discovery tab, a device created or a restart start no read
  (the time of the last attempt is written to /data before each read). The one
  exception: a restart while /data could not be read or written, which reads
  at once.
- One request at a time: the English CBSA file, the French one (only when the
  language is French, for the names), then CBP. Each request is bounded to
  20 seconds and in size (256 KB for the CBSA, 4 MB for CBP).
- The CBSA gets back the `If-None-Match` / `If-Modified-Since` headers it
  offers; CBP offers none.
- User-Agent: `gladys-attente-frontiere/<version> (+repository address)`.
- A 429 or 5xx answer pauses **that source** (5 minutes doubled at each failure,
  `Retry-After` honoured, between 60 seconds and 6 hours), kept across a
  restart. The other source is still read.
- The French names of the CBSA never block anything: without them, the English
  names are used.

## Status of the integration

"Connected" as soon as at least one of the two sources was read at its last
attempt (CBP counts only while its feed still moves); before the first read,
"Waiting for the first read (in N min)". The message says, per source, what is
wrong: unreachable, no answer in time, paused after a 429 or a 5xx, unexpected
format, frozen feed; and also an interval replaced (out of 10-60 minutes), a
/data unreadable (set aside under another name) or not writable, values put
off to the next read (Gladys accepts 300 states a minute, the module sends 250
at most).

## Data and licences

- Contains information licensed under the **Open Government Licence – Canada**
  (CBSA, dataset "Current Border Wait Times").
- The CBP data is a work of the United States government, in the public
  domain.
- No personal data is read nor kept.

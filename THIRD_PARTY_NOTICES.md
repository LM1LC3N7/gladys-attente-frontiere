# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ships no third-party code besides its npm dependencies (the Gladys integration
SDK, Apache-2.0). No library was ported: the two formats below were read from
the files themselves and the agencies' pages, and the parsers written from
scratch (`src/cbsa.js`, `src/cbp.js`).

It reads, at run time, the data below. The test fixtures in `test/fixtures/`
are copies of these files as published on 2026-10-29 (public data, nothing
personal in them; the CBP one cut to the Canadian border and one port of the
Mexican border).

## Canada Border Services Agency: Current Border Wait Times

<https://open.canada.ca/data/en/dataset/d4a716f5-a2fc-4c3c-88ed-451fe05900e4>
(`https://www.cbsa-asfc.gc.ca/bwt-taf/bwt-eng.csv` and `bwt-fra.csv`).

Contains information licensed under the Open Government Licence – Canada
(<https://open.canada.ca/en/open-government-licence-canada>).

Contient des informations visées par la Licence du gouvernement ouvert –
Canada (<https://ouvert.canada.ca/fr/licence-du-gouvernement-ouvert-canada>).

## U.S. Customs and Border Protection: Border Wait Times

<https://bwt.cbp.gov/> (`https://bwt.cbp.gov/api/bwtnew`, the JSON behind the
site; the same fields as the XML feed `https://bwt.cbp.gov/xml/bwt.xml`).

A work of the United States government, in the public domain in the United
States (17 U.S.C. § 105). CBP does not endorse this integration.

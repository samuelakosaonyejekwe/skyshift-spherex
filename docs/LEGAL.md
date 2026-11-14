# Legal notes

## Copyright and licence

- Copyright 2026 the author (named in `NOTICE`). Licensed under the **Apache License 2.0** (`LICENSE`), with a `NOTICE` file that
  every redistribution must keep. Decided by the author on 2026-11-14 to meet the Space Apps terms (below); it replaces the
  earlier "All rights reserved" notice. The author keeps the copyright, and reusers must credit the author and mark their changes.
- Name display: full name on the About page, LICENSE/NOTICE, README, CITATION.cff, the `author` field of package.json and the title slide (Space Apps asks for
  team member names on the slides); the app footer and generated dossiers show "© 2026 SkyShift · Apache-2.0".
- Third-party material keeps its own copyright and licence (see below and `NOTICE`).

## Third-party data and software

| Item | Owner / terms | How SkyShift complies |
|---|---|---|
| SPHEREx data (IRSA) | NASA/JPL/Caltech; IRSA acknowledgement and DOIs | Acknowledgement text and DOIs on the About page; release shown for every frame |
| Gaia DR3 | ESA / Gaia DPAC, via IRSA and MAST; CC BY-NC 3.0 IGO | Credit and DOI link on the About page; licence in `NOTICE` |
| CatWISE2020, AllWISE | via IRSA | Credit on the About page |
| NEOSSat data | Canadian Space Agency; CADC (NRC); Open Government Licence – Canada | Credit on the About page; listed, never mixed with SPHEREx frames |
| Aladin Lite 3.9.2-beta | CDS Strasbourg, LGPL-3.0-or-later | Vendored unmodified except the disabled usage logger (documented in `vendor/README.txt`); licence in `vendor/ALADIN-LICENSE.txt` |
| WiseView | Backyard Worlds tools | Linked only; no code copied |
| NEOSSAT_Tutorial | Canadian Space Agency, modified MIT | Read for methods; no code copied |

No logos or trademarks of NASA, SPHEREx, Space Apps, ESA, CSA, NRC/CADC or CDS are used in SkyShift's branding.

## 2026 Space Apps Terms and Conditions

Read on 2026-11-14 from the participant terms (spaceappschallenge.org/legal, updated 7 August 2026) and the Project
Submission Guide (13 November 2026), as transcribed by the author. How SkyShift meets the licensing and reuse rules:

| Term | How SkyShift meets it |
|---|---|
| Original content must be freely available or OSI open source (Apache-2.0 by default) | Apache-2.0 (`LICENSE`, `NOTICE`, `package.json`, `CITATION.cff`) |
| NASA may display, copy, combine, distribute the Solution; all posted Solutions may be downloaded and used | Compatible with Apache-2.0 |
| Non-NASA materials must be freely available or OSI-licensed, with licences documented | Aladin Lite LGPL-3.0 (OSI); data licences listed in `NOTICE` and the table above |
| Cite every source used | `docs/DATA_SOURCES.md`, About page, `NOTICE`, submission form links |
| No personal data beyond names; nothing of persons under 18; no commercial promotion | Only the author's name; no images of people; no adverts |
| Demo and slides hosted on a public site without login | GitHub repository and GitHub Pages |
| Videos: the participant's own recording, no third-party copyright | The silent 28-second video in the slides is a screen recording of SkyShift itself (no voice or music) |
| Indicate SI use (text and metadata for code; watermark only for SI-generated media) | One sentence in `README.md` and `NOTICE`; `siUse` in `package.json`; CITATION.cff abstract. No SI-generated media |

Gaia DR3 values in `data/targets.json` are distributed under ESA's CC BY-NC 3.0 IGO licence (non-commercial); ESA is a Space
Apps partner agency and Gaia is listed by the challenge itself.

## Privacy

No accounts, no analytics, no tracking. Requests go from the user's browser to the archives (directly, or via the
allow-listed relay, which forwards and keeps no logs). Saved fields, candidates, uploads and caches stay in the browser.

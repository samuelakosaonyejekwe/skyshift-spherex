# Design log

Samuel Akosa Onyejekwe directs and reviews the design. Entries marked **Proposed** are build choices awaiting his
review; when he accepts, changes or rejects one, the entry is updated with his decision and the date.

| # | Date | Decision | Status | Reason |
|---|---|---|---|---|
| 1 | 2026-11-14 | Plain JavaScript ES modules with JSDoc, no framework and no bundler, instead of TypeScript | Proposed | Smallest download (45 kB gzip first load), no build toolchain to maintain, runs unchanged from any static host. Brief section 6 recommends TypeScript; changing later is possible. |
| 2 | 2026-11-14 | Stream SPHEREx pixels from IRSA's public S3 bucket with HTTP byte ranges, decoding FITS, TAN-SIP WCS, WAVE-TAB and RICE_1 flags in the browser | Proposed | The bucket allows CORS and range requests, so no server is needed for imagery; IRSA's cutout service has no CORS and returns large ePSF tables. |
| 3 | 2026-11-14 | Search with IRSA TAP (`spherex.artifact` ⋈ `spherex.plane`, CONTAINS on `poly`) through an allow-listed relay | Proposed | TAP sees new data at ingestion (SIA lags ~1 day) and covers every release without naming them; TAP has no CORS. |
| 4 | 2026-11-14 | One relay codebase (`relay/core.mjs`) packaged for several free hosts, with a list of relays in `config.json` and automatic failover | Proposed | No single host or machine is required; a second relay is the fallback the brief asks for. |
| 5 | 2026-11-14 | Default frames = one co-add per six-month survey pass; per-detector co-adds combined with equal weight | Proposed | Matches SPHEREx's six-month cadence, maximises signal-to-noise, keeps wavelength mix comparable between epochs. |
| 6 | 2026-11-14 | Difference images are matched detector by detector (wavelength-matched) | Proposed | Brief 4.3 asks for wavelength-matched differences. |
| 7 | 2026-11-14 | Flags read only around the target by default; whole-field flag map when the flags overlay is on | Proposed | Cuts transfer by about a third while keeping photometry clean. |
| 8 | 2026-11-14 | Show the bundled or saved image list instantly, then merge the live search | Proposed | Fast first frame on slow archive responses; live data still always checked. |
| 9 | 2026-11-14 | Aladin Lite vendored (not CDN), usage logger disabled | Proposed | Offline use, no third-party tracking, CSP-friendly. |
| 10 | 2026-11-14 | Sky atlas shows HiPS cube channel 49 when Aladin requests the blank middle channel 50/51 | Proposed | Aladin's core opens cubes at the middle channel; IRSA leaves 50/51 blank by design. |
| 11 | 2026-11-14 | Ice band markers (H₂O, CO₂, CO) omitted | Proposed | Exact wavelengths not found in approved sources (rule 2). |
| 12 | 2026-11-14 | Questionable photometry = saturated core or >20% of the aperture masked | Proposed | Any-flag rule marked nearly every point; threshold keeps useful data visible and honest. |
| 13 | 2026-11-14 | Licence: All rights reserved (proprietary) instead of MIT | **Decided by Samuel** | Intellectual-property protection. |
| 14 | 2026-11-14 | Owner's name shown on the About page (and LICENSE/README/CITATION.cff) only; footer and dossiers show "© 2026 SkyShift" | **Decided by Samuel** | Space Apps does not require the name in the footer. |
| 15 | 2026-11-14 | Home map in the style of the earlier SkyShift build (equatorial Mollweide, hour grid, ecliptic, target markers, hover readout) but drawn from real SPHEREx DR1 data only | **Requested by Samuel** | Confine to the eight challenge resources. |

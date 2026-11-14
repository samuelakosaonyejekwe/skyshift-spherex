# Design log

The author directs and reviews the design. Entries marked **Proposed** are build choices awaiting the owner’s
review; when the owner accepts, changes or rejects one, the entry is updated with that decision and the date.

| # | Date | Decision | Status | Reason |
|---|---|---|---|---|
| 1 | 2026-11-14 | Plain JavaScript ES modules with JSDoc, no framework and no bundler, instead of TypeScript | Proposed | Smallest download (about 61 kB gzip first load), no build toolchain to maintain, runs unchanged from any static host. Brief section 6 recommends TypeScript; changing later is possible. |
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
| 13 | 2026-11-14 | Licence: All rights reserved (proprietary) instead of MIT (replaced by entry 22) | **Decided by the author** | Intellectual-property protection. |
| 14 | 2026-11-14 | Owner's name shown on the About page (and LICENSE/README/CITATION.cff) only; footer and dossiers show "© 2026 SkyShift" | **Decided by the author** | Space Apps does not require the name in the footer. |
| 15 | 2026-11-14 | Home map in the style of the earlier SkyShift build (equatorial Mollweide, hour grid, ecliptic, target markers, hover readout) but drawn from real SPHEREx DR1 data only | **Requested by the author** | Confine to the eight challenge resources. |
| 16 | 2026-11-14 | Publish as a public GitHub repository with Pages | **Decided by the author** | Judges can open the app and code; licence stays "All rights reserved" (licence replaced by entry 22). |
| 17 | 2026-11-14 | Gaia overlays query MAST first (resource 4), IRSA as fallback | Proposed | Uses the Gaia seed link as the primary source. |
| 18 | 2026-11-14 | Predicted positions include annual parallax; the motion fit removes each epoch's parallax shift | Proposed | Brief 4.8 (parallax) and correct motion validation for nearby stars. |
| 19 | 2026-11-14 | Default colour map tints each frame by the wavelengths it shows | Proposed | Owner found grey images unclear; grey remains selectable. |
| 20 | 2026-11-14 | On static hosts (GitHub Pages) the same-origin relay is skipped | Proposed | Avoids failing requests; external relays still used when configured. |
| 21 | 2026-11-14 | Demo video re-shot with Barnard's Star | **Decided by the author** | Its motion is clearly visible; WISE 0855 is too faint. |
| 22 | 2026-11-14 | Licence changed from All rights reserved to Apache-2.0, with a NOTICE file | **Decided by the author** | The Space Apps terms require original content to be open source (OSI); Apache-2.0 is NASA's default and keeps the author's copyright and credit. |
| 23 | 2026-11-14 | Static image index on GitHub Pages: every SPHEREx image's path, time, detector and footprint in ~2° sky tiles, rebuilt every 6 h; used when no relay is available | Proposed | IRSA TAP sends no CORS headers, so without a relay new positions could not be searched on the live site. |
| 24 | 2026-11-14 | Refreshed data and the index are carried between workflow runs in the Actions cache; nothing generated is committed | Proposed | A push no longer redeploys data older than the last scheduled refresh, and no automated commits are needed. |
| 25 | 2026-11-14 | Mission totals count spectral images (D1–D6 with a position) in one snapshot, so images = sum per day = sum per detector | Proposed | The previous per-detector query ran later and disagreed with the total by 86. |
| 26 | 2026-11-14 | Cloudflare Pages backup fed by the GitHub workflow with a scoped API token, instead of installing Cloudflare's GitHub app | **Decided by the author** | Identical build and index on a second host with its own relay; no write access for a third-party app and no automated activity on the repository. |
| 27 | 2026-11-14 | Every page and tab translated into Greek, Spanish and French: page texts in one file per language (loaded only when chosen), rules for texts with live numbers, dates and numbers in the chosen language | **Decided by the author** | The interface had only menus, buttons and headings translated; long explanations, status lines and dates stayed in English. Example commands for the describe box stay in English because the parser reads English. |
| 28 | 2026-11-14 | Full audit: annual parallax sign corrected (checked against Astropy; up to 1.1″ for Barnard's Star), validation regenerated with all exposures; data-only refreshes no longer change the app version; refreshed live and freshness data now carried between runs; a Cloudflare problem no longer blocks the GitHub Pages deploy | Proposed | Findings of a file-by-file audit of the code, data scripts, workflows and documents; each fix is covered by a test or a browser check. |

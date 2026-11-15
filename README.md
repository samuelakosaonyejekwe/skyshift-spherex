# SkyShift: A Time Machine for the SPHEREx Sky

Type a star or any coordinates, press Play, and watch NASA SPHEREx infrared images of that patch of sky play like a
little film; moving brown dwarfs, asteroids and changing stars jump out, and every object's spectrum is one click away.

Built for the 2026 NASA Space Apps Challenge "Planet X and SPHEREx" by team **SkyShift Cyprus**.

- Live app: https://samuelakosaonyejekwe.github.io/skyshift-spherex/
- Code: https://github.com/samuelakosaonyejekwe/skyshift-spherex
- Backup site (Cloudflare Pages, with its own archive relay): https://skyshift-spherex.pages.dev/ ([docs/HOSTING.md](docs/HOSTING.md))

- Local: `npm start`, then open http://localhost:8080/

On GitHub Pages, searching **any** position works through a pre-built index of every SPHEREx image
(rebuilt from IRSA every 3 hours), with pixels streamed live from IRSA's cloud bucket; so do the Explore map, Live,
Mission statistics, the Sky atlas imagery, saved fields, uploads, equations and dossiers. Services that allow no direct
browser access (Gaia and WISE overlays, Gaia ID look-ups, NEOSSat listings, Sky atlas catalogues and the live
data-freshness checks) go through the backup's relay at skyshift-spherex.pages.dev; if no relay answers, the app says so
and the images still work.

## What you can do

| Page | What it does |
|---|---|
| **Explore** | Search by name (challenge targets, Gaia DR3 IDs) or coordinates (decimal, sexagesimal, galactic). Interactive all-sky map made from real SPHEREx DR1 data with coverage glow (times observed / most recent), grid, ecliptic, galactic plane, target markers, zoom; hover shows RA/Dec and how many SPHEREx images cover the spot; click to play it. An Invert button (dark objects on a white sky, as in WiseView: black and white in every mode, true colours kept in Colour) beside the display modes for faint tails and movers. The image and the whole player (modes, Invert, zoom, ruler, exports) always fit on the screen together, on laptops and phones. Typed requests and equations; file uploads, including your own FITS image (also tile-compressed survey images such as Pan-STARRS): scale, zscale, colour maps, invert, magnifier, J2000.0/galactic/ecliptic coordinates and a pixel table; click an object for its centroid, J2000.0 and equinox-of-date coordinates, a magnitude calibrated on the Gaia DR3 stars in the image and the nearest Gaia star, export the measurements (CSV), and compare the image with SPHEREx in the Time Machine (shown or blinked). |
| **Time Machine** | Every SPHEREx image of a spot, aligned on the sky. Movie, Blink, Difference (wavelength-matched), Stack, false Colour, and your own image Equations. Detector picker (6 arrays, 102 bands), wavelength windows, line shortcuts, field of view 2′–1° with live data-cost estimate, stretch/colour maps, proper-motion tracking, Gaia/WISE overlays, contamination-flag map, spectrum and light curve on the fly, frame metadata, Discover helpers (movers, brightness changes), candidates, share/embed, PNG/video export, reproducible dossier (HTML/PDF/ZIP with FITS). |
| **Chase** | Follow fast-moving stars and brown dwarfs with Gaia DR3 motions; find fast movers near any position; follow an asteroid or comet by name (positions from NASA JPL Horizons) or along your own table of times and positions (CSV or an ephemeris service's text table). |
| **Live** | What is arriving in the SPHEREx archive now (read straight from IRSA's cloud bucket), with a quick-look "Develop" of the newest frames. |
| **Mission** | Survey statistics (images per day and per detector, sky coverage, dates) and live data-freshness checks of all eight challenge resources. |
| **Sky atlas** | Aladin Lite (CDS) on the SPHEREx all-sky HiPS from IRSA, with Gaia and CatWISE catalogues; click to play a spot. |
| **Saved** | Watchlist (offline fields, new-data alerts), candidates with provenance (CSV/JSON export), queue of uploaded fields, storage. |
| **Learn / About** | Plain-language guide, URL and embed reference, keyboard shortcuts, classroom activities, limitations, credits and data terms. |

## Judging criteria (Space Apps: Impact, Creativity, Validity, Relevance, Presentation)

| Criterion | How SkyShift meets it | Evidence |
|---|---|---|
| Impact | Free, instant SPHEREx exploration on any device; candidates export as MPC ADES; classroom-ready targets; two hosts and offline use | Live app, [docs/HOSTING.md](docs/HOSTING.md) |
| Creativity | Sky as a film; wavelength-true colours across 102 bands; user image equations; coverage-glow sky map; images decoded, aligned and measured in the visitor's browser (the relay only gathers the needed bytes and unpacks the small quality-flag window) | Time Machine, Explore |
| Validity | Real data only, from the challenge's resources plus NASA JPL Horizons for asteroid and comet positions; Astropy-level maths; motions checked against Gaia; limits stated; 51 unit tests, 25 browser checks | [docs/VALIDATION.md](docs/VALIDATION.md), `test/` |
| Relevance | Every point of the challenge statement mapped to a feature | [docs/CHALLENGE_TRACEABILITY.md](docs/CHALLENGE_TRACEABILITY.md) |
| Presentation | 7-slide deck per the Space Apps checklist (the demo), with a silent 29.5-second screen recording of the app; every page and tab in English, Greek, Spanish and French | [Presentation](https://samuelakosaonyejekwe.github.io/skyshift-spherex/presentation/) |

## Install and offline use

SkyShift is an installable web app (PWA). Use the **Install SkyShift** button (Android, Windows, macOS, Linux: one tap;
iPhone/iPad: Share → Add to Home Screen). The app shell, help and every field you have opened work in airplane mode; a
pop-up offers updates when a new version or new SPHEREx data is available.

## How it gets fresh data without anyone's computer switched on

- **Image pixels** stream from IRSA's public cloud copy of SPHEREx (AWS bucket `nasa-irsa-spherex`) straight to each
  visitor's browser using HTTP byte ranges: about 0.24 MB per image for the default 6′ field instead of a 65 MB file (measured; see docs/VALIDATION.md). Requests are
  spread across the bucket's CORS-enabled hostnames. Where a relay answers, it reads the same bytes next to the archive
  and passes them on in one request per exposure (`?gather=`, `?bundle=`; docs/HOSTING.md).
- **Image searches** use IRSA TAP live through the relay where one is available; otherwise a static index of every
  SPHEREx image (`scripts/index.mjs`, `src/lib/skyindex.js`), rebuilt every 3 hours by the scheduled workflow and kept in
  the Actions cache (never committed).
- **Pre-cut frames** for the five challenge targets and the fastest Gaia DR3 stars (`scripts/packs.mjs`,
  `src/lib/packs.js`): their 6′ field is cut from the same S3 images with the same code, rebuilt every 3 hours, one
  file per detector (its first 64 exposures in loading order). A view downloads only the detectors it shows and only
  as far as it needs, and shows frames while they arrive, so these fields open in a few seconds with any detector
  choice; only exposures the packs do not hold are then streamed from IRSA.
- **Catalogues** (IRSA TAP, MAST, CADC) do not allow direct browser calls, so they go through a tiny stateless
  allow-listed relay (`relay/core.mjs`). The same code runs on the local server, Cloudflare Pages/Workers, Netlify Edge,
  Vercel Edge and Deno Deploy; several relays can be listed in `config.json` and the app fails over between them.
- **Fallbacks**: every result is cached on the device (IndexedDB); built-in image lists for the five targets
  (`data/targets.json`), the all-sky map and mission statistics are rebuilt by scripts that can run on a schedule.
- **New releases** need no code change: searches cover every release IRSA serves; superseded releases are listed in
  `config.json` (`excludeReleases`).

## Data sources (the challenge's eight resources, plus NASA JPL Horizons)

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for the full source map, link chains, CORS behaviour and dates checked.
SPHEREx (NASA/IPAC IRSA, tutorials), WiseView, Gaia at MAST, NEOSSat (CSA), CADC, the NEOSSat tutorial and CSA open data;
NASA JPL Horizons (added by the author) for the positions of asteroids and comets followed by name.

## Validation

- Browser WCS and wavelength code matches Astropy to 4e-10″, 1e-8 px and 1e-15 µm on real files (`test/astropy.test.mjs`).
- Five-target report: [docs/VALIDATION.md](docs/VALIDATION.md).
- `npm test` runs the unit tests (FITS/Rice decoding, WCS, uploads, engine; network needed for live files).

## Limitations

Very bright stars saturate SPHEREx; photometry is quick-look aperture photometry; SPHEREx pixels (6.15″) blend neighbours;
general name resolution (names work for the five targets, Gaia DR3 IDs, and asteroids and comets through NASA JPL Horizons)
and ice-band markers are left out because no approved source provides them; WISE 0855's motion is too faint to measure reliably. Details in the Learn page and docs.

## Development

```
npm start          # build into dist/ and serve with the relay at http://localhost:8080/
npm test           # unit tests
npm run build      # build only (syntax check, size budget, attribution check)
node scripts/prebake.mjs    # refresh target image lists (data/targets.json)
node scripts/allsky.mjs     # rebuild the all-sky map from IRSA's HiPS
node scripts/mission.mjs    # rebuild coverage map and mission statistics
node scripts/index.mjs      # build the static image index (data/idx/, 12–20 min on GitHub’s runners, not committed)
node scripts/packs.mjs      # cut the frame packs (data/packs/, about 13 min for all of them on GitHub’s runners, not committed; uses the index when present)
node scripts/live.mjs       # Live page snapshot (data/live.json)
node scripts/sources.mjs    # server-side checks of the eight resources (data/sources.json)
node scripts/overlays.mjs   # built-in Gaia/CatWISE overlays for the five targets
node scripts/fastmovers.mjs # fastest-moving Gaia DR3 stars for the Chase page
node scripts/validate.mjs   # five-target validation report
```

No runtime dependencies. Aladin Lite (CDS, LGPL-3.0-or-later) is vendored in `vendor/`.

## Presentation

Watch online (slides with the silent screen recording of the app): https://samuelakosaonyejekwe.github.io/skyshift-spherex/presentation/

Slide deck as PDF (7 slides): [docs/presentation/SkyShift-slides.pdf](docs/presentation/SkyShift-slides.pdf)

Files in `docs/presentation/`: silent 29.5-second screen recording of the app (`skyshift-demo-barnard.mp4`, plays everywhere including GitHub; `skyshift-demo-barnard.webm` as an alternative), 7-slide deck (`slides.html` for the browser,
`SkyShift-slides.pdf` for submission) and the slide images.

## Copyright

Copyright 2026 Akosa Samuel Onyejekwe. Licensed under the [Apache License 2.0](LICENSE), as the NASA Space Apps terms require
for submissions; keep the [NOTICE](NOTICE) file when redistributing. Third-party data and software keep their own licences
([NOTICE](NOTICE), [docs/LEGAL.md](docs/LEGAL.md)).

SI use: Designed, directed and tested by the author, with help from SI coding tools on the code and documentation.

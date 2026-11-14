# Challenge traceability

Every sentence of the challenge statement and every requirement of the build brief, with the feature that answers it
and the test or evidence that proves it. Status: ✅ done and tested · 🟡 done, partly tested · ⏳ open.

## Challenge statement

| Challenge text | Feature | Proof | Status |
|---|---|---|---|
| SPHEREx maps the entire sky every six months in 102 bands | Six-month survey co-adds by default; 6 detector arrays × 17 channels shown everywhere (Time Machine detector picker, Learn, Mission) | Viewer grouping (`src/lib/render.js` groupExposures), Mission per-band chart | ✅ |
| Objects reveal themselves by shifting position between images | Movie, Blink, Difference modes; predicted-track overlay; Discover → Spot the movers | Browser runs on WISE 0855 / Barnard (scratchpad screenshots), `docs/VALIDATION.md` | ✅ |
| Create a public-facing web tool to display images of the sky from SPHEREx | Installable PWA, all pages | Local build, browser smoke tests | ✅ |
| Easy for anyone to quickly see how they change over time | Instant start from saved lists, autoplay, plain-language Explain panel, tour | Browser tests | ✅ |
| Asteroids and comets orbit the Sun | Ecliptic on the map; Discover movers; solar-system tracks not available from approved sources (documented) | DATA_SOURCES "left out" | 🟡 |
| Nearby stars march across the sky | Gaia proper motions, track overlay, Chase page, follow mode | VALIDATION.md (Barnard μδ within 2%) | ✅ |
| Earth's orbit changes apparent positions (distances) | Annual parallax in predicted tracks and overlays; parallax removed in the motion fit; Gaia distance in Object panel and Chase | VALIDATION.md (parallax removed, up to 0.54″ for Barnard) | ✅ |
| Pluto discovered by comparing two images | Blink mode (first vs last epoch) | Guide, viewer | ✅ |
| Volunteers discover objects this way (Backyard Worlds) | WiseView link and URL parameters; candidates, queue, random field | Saved page, upload queue E2E | ✅ |
| Sensitive to hydrogen, water, CO₂, CO and other molecules | Spectrum with hydrogen Pa α, Br α, PAH, He lines; wavelength windows; ice wavelengths not in approved sources (documented) | Spectrum tab | 🟡 |
| Objects overlap or vary in brightness | Blend warning (Gaia sources in aperture); light curve relative to mean spectrum; brightness-change candidates | RW Aur light curve, VALIDATION.md | ✅ |
| Too much data for one person | Discover helpers labelled "candidate"; queue of fields; random field | Discover tab | ✅ |
| Users enter RA and Dec | Search box (decimal, sexagesimal, galactic), URL parameters | `test/core.test.mjs` parsing | ✅ |
| Display a series of images like a little video | Time Machine Movie mode with transport and timeline | Browser tests | ✅ |
| Test on Barnard's Star, Epsilon Indi B, WISE 0855, RW Aurigae, R Draconis | Presets with Gaia DR3 astrometry, map stars, built-in image lists | `data/targets.json`, VALIDATION.md | ✅ |
| a. New data arriving fast; easy to update | Live TAP search of all releases; `config.json` release list; new-data pop-up; Live page; refresh scripts | Live page browser test | ✅ |
| b. Creative display of 102 bands; per-detector co-adds | Detector-balanced co-adds, false colour, wavelength windows, Equations (D1–D6, wl(a,b)) | Equation E2E, dossier | ✅ |
| c. Generate spectra on the fly | Spectrum tab (target or any clicked position) | RW Aur screenshot | ✅ |
| d. Add together or subtract images taken at different times | Stack, Difference (mean/first/previous), Equations epoch(k) | Browser tests | ✅ |
| e. Choose field of view; trade-off shown | FOV 2′–1° with MB and time estimate | Display tab | ✅ |
| f. Overlay Gaia and WISE | Gaia DR3 (MAST, IRSA fallback), CatWISE2020/AllWISE (IRSA), Sky atlas catalogues | Context tab | ✅ |
| g. Query by coordinates in the URL; embed | `?ra=&dec=&…`, WiseView-style params, embed=1, iframe snippet | `src/state.js`, Share dialog | ✅ |
| h. Display metadata like contamination flags | Frame & flags tab, flag map overlay, per-pixel readout | Frame tab | ✅ |
| i. Astropy and Aladin | Aladin Lite Sky atlas; Astropy reference test of browser maths | `test/astropy.test.mjs` | ✅ |
| j. Use the Resources tab | All eight resources used and checked live (Mission → Data freshness) | DATA_SOURCES.md | ✅ |

## Build brief (selected requirements; full list in the brief)

| Requirement | Feature | Proof | Status |
|---|---|---|---|
| Real data only; source and release shown | Release on every frame, "built-in/saved" labels, honest error states | Viewer status line | ✅ |
| Approved sources only | Relay allow-list = eight seeds' hosts; DATA_SOURCES | `relay/core.mjs` ALLOW | ✅ |
| Verify facts against live pages, recorded | DATA_SOURCES.md with dates and link chains | Doc | ✅ |
| Target positions from approved sources with proper motion | Gaia DR3 via IRSA/MAST, propagated per date | prebake | ✅ |
| No logos/trademarks; credits and DOIs | About page credits, DOIs | About | ✅ |
| Local first; no push until approved | Local git only | `git log` | ✅ |
| No assistant or bot attribution | Build fails on attribution text | `scripts/build.mjs` | ✅ |
| Any device, accessible | Responsive layout, screen-fit viewer, keyboard, ARIA, colour-blind palette, reduced motion, light/dark theme | Laptop/phone screenshots | 🟡 |
| SkyRequest schema for all inputs | `src/state.js`; text, equations, URL, uploads compile to it | `test/upload.test.mjs` (typed = uploaded) | ✅ |
| Uploads (common formats), safe | Worker parser with limits | `test/upload.test.mjs` | ✅ |
| Safe expression engine | `src/lib/expr.js` (no eval) | Equation E2E | ✅ |
| Dossier HTML/PDF/ZIP, unique ID | `src/lib/dossier.js` | Dossier E2E (19 files) | ✅ |
| Install, offline, update pop-up, Back/Forward | PWA shell, SW, toasts, history arrows, swipe | E2E: offline shell, update flow (new cache active after click), arrows via menu links | 🟡 (install on real devices pending) |
| Validation against catalogues and Astropy | VALIDATION.md, astropy test | Docs/tests | ✅ |
| Scheduled refresh and two hosts | GitHub Pages live; refresh every 6 h (data, image index) carried in the Actions cache; image search works there without a relay. overlays for the five targets built in; Cloudflare Pages backup live at skyshift-spherex.pages.dev with its own relay, used by the GitHub Pages copy for live overlays (docs/HOSTING.md) | GitHub Actions runs; relay test | ✅ |
| Space Apps terms checked | Apache-2.0 licence, NOTICE with third-party licences, every source cited | LEGAL.md, NOTICE | ✅ |
| Presentation deliverables (video ≤30 s, ≤7 slides) | `docs/presentation/skyshift-demo-barnard.webm` (28.5 s), `slides.html` (7 slides) | Files | ✅ |
| Interface text in one file; translations possible | `src/i18n/en.js` with Greek, Spanish and French menus and messages (`el.js`, `es.js`, `fr.js`); the menu bar switches to the compact menu when long labels do not fit | Settings → language | ✅ |

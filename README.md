# SkyShift: A Time Machine for the SPHEREx Sky

Type a star or any coordinates, press Play, and watch NASA SPHEREx infrared images of that patch of sky play like a
little film; moving brown dwarfs, asteroids and changing stars jump out, and every object's spectrum is one click away.

Built for the 2026 NASA Space Apps Challenge "Planet X and SPHEREx" by team **SkyShift Cyprus**.

- Live app (primary): https://samuelakosaonyejekwe.github.io/skyshift-spherex/ (not yet published)
- Backup mirror: Cloudflare Pages (address assigned when set up; not yet published)
- Local: `npm start`, then open http://localhost:8080/

## What you can do

| Page | What it does |
|---|---|
| **Explore** | Search by name (challenge targets, Gaia DR3 IDs) or coordinates (decimal, sexagesimal, galactic). Interactive all-sky map made from real SPHEREx DR1 data with coverage glow (times observed / most recent), grid, ecliptic, galactic plane, target markers, zoom; hover shows RA/Dec and how many SPHEREx images cover the spot; click to play it. Typed requests and equations; file uploads. |
| **Time Machine** | Every SPHEREx image of a spot, aligned on the sky. Movie, Blink, Difference (wavelength-matched), Stack, false Colour, and your own image Equations. Detector picker (6 arrays, 102 bands), wavelength windows, line shortcuts, field of view 2′–1° with live data-cost estimate, stretch/colour maps, proper-motion tracking, Gaia/WISE overlays, contamination-flag map, spectrum and light curve on the fly, frame metadata, Discover helpers (movers, brightness changes), candidates, share/embed, PNG/video export, reproducible dossier (HTML/PDF/ZIP with FITS). |
| **Chase** | Follow fast-moving stars and brown dwarfs with Gaia DR3 motions; find fast movers near any position. |
| **Live** | What is arriving in the SPHEREx archive now (read straight from IRSA's cloud bucket), with a quick-look "Develop" of the newest frames. |
| **Mission** | Survey statistics (images per day and per detector, sky coverage, dates) and live data-freshness checks of all eight challenge resources. |
| **Sky atlas** | Aladin Lite (CDS) on the SPHEREx all-sky HiPS from IRSA, with Gaia and CatWISE catalogues; click to play a spot. |
| **Saved** | Watchlist (offline fields, new-data alerts), candidates with provenance (CSV/JSON export), queue of uploaded fields, storage. |
| **Learn / About** | Plain-language guide, URL and embed reference, keyboard shortcuts, classroom activities, limitations, credits and data terms. |

## Install and offline use

SkyShift is an installable web app (PWA). Use the **Install SkyShift** button (Android, Windows, macOS, Linux: one tap;
iPhone/iPad: Share → Add to Home Screen). The app shell, help and every field you have opened work in airplane mode; a
pop-up offers updates when a new version or new SPHEREx data is available.

## How it gets fresh data without anyone's computer switched on

- **Image pixels** stream from IRSA's public cloud copy of SPHEREx (AWS bucket `nasa-irsa-spherex`) straight to each
  visitor's browser using HTTP byte ranges: about 0.06 MB per image for a 6′ field instead of a 65 MB file. Requests are
  spread across the bucket's CORS-enabled hostnames.
- **Searches and catalogues** (IRSA TAP, MAST, CADC) do not allow direct browser calls, so they go through a tiny stateless
  allow-listed relay (`relay/core.mjs`). The same code runs on the local server, Cloudflare Pages/Workers, Netlify Edge,
  Vercel Edge and Deno Deploy; several relays can be listed in `config.json` and the app fails over between them.
- **Fallbacks**: every result is cached on the device (IndexedDB); built-in image lists for the five targets
  (`data/targets.json`), the all-sky map and mission statistics are rebuilt by scripts that can run on a schedule.
- **New releases** need no code change: searches cover every release IRSA serves; superseded releases are listed in
  `config.json` (`excludeReleases`).

## Data sources (the challenge's eight resources only)

See [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) for the full source map, link chains, CORS behaviour and dates checked.
SPHEREx (NASA/IPAC IRSA, tutorials), WiseView, Gaia at MAST, NEOSSat (CSA), CADC, the NEOSSat tutorial and CSA open data.

## Validation

- Browser WCS and wavelength code matches Astropy to 4e-10″, 1e-8 px and 1e-15 µm on real files (`test/astropy.test.mjs`).
- Five-target report: [docs/VALIDATION.md](docs/VALIDATION.md).
- `npm test` runs the unit tests (FITS/Rice decoding, WCS, uploads, engine; network needed for live files).

## Limitations

Very bright stars saturate SPHEREx; photometry is quick-look aperture photometry; SPHEREx pixels (6.15″) blend neighbours;
solar-system object tracks, general name resolution and ice-band markers are left out because no approved source provides
them; WISE 0855's motion is too faint to measure reliably. Details in the Learn page and docs.

## Development

```
npm start          # build into dist/ and serve with the relay at http://localhost:8080/
npm test           # unit tests
npm run build      # build only (syntax check, size budget, attribution check)
node scripts/prebake.mjs    # refresh target image lists (data/targets.json)
node scripts/allsky.mjs     # rebuild the all-sky map from IRSA's HiPS
node scripts/mission.mjs    # rebuild coverage map and mission statistics
node scripts/validate.mjs   # five-target validation report
```

No runtime dependencies. Aladin Lite (CDS, LGPL-3.0-or-later) is vendored in `vendor/`.

## Copyright

Copyright (c) 2026 Samuel Akosa Onyejekwe. All rights reserved. See [LICENSE](LICENSE). Third-party data and software keep
their own licences and credits ([docs/LEGAL.md](docs/LEGAL.md)).

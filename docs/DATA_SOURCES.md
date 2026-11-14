# Data sources and source map

Every fact SkyShift relies on comes from the eight seed links on the challenge's Resources tab, or from pages
and services reached by following links on them. This file records what was checked, where (full URL and the
link chain back to the seed), and when. All checks below were made on **2026-11-14** unless stated otherwise.

CORS ("can a browser call it directly?") was tested by sending a request with an `Origin` header and looking
for `Access-Control-Allow-Origin` in the response.

## Summary table

| # | Seed | What SkyShift takes from it | Live service called | Format | Browser direct (CORS)? | Cadence |
|---|------|-----------------------------|---------------------|--------|------------------------|---------|
| 1 | https://irsa.ipac.caltech.edu/Missions/spherex.html | Image search, spectral images, bands, flags, releases, DOIs, all-sky HiPS, Gaia DR3 / WISE catalogues at IRSA | IRSA TAP `https://irsa.ipac.caltech.edu/TAP/sync`; S3 `https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/`; HiPS `https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube` | CSV (TAP), FITS (S3 byte ranges), PNG (HiPS) | TAP: **no** (relay). S3: **yes**, incl. `Range`. HiPS: **yes** | QR3 weekly; TAP sees new data on ingestion, SIA ~1 day later |
| 2 | https://caltech-ipac.github.io/irsa-tutorials/spherex/ | Access patterns (TAP query, cutout syntax, WCS-WAVE lookup, flag bits, ePSF, cube indexing) | GitHub API for freshness (`api.github.com/repos/Caltech-IPAC/irsa-tutorials/commits`) | HTML / JSON | Pages via relay; GitHub API **yes** | As the repository changes |
| 3 | http://byw.tools/wiseview | Blink-comparator conventions, WiseView-style URL parameters, "Open in WiseView" link | Link-out only (page probed via relay for status) | HTML | **no** (relay for status) | n/a |
| 4 | https://archive.stsci.edu/missions-and-data/gaia | Gaia DR3 positions, proper motions, parallaxes | MAST API `https://mast.stsci.edu/api/v0/invoke` (`Mast.Catalogs.GaiaDR3.Cone`), first choice; IRSA `gaia_dr3_source` as fallback | JSON | **no** (relay) | Static release (DR3) |
| 5 | https://www.asc-csa.gc.ca/eng/satellites/neossat/ | NEOSSat mission context | Page probed via relay | HTML | **no** | Page dated 2026-03-20 |
| 6 | https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/ | NEOSSat observations per field; newest NEOSSat observation | CADC TAP `https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync` (`ivoa.ObsCore`, `obs_collection='NEOSSAT'`) | CSV | **no** (relay) | As NEOSSat data arrive |
| 7 | https://github.com/asc-csa/NEOSSAT_Tutorial | How NEOSSat FITS data are organised (open-data folders by year/day-of-year); caveats | GitHub API for freshness | JSON | GitHub API **yes** | As the repository changes |
| 8 | https://data.asc-csa.gc.ca/dataset/neossat | NEOSSat open-data catalogue (title, resources, licence) | CKAN API `…/api/3/action/package_show?id=neossat` via relay | JSON | **no**; server sends a wrong intermediate certificate, so the relay adds the correct public intermediate (`relay/certs/`) for this host only | catalogue record updated 2026-06-11 |

Rate limits: none are published on the pages read. SkyShift limits itself (6 parallel image reads per user,
cached results, back-off retries) and the relay applies a per-client limit of 240 requests/minute.

## Seed 1: SPHEREx at IRSA

Pages read (link chain: seed 1 → linked page):

- https://irsa.ipac.caltech.edu/Missions/spherex.html (seed). Band list used verbatim: 0.75–1.1 µm R=39; 1.1–1.6 R=41;
  1.6–2.4 R=41; 2.4–3.8 R=35; 3.8–4.4 R=112; 4.4–5.0 R=128. Release timeline: July 2025 QR1; October 2025 QR2;
  April 10, 2026 QR2 headers updated; September 2026 QR3; November 2026 DR1. SPHEREx acknowledgement text (quoted in the
  About page). Citations: Bock et al. (2026), Akeson et al. (2026), Crill et al. (2025), Korngut et al. (2026).
- seed 1 → https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-releases and
  …/spherex-data-products and …/spherex-data-access (User Guide). SIA collections `spherex_dr1`, `spherex_dr1_deep`,
  `spherex_dr1_cube`, `spherex_qr3`, `spherex_qr3_deep`; QR2 not searchable and superseded ("DR1 and QR3 together supersede
  QR2"); file layout; IBE cutout syntax; DOIs 10.26131/IRSA678 (DR1 images), 10.26131/IRSA679 (DR1 cube), 10.26131/IRSA662 (QR3).
- seed 1 → https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_qr.html, overview_dr1.html, psfhdrerr.html.
- seed 1 → https://irsa.ipac.caltech.edu/data/SPHEREx/docs/SPHEREx_Expsupp.pdf (Explanatory Supplement, 84 pages).
  Used: science operations began 1 May 2025; He 1.083 µm atmospheric line (contaminates D1–D2); Brackett α 4.052 µm;
  aurora/airglow lines at 0.78, 0.84, 0.93, 1.13, 1.81, 2.63, 2.75, 4.03, 4.64 µm.
- seed 1 → https://irsa.ipac.caltech.edu/data/SPHEREx/SPLICES/ (ice-source list; DOI 10.26131/IRSA554). It does **not**
  give ice band wavelengths.
- seed 1 → https://irsa.ipac.caltech.edu/ibe/cutouts.html, https://irsa.ipac.caltech.edu/ibe/sia.html, https://irsa.ipac.caltech.edu/voapi.html.

Verified directly against the live services (not just docs):

- **TAP schema**: tables `spherex.artifact`, `spherex.plane`, `spherex.obscore`, `spherex.observation`,
  `spherex.provenance_input`; `spherex.plane` columns include `planeid`, `poly`, `energy_bandpassname`,
  `energy_bounds_lower/upper`, `time_bounds_lower/upper`, `datarelease`. Query used by SkyShift (pattern of the IRSA
  cutouts tutorial): `SELECT a.uri, p.time_bounds_lower, … FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
  WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), p.poly) ORDER BY p.time_bounds_lower`. Barnard's Star: 363 rows (240 DR1, 123 QR3).
  Newest exposure in the archive on 2026-11-14: MJD 61318.0014 (2026-10-05).
- **S3 bucket** `nasa-irsa-spherex` (us-east-1, public): `Access-Control-Allow-Origin: *`, methods GET/HEAD, `Range` allowed,
  206 Partial Content honoured, suffix ranges honoured. Keys mirror IBE paths: `ibe/data/spherex/<rel>` ↔ `<rel>`
  (prefixes `dr1/`, `qr2/`, `qr3/`). The cloud location is given in the SIA `cloud_access` column (IRSA docs).
- **File layout** (read byte by byte from `dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits`):
  PRIMARY (VERSION 7.0.5) → IMAGE float32 2040×2040 `MJy / sr`, TAN-SIP WCS with A/B/AP/BP order 3, alternate WCS "A"
  (0-based pixels) and "W" (`WAVE-TAB`, table in `WCS-WAVE`, columns X, Y, VALUES (2,9,9)) → FLAGS as tiled
  compressed BINTABLE, `ZCMPTYPE='RICE_1'`, `ZTILE1=2040`, `ZTILE2=1`, BLOCKSIZE 32, BYTEPIX 4 → VARIANCE → ZODI → EPSF →
  WCS-WAVE (last HDU, 720-byte row). Header keywords used: `MJD-AVG`, `DETECTOR`, `OBSID`, `OMEGA_MEDIAN` (pixel solid angle,
  arcsec²), `PSF_FWHM`, `L2DQAFLG`, quality counts `L2 N_*`.
- **Flag bits**: read from `MSKNnnnn` keywords of the FLAGS HDU (bits 0, 1, 2, 6, 7, 9–12, 14, 15, 17, 19–28). The "bad"
  subset follows the `bad_flags` list of the IRSA Source Discovery Tool tutorial.
- **HiPS** `spherex_allsky_cube`: `properties` (hips_order 5, tile width 512, cube depth 102, first frame 1, release
  2026-11-01T01:58Z), CORS `*`. Channels 50 and 51 (0-based) are blank by design (IRSA docs); frame 50 tiles return 404.

Browser maths validated against the IRSA "Introduction to SPHEREx Spectral Images" tutorial values for
`level2_2025W18_1B_0074_2D1_spx_l2b-v27-2026-196.fits` at the reference point (303.877766184, 40.5489585415):
pixel (0-based) 1019.0880638, 1020.7463735 (tutorial: 1019.0880637763953, 1020.746373505631); wavelength 0.90416686 µm,
bandwidth 0.02298403 µm (tutorial: 0.90416686, 0.02298403); pixel (1,1) wavelength 1.12616599 µm. See `test/core.test.mjs`.

## Seed 2: IRSA SPHEREx tutorials

Pages read: https://caltech-ipac.github.io/irsa-tutorials/spherex/ (seed) → spherex-intro, spherex-cutouts, spherex-psf,
spherex-source-discovery-tool-demo, spherex-mosaic, spherex-hipscube (all under https://caltech-ipac.github.io/irsa-tutorials/).
Used: TAP join query and ordering; cutout URL syntax `?center=ra,decd&size=deg`; spectral WCS `key='W'` with SIP disabled;
EPSF table structure; all-sky cube frame index `17*(band-1)+(channel-1)`; PAH 3.3 µm feature (mosaic tutorial); Pa α 1.88 µm
(cube tutorial); photometry "bad" flag list; zodi is not subtracted in the IMAGE HDU.

## Seed 3: WiseView

http://byw.tools/wiseview answers over HTTP (status 200 via the relay). Its JavaScript backend could not be read in
this environment (HTTPS refused), so SkyShift does **not** call WiseView's backend or overlay unWISE images. It
borrows conventions only (flipbook/blink, inverted greyscale, speed, size, Gaia toggle, difference, proper-motion shift),
accepts WiseView-style URL parameters, and links each field to WiseView for a WISE/NEOWISE comparison. The WISE overlay
uses the CatWISE2020 / AllWISE catalogues served by IRSA (seed 1 domain; IRSA tutorials index also lists WISE tutorials).
WiseView `pmra/pmdec` units are not documented on pages read; SkyShift reads them as mas/yr and says so on the Learn page.

## Seed 4: Gaia at MAST

https://archive.stsci.edu/missions-and-data/gaia (seed) links to Gaia DR1/DR2/EDR3/DR3 DOI pages at
https://archives.esac.esa.int/doi/html/data/astronomy/gaia/DR3.html (JavaScript page; text not readable here, linked from the
About page for the citation) and to CasJobs and MAST services. The MAST API answered `Mast.Catalogs.GaiaDR3.Cone` live
(`status: COMPLETE`; columns `source_id`, `ra`, `dec`, `pmra`, `pmdec`, `parallax`, `phot_g_mean_mag`, `ref_epoch`, …).
IRSA also hosts `gaia_dr3_source` (verified in its TAP schema); SkyShift queries MAST first (resource 4) and falls back to IRSA.

Test-target astrometry (Gaia DR3, `ref_epoch` 2016.0), fetched 2026-11-14 and propagated linearly to each date:

| Target | Gaia DR3 source_id | RA, Dec (2016.0) | pmra, pmdec (mas/yr) | parallax (mas) | G |
|---|---|---|---|---|---|
| Barnard's Star | 4472832130942575872 | 269.44850252544, 4.73942005111 | −801.551, 10362.394 | 546.9759 | 8.19 |
| ε Indi Ba/Bb | 6412596012146801152 | 331.07645259656, −56.79381206688 | 3981.977, −2466.832 | 270.6580 | 18.03 |
| ε Indi A (host) | 6412595290592307840 | 330.87240787960, −56.79725466123 | 3966.661, −2536.192 | 274.8431 | 4.32 |
| RW Aurigae | 156430822114424576 | 76.95608119553, 30.40120458910 | 2.641, −27.398 | 6.4062 | 12.18 |
| R Draconis | 1648328016354496384 | 248.16737836729, 66.75500674547 | −20.643, 6.149 | 1.2509 | 6.37 |

WISE 0855−0714 is not in Gaia. Its position comes from the challenge (08h55m10.831s, −07°14′42.53″) and from the WiseView
example link (133.786245, −7.244372), which SkyShift uses as the field centre.

## Seeds 5–8: NEOSSat and CADC

- https://www.asc-csa.gc.ca/eng/satellites/neossat/ (date modified 2026-03-20): launch 25 February 2013, active; "world's first
  space telescope dedicated to detecting and tracking asteroids, comets, satellites and space debris"; data released under
  Canada's Directive on Open Government; the CSA open-data catalogue (seed 8) licenses the dataset under the Open
  Government Licence – Canada.
- https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/ → /en/neossat/ (15-cm Maksutov, 3″/pixel, 0.85° field; collection `NEOSSAT`) and
  /en/services/ (TAP `argus`, `caom2ops`, SIA, data). Verified live: `ivoa.ObsCore WHERE obs_collection='NEOSSAT'` returns rows
  (e.g. target `BarnardStar`, 2019) with `access_url` DataLink links. No CORS header.
- https://github.com/asc-csa/NEOSSAT_Tutorial: notebooks read open-data folders `/users/OpenData_DonneesOuvertes/pub/NEOSSAT/ASTRO/{year}/{doy}/`
  with files like `NEOS_SCI_2021002000257.fits`; modified MIT licence. SkyShift lists NEOSSat data from CADC and does not mix NEOSSat
  images with SPHEREx frames.
- https://data.asc-csa.gc.ca/dataset/neossat: the server sends a wrong intermediate certificate ("Entrust Certification Authority - L1K"
  instead of "Entrust OV TLS Issuing RSA CA 2"). The relay adds the correct public intermediate, fetched from the certificate's own
  AIA URL (`relay/certs/README.txt`), for this host only, with verification still on. Its CKAN API answers live: "NEOSSAT -
  Astronomy Data", 8 resources, Open Government Licence - Canada (checked 2026-11-14).

## Relay (why it exists)

IRSA TAP/SIA, MAST API, CADC TAP and the mission web pages do not send CORS headers, so a browser cannot read them
directly. `relay/core.mjs` is a stateless allow-list relay (hosts and path prefixes of the eight seeds only, GET/POST,
40 MB cap, 55 s timeout, no cookies, no logging, per-client rate limit). An archive's server error is reported in
`X-Relay-Upstream-Status` with a 200 from the relay (not cached), so clients use their fallbacks instead of failing over
to another relay, and a 502/503/504 from the relay always means the relay itself is down. It runs as the local server's `/api/relay`, and is
packaged for Cloudflare Pages Functions, Cloudflare Workers, Netlify Edge, Vercel Edge and Deno Deploy, so two or more
independent relays can be listed in `config.json`. GitHub Pages cannot run it: there the app skips the same-origin relay
(`config.json` → `staticHosts`), searches images through the static index (below) and uses any external relay listed
for catalogues; otherwise saved and built-in data. Image pixels never pass through the relay: they stream from the public
S3 bucket straight to the user's browser.

## Features left out because no approved source provides the data

- **Known solar-system object tracks**: no ephemeris service is reached from the seeds.
- **General object-name resolution**: no name resolver is reached from the seeds; names resolve for the five targets and for
  Gaia DR3 source IDs only.
- **Water, CO₂ and CO ice band markers**: the approved pages read (mission page, User Guide, Explanatory Supplement, SPLICES pages
  and release notes, tutorials) do not state their wavelengths. Lines that are stated are marked.
- **unWISE image overlay**: WiseView's image backend could not be read; WiseView is linked instead.

## Pre-built indexes (rebuilt by the scheduled workflow every 6 hours; refreshed copies kept in the Actions cache)

| File | Built by | Source | Checked |
|---|---|---|---|
| `data/targets.json` | `scripts/prebake.mjs` | IRSA TAP (Gaia DR3, spherex.artifact/plane) | 2026-11-14 |
| `data/coverage.json`, `data/mission.json` | `scripts/mission.mjs` | IRSA TAP `spherex.obscore` aggregates in 20-day windows (1,628,230 images, 100% of sky, 530 days) | 2026-11-14 |
| `data/idx/` (not committed) | `scripts/index.mjs` | IRSA TAP `spherex.artifact` JOIN `spherex.plane`, level-2b images: path, start time, detector, footprint; 5-day windows; one file per ~2° sky tile (1,628,230 images, 10,312 tiles, 190 MB on 2026-11-14). Checked against IRSA `CONTAINS` at 10 positions (targets, RA 0/360 wrap, both poles, both deep fields): identical except 3 of 29,398 images at the north deep field, positions within 0.36″ of a footprint edge (corners stored to 0.0001°) | every scheduled run |
| `data/live.json` | `scripts/live.mjs` (`src/lib/livelist.js`) | IRSA public S3 bucket listing: newest planning periods and detector-3 files, shown at once on the Live page | every scheduled run |
| `data/sources.json` | `scripts/sources.mjs` | the Mission page's checks of the eight resources, run from the build server | every scheduled run |
| `data/overlays/<target>.json` | `scripts/overlays.mjs` | IRSA TAP `gaia_dr3_source` and `catwise_2020` cones (0.6°) around the five targets | once (fixed catalogue releases) |
| `data/fastmovers.json` | `scripts/fastmovers.mjs` | IRSA TAP `gaia_dr3_source`, the 15 stars with pm > 3″/yr (asynchronous TAP job) | once (fixed catalogue release) |
| `assets/allsky-1000.jpg`, `assets/allsky-1600.jpg` | `scripts/allsky.mjs` | IRSA HiPS `spherex_allsky_cube`, order-3 Allsky previews of cube channels 8, 42, 95 | 2026-11-14 |

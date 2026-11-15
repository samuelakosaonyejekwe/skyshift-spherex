# Validation of the five challenge targets

Generated 2026-11-14T20:37:18.147Z by `node scripts/validate.mjs 360` with the same code the browser runs
(image lists saved from IRSA TAP in data/targets.json (TAP was unavailable), byte-range reads from the IRSA S3 bucket, TAN-SIP reprojection, six-month co-adds, centroids,
aperture photometry). Up to 360 exposures per target, sampled evenly in time; 6′ fields; WISE 0855 uses D4–D6.

Browser maths is separately checked against Astropy (`test/astropy.test.mjs`, reference from
`test/validate_astropy.py`): worst differences 4e-10″ in position, 1e-8 px, 1e-15 µm in wavelength.

## Proper motion (first vs last survey co-add) compared with Gaia DR3

| Target | Exposures used | Epochs | Measured μα*, μδ (mas/yr) | Gaia DR3 μα*, μδ (mas/yr) | Residual (mas/yr) | ±1σ μα*, μδ (mas/yr) | Speed vs Gaia; direction difference | Notes |
|---|---|---|---|---|---|---|---|---|
| Barnard's Star | 358 of 358 | 3 (2025-08-15 → 2026-08-16) | -1638, 10087 | -802, 10362 | -837, -275 | 522, 442 (3 epochs) | 10219 vs 10393 (-2%); 5° | 135 exposures with saturated core; parallax removed (up to 0.54″) |
| Epsilon Indi B | 360 of 458 | 4 (2025-04-24 → 2026-09-22) | 3129, -3531 | 3982, -2467 | -853, -1064 | 316, 307 (4 epochs) | 4718 vs 4684 (1%); 17° | parallax removed (up to 0.27″) |
| WISE 0855−0714 | 129 of 129 | 3 (2025-05-05 → 2026-04-21) | -11105, -13721 | not in Gaia DR3 | – | 9066, 440 (3 epochs) | – | – |
| RW Aurigae | 335 of 335 | 3 (2025-09-01 → 2026-09-02) | 434, -40 | 3, -27 | 432, -13 | 433, 433 (3 epochs) | motion below SPHEREx noise (Gaia 28 mas/yr, ±433) | 1 exposures with saturated core; parallax removed (up to 0.01″) |
| R Draconis | 360 of 2493 | 2 (2025-04-24 → 2025-08-29) | 200, 695 | -21, 6 | 221, 689 | 499, 499 (2 epochs) | motion below SPHEREx noise (Gaia 22 mas/yr, ±499) | 343 exposures with saturated core; centroid on saturated star (wings only); parallax removed (up to 0.00″) |

## Brightness change between survey passes (relative to the target's mean spectrum)

| Target | Photometric points | Questionable | Per-pass mean (relative) | Largest change | Significance |
|---|---|---|---|---|---|
| Barnard's Star | 17 | 17 | – | – | – |
| Epsilon Indi B | 343 | 28 | -0.4%±1.0 / -3.9%±1.6 / -5.4%±2.1 / -0.5%±1.5 | -5.0% ± 2.3% | 2.1σ |
| WISE 0855−0714 | 127 | 2 | -13.7%±14.5 / -0.5%±20.8 / -6.1%±14.7 | 13.2% ± 25.3% | 0.5σ |
| RW Aurigae | 278 | 134 | -11.4%±6.5 / 9.0%±3.8 / -4.7%±3.9 | 20.4% ± 7.5% | 2.7σ |
| R Draconis | 0 | 0 | – | – | – |

## Data per image (byte-range reads)

The same 6 exposures (two each of the first three targets) read by the app's reader with flags for the
target only. A full SPHEREx level-2 file is 64,952,640 bytes (HTTP HEAD on the S3 copy).
Both modes give identical pixels; saver reads only the columns the field covers.

| Field | Saver mode | Full rows | Saving vs full rows | Saving vs whole file |
|---|---|---|---|---|
| 2′ | 0.214 MB | 0.661 MB | 3.1× | 304× |
| 6′ (default) | 0.241 MB | 1.042 MB | 4.3× | 270× |
| 10′ | 0.288 MB | 1.445 MB | 5.0× | 225× |

## Asteroids, comets and shift-and-stack (live site, 15 November 2026)

Daily geocentric positions (NASA JPL Horizons, 1 May 2025 to 10 October 2026); SkyShift searched SPHEREx images along
each path and centred every exposure on the object at its time. Stacks are clipped (star trails rejected), errors come
from 16 comparison apertures, and a detection is "confirmed" only when every six-month pass shows it.

| Object | Exposures found | Result |
|---|---|---|
| 4 Vesta | 362 | centred and saturated (V ≈ 6–8), stars trailing |
| 67P/Churyumov-Gerasimenko (V ≈ 22) | 375 (3 passes) | no confirmed detection; 3σ limits AB 16.1–17.2 in five bands; D4 "not confirmed" (2 of 3 passes) in this crowded bulge field |
| (500) Selinur (V ≈ 14–15), positive control | 265 (257 measured, 2 passes) | detected in all six bands and both passes: AB 14.45, 14.30, 14.61, 15.42, 15.57, 14.94 (D1–D6); the rise at 4.4–5.0 µm is the start of its thermal emission |

A plain (unclipped) average gave AB 13–15 "detections" for 67P, which cannot be real: hence the clipping, comparison
apertures and per-pass check.

## Your own image: coordinates and calibrated magnitudes

On a 2MASS J image of the Barnard's Star field (IRSA Finder Chart, 1″ pixels), the inspector calibrated on 26 Gaia DR3
stars (zero point 22.376 ± 0.059 in G; star-to-star scatter 0.30 mag, as expected between J and G) and measured a star
clicked at random at G-equivalent 15.48 ± 0.06, matched to Gaia DR3 4472831276236887680 (G = 15.62) at 0.3″. On a
synthetic image the centroid is within 0.05 px, the aperture flux within 2% and the zero point within 0.08 mag
(`test/userimage.test.mjs`). Equinox-of-date positions use IAU 1976 precession, equal to Meeus example 21.b to 2×10⁻⁶°
(`test/report.test.mjs`).

## Image index from the archive storage

FITS headers of 12 files (MJD-BEG, DETECTOR, WCS corners) reproduce the index rows built from IRSA TAP: corners within
0.00″ and times within the index's 1×10⁻⁵ day (0.86 s) resolution (`node scripts/index-s3.mjs --check`).

## Reading the results

- Motion: Gaussian-weighted centroids of the target in every six-month co-add, then a weighted straight-line fit;
  uncertainties from the fit residuals (3+ epochs) or centroid noise. A residual within about 2σ means the motion
  SkyShift measures from SPHEREx agrees with Gaia. The speed and direction column shows partial agreement (for
  example the right speed in a slightly wrong direction). Saturated stars are centroided on their wings. Parallax is
  removed: each epoch's annual-parallax shift (from the Gaia DR3 parallax) is subtracted from the measured position
  before the straight-line fit, and the predicted positions include parallax.
- Brightness changes use quick-look aperture photometry divided by the target's mean spectrum, so they mix
  wavelengths; ≥3σ is flagged as a candidate, not a confirmed variation.
- Transfer: Barnard's Star 68 MB in 269 s; Epsilon Indi B 89 MB in 310 s; WISE 0855−0714 31 MB in 179 s; RW Aurigae 71 MB in 263 s; R Draconis 85 MB in 307 s.

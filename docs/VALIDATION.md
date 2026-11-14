# Validation of the five challenge targets

Generated 2026-11-14T10:31:40.012Z by `node scripts/validate.mjs 300` with the same code the browser runs
(IRSA TAP search, byte-range reads from the IRSA S3 bucket, TAN-SIP reprojection, six-month co-adds, centroids,
aperture photometry). Up to 300 exposures per target, sampled evenly in time; 6′ fields; WISE 0855 uses D4–D6.

Browser maths is separately checked against Astropy (`test/astropy.test.mjs`, reference from
`test/validate_astropy.py`): worst differences 4e-10″ in position, 1e-8 px, 1e-15 µm in wavelength.

## Proper motion (first vs last survey co-add) compared with Gaia DR3

| Target | Exposures used | Epochs | Measured μα*, μδ (mas/yr) | Gaia DR3 μα*, μδ (mas/yr) | Residual (mas/yr) | ±1σ μα*, μδ (mas/yr) | Notes |
|---|---|---|---|---|---|---|---|
| Barnard's Star | 300 of 358 | 3 (2025-08-15 → 2026-08-16) | -1397, 10139 | -802, 10362 | -596, -223 | 1031, 442 (3 epochs) | 114 exposures with saturated core; parallax removed (up to 0.54″) |
| Epsilon Indi B | 300 of 458 | 4 (2025-04-24 → 2026-09-22) | 2753, -3848 | 3982, -2467 | -1229, -1381 | 512, 486 (4 epochs) | parallax removed (up to 0.27″) |
| WISE 0855−0714 | 129 of 129 | 3 (2025-05-05 → 2026-04-21) | -11105, -13721 | not in Gaia DR3 | – | 9066, 440 (3 epochs) | – |
| RW Aurigae | 300 of 335 | 3 (2025-09-01 → 2026-09-02) | 389, -47 | 3, -27 | 386, -20 | 433, 433 (3 epochs) | parallax removed (up to 0.01″) |
| R Draconis | 300 of 2493 | 2 (2025-04-24 → 2025-08-29) | -368, 1549 | -21, 6 | -348, 1542 | 499, 499 (2 epochs) | 284 exposures with saturated core; centroid on saturated star (wings only); parallax removed (up to 0.00″) |

## Brightness change between survey passes (relative to the target's mean spectrum)

| Target | Photometric points | Questionable | Per-pass mean (relative) | Largest change | Significance |
|---|---|---|---|---|---|
| Barnard's Star | 15 | 15 | – | – | – |
| Epsilon Indi B | 289 | 28 | -2.6%±1.3 / -4.1%±2.0 / -2.1%±2.5 / -1.9%±1.4 | 2.2% ± 2.4% | 0.9σ |
| WISE 0855−0714 | 127 | 2 | -13.7%±14.5 / -0.5%±20.8 / -6.1%±14.7 | 13.2% ± 25.3% | 0.5σ |
| RW Aurigae | 249 | 121 | -3.4%±6.6 / 6.4%±3.7 / -7.1%±3.8 | -13.5% ± 5.3% | 2.5σ |
| R Draconis | 0 | 0 | – | – | – |

## Reading the results

- Motion: Gaussian-weighted centroids of the target in every six-month co-add, then a weighted straight-line fit;
  uncertainties from the fit residuals (3+ epochs) or centroid noise. A residual within about 2σ means the motion
  SkyShift measures from SPHEREx agrees with Gaia. Saturated stars are centroided on their wings. Parallax is
  removed: each epoch's annual-parallax shift (from the Gaia DR3 parallax) is subtracted from the measured position
  before the straight-line fit, and the predicted positions include parallax.
- Brightness changes use quick-look aperture photometry divided by the target's mean spectrum, so they mix
  wavelengths; ≥3σ is flagged as a candidate, not a confirmed variation.
- Transfer: Barnard's Star 57 MB in 115 s; Epsilon Indi B 75 MB in 150 s; WISE 0855−0714 31 MB in 81 s; RW Aurigae 64 MB in 121 s; R Draconis 70 MB in 189 s.

// World Coordinate System for SPHEREx Level 2 spectral images:
//  - celestial: RA---TAN-SIP / DEC--TAN-SIP (primary WCS of the IMAGE HDU)
//  - spectral : alternate WCS "W", CTYPE 'WAVE-TAB' bilinear lookup in the WCS-WAVE table
// Pixel convention here: FITS 1-based (x=1 is the centre of the first pixel).

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

function sipCoeffs(h, prefix) {
  const order = h[`${prefix}_ORDER`];
  if (!Number.isInteger(order)) return null;
  const terms = [];
  for (let p = 0; p <= order; p++) {
    for (let q = 0; q <= order - p; q++) {
      const v = h[`${prefix}_${p}_${q}`];
      if (typeof v === 'number' && v !== 0) terms.push([p, q, v]);
    }
  }
  return terms;
}

function polyEval(terms, u, v) {
  if (!terms) return 0;
  let s = 0;
  for (const [p, q, c] of terms) s += c * u ** p * v ** q;
  return s;
}

export class CelestialWCS {
  constructor(h) {
    this.crpix1 = h.CRPIX1; this.crpix2 = h.CRPIX2;
    this.crval1 = h.CRVAL1; this.crval2 = h.CRVAL2;
    const c1 = h.CDELT1 ?? 1, c2 = h.CDELT2 ?? 1;
    if (h.CD1_1 !== undefined) {
      this.cd = [[h.CD1_1, h.CD1_2 ?? 0], [h.CD2_1 ?? 0, h.CD2_2]];
    } else {
      this.cd = [[(h.PC1_1 ?? 1) * c1, (h.PC1_2 ?? 0) * c1], [(h.PC2_1 ?? 0) * c2, (h.PC2_2 ?? 1) * c2]];
    }
    const [[a, b], [c, d]] = this.cd;
    const det = a * d - b * c;
    this.icd = [[d / det, -b / det], [-c / det, a / det]];
    const sip = /SIP/.test(h.CTYPE1 || '');
    this.A = sip ? sipCoeffs(h, 'A') : null;
    this.B = sip ? sipCoeffs(h, 'B') : null;
    this.AP = sip ? sipCoeffs(h, 'AP') : null;
    this.BP = sip ? sipCoeffs(h, 'BP') : null;
    this.naxis1 = h.NAXIS1 ?? h.ZNAXIS1; this.naxis2 = h.NAXIS2 ?? h.ZNAXIS2;
    const a0 = this.crval1 * D2R, d0 = this.crval2 * D2R;
    this._sa = Math.sin(a0); this._ca = Math.cos(a0);
    this._sd = Math.sin(d0); this._cd = Math.cos(d0);
    this.pixelScaleArcsec = Math.sqrt(Math.abs(det)) * 3600;
  }

  /** FITS 1-based pixel -> [ra, dec] degrees */
  pixToWorld(x, y) {
    let u = x - this.crpix1, v = y - this.crpix2;
    if (this.A || this.B) { const du = polyEval(this.A, u, v), dv = polyEval(this.B, u, v); u += du; v += dv; }
    const xi = (this.cd[0][0] * u + this.cd[0][1] * v) * D2R;
    const eta = (this.cd[1][0] * u + this.cd[1][1] * v) * D2R;
    // inverse gnomonic (standard coordinates xi, eta)
    const rho = Math.hypot(xi, eta);
    if (rho === 0) return [this.crval1, this.crval2];
    const c = Math.atan(rho), sc = Math.sin(c), cc = Math.cos(c);
    const dec = Math.asin(cc * this._sd + (eta * sc * this._cd) / rho);
    const ra = this.crval1 * D2R + Math.atan2(xi * sc, rho * this._cd * cc - eta * this._sd * sc);
    let r = ra * R2D; r = ((r % 360) + 360) % 360;
    return [r, dec * R2D];
  }

  /** [ra, dec] degrees -> FITS 1-based pixel. Returns [NaN,NaN] behind the tangent plane. */
  worldToPix(ra, dec) {
    const da = ra * D2R - this.crval1 * D2R;
    const sd = Math.sin(dec * D2R), cdd = Math.cos(dec * D2R);
    const cosc = this._sd * sd + this._cd * cdd * Math.cos(da);
    if (cosc <= 0) return [NaN, NaN];
    const xi = (cdd * Math.sin(da)) / cosc * R2D;
    const eta = (this._cd * sd - this._sd * cdd * Math.cos(da)) / cosc * R2D;
    let U = this.icd[0][0] * xi + this.icd[0][1] * eta;
    let V = this.icd[1][0] * xi + this.icd[1][1] * eta;
    if (this.A || this.B) {
      // start from the inverse SIP polynomials (AP, BP) when the header has them, otherwise from the undistorted pixel
      let u = U + polyEval(this.AP, U, V), v = V + polyEval(this.BP, U, V);
      // refine with forward SIP so the inverse is consistent with pixToWorld to ~1e-6 px
      for (let i = 0; i < 20; i++) {
        const fu = u + polyEval(this.A, u, v) - U;
        const fv = v + polyEval(this.B, u, v) - V;
        if (Math.abs(fu) < 1e-8 && Math.abs(fv) < 1e-8) break;
        u -= fu; v -= fv;
      }
      U = u; V = v;
    }
    return [U + this.crpix1, V + this.crpix2];
  }
}

/**
 * WAVE-TAB lookup (FITS Paper III Sect. 6.1) as used by the SPHEREx "W" WCS:
 * CRPIX=1, CDELT=1, CRVAL=1, so the table index coordinate is the raw 1-based pixel.
 * table = { X: Int32Array(nx), Y: Int32Array(ny), VALUES: Float32Array(2*nx*ny) }
 * VALUES TDIM (2, nx, ny): fastest axis is [wavelength, bandwidth], then X, then Y.
 */
export class SpectralWCS {
  constructor(table) {
    this.X = Array.from(table.X); this.Y = Array.from(table.Y);
    this.V = table.VALUES; this.nx = this.X.length; this.ny = this.Y.length;
  }
  static _locate(grid, p) {
    const n = grid.length;
    if (p <= grid[0]) return [0, (p - grid[0]) / (grid[1] - grid[0])];
    if (p >= grid[n - 1]) return [n - 2, 1 + (p - grid[n - 1]) / (grid[n - 1] - grid[n - 2])];
    let i = 0;
    while (i < n - 2 && grid[i + 1] < p) i++;
    return [i, (p - grid[i]) / (grid[i + 1] - grid[i])];
  }
  /** 1-based pixel -> { wavelength (µm), bandwidth (µm) } */
  at(x, y) {
    const [i, fx] = SpectralWCS._locate(this.X, x);
    const [j, fy] = SpectralWCS._locate(this.Y, y);
    const g = (ii, jj, k) => this.V[k + 2 * (ii + this.nx * jj)];
    const out = [0, 0];
    for (let k = 0; k < 2; k++) {
      out[k] = (1 - fx) * (1 - fy) * g(i, j, k) + fx * (1 - fy) * g(i + 1, j, k)
        + (1 - fx) * fy * g(i, j + 1, k) + fx * fy * g(i + 1, j + 1, k);
    }
    return { wavelength: out[0], bandwidth: out[1] };
  }
}

"""Reference values from Astropy for SkyShift's browser WCS and wavelength code.

Reads only the needed bytes of real SPHEREx Level 2 files (IMAGE header and the WCS-WAVE
table) from IRSA's public bucket, then uses astropy.wcs exactly as the IRSA tutorials do:
  celestial: WCS(image_header)                (TAN-SIP)
  spectral : WCS(image_header, fobj=hdul, key='W'); sip = None
Writes test/fixtures/astropy-reference.json, compared by test/astropy.test.mjs.
Run: python test/validate_astropy.py   (needs astropy, numpy)
"""
import io, json, urllib.request
import numpy as np
import astropy
from astropy.io import fits
from astropy.wcs import WCS

S3 = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/'
FILES = [
    'dr1/level2/2025W18_1B/l2b-v27-2026-196/1/level2_2025W18_1B_0074_2D1_spx_l2b-v27-2026-196.fits',
    'dr1/level2/2025W33_2C/l2b-v27-2026-228/6/level2_2025W33_2C_0321_1D6_spx_l2b-v27-2026-228.fits',
    'dr1/level2/2025W33_2C/l2b-v27-2026-228/3/level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228.fits',
]

def get(url, rng):
    req = urllib.request.Request(url, headers={'Range': rng, 'User-Agent': 'SkyShift-validation/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()

def headers(key):
    url = S3 + key
    head = get(url, 'bytes=0-57599')
    prim = fits.Header.fromstring(head[:2880 * ((head.find(b'END     ') // 2880) + 1)].decode('ascii'))
    off = 2880 * ((head.find(b'END ' + b' ' * 76) // 2880) + 1)
    # IMAGE header follows the primary header
    end_img = head.find(b'END' + b' ' * 77, off)
    img_hdr = fits.Header.fromstring(head[off:end_img + 80].decode('ascii'))
    tail = get(url, 'bytes=-17280')
    i = tail.rfind(b"XTENSION= 'BINTABLE'")
    while i % 2880:
        i = tail.rfind(b"XTENSION= 'BINTABLE'", 0, i)
    synth = head[:off] + tail[i:]
    hdul = fits.open(io.BytesIO(synth))
    return img_hdr, hdul

out = {'astropy': astropy.__version__, 'files': []}
rng = np.random.default_rng(20261114)
for key in FILES:
    h, hdul = headers(key)
    cel = WCS(h)
    spec = WCS(header=h, fobj=hdul, key='W')
    spec.sip = None
    xs = rng.uniform(5, 2034, 25)
    ys = rng.uniform(5, 2034, 25)
    world = cel.pixel_to_world_values(xs, ys)          # 0-based pixels
    wl, bw = spec.pixel_to_world_values(xs, ys)
    pts = []
    for k in range(len(xs)):
        pts.append({'x0': float(xs[k]), 'y0': float(ys[k]), 'ra': float(world[0][k]), 'dec': float(world[1][k]),
                    'wl': float(wl[k]), 'bw': float(bw[k])})
    out['files'].append({'key': key, 'points': pts})
    print(key.split('/')[-1], 'ok', len(pts))

with open('test/fixtures/astropy-reference.json', 'w') as f:
    json.dump(out, f, indent=1)
print('written test/fixtures/astropy-reference.json')

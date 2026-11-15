// Learn: plain-language help, the 102 bands, how to find movers, URL/embed reference,
// keyboard shortcuts and classroom activities built on the five challenge targets.

import { h, cardify } from '../ui/dom.js';
import { DETECTORS, FLAG_BITS, BAD_MASK } from '../lib/spherex.js';

export const title = 'Learn';

export async function render(root) {
  const det = (d) => h('tr', {}, h('td', {}, h('span', { class: 'legend-dot', style: { '--c': `var(--d${d.id})` } }), `D${d.id}`), h('td', {}, `${d.range[0]}–${d.range[1]} µm`), h('td', {}, `R = ${d.R}`), h('td', {}, d.id <= 3 ? 'Short-wave array (SWIR)' : 'Mid-wave array (MWIR)'));
  const article = cardify(h('article', { class: 'prose' },
    h('h1', {}, 'Learn'),
    h('p', { class: 'muted' }, 'Everything you need to use SkyShift, in plain words.'),
    h('nav', { class: 'card', 'aria-label': 'On this page' }, h('div', { class: 'row' },
      [['start', 'Getting started'], ['bands', 'The 102 bands'], ['movers', 'Finding movers'], ['modes', 'Modes'], ['flags', 'Flags'], ['url', 'Links & embedding'], ['keys', 'Keyboard'], ['class', 'Classroom'], ['limits', 'Limitations']]
        .map(([id, l]) => h('a', { class: 'btn small ghost', href: `#/guide`, onclick: (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }); } }, l)))),

    h('h2', { id: 'start' }, 'Getting started'),
    h('ol', {},
      h('li', {}, 'On Explore, type a target: a challenge target name, an asteroid or comet name (opened on the Chase page), coordinates (decimal degrees or h m s / d m s), galactic coordinates like ', h('code', {}, 'l=30 b=2'), ', or ', h('code', {}, 'Gaia DR3 <source id>'), '.'),
      h('li', {}, 'SkyShift asks the IRSA archive for every SPHEREx image covering that point, then streams only the pixels it needs straight from IRSA’s public cloud copy.'),
      h('li', {}, 'Press Play. By default each frame adds together one six-month pass of the sky, so the film shows how the field changed between passes.'),
      h('li', {}, 'Click an object for its details and spectrum; mark anything interesting as a candidate.')),
    h('p', {}, 'SPHEREx began science operations on 1 May 2025 and maps the whole sky every six months. New data reach the archive weekly; SkyShift always searches the live archive, so new images appear without any update to the app.'),

    h('h2', { id: 'bands' }, 'The 102 bands'),
    h('p', {}, 'SPHEREx has six detector arrays. A filter whose colour changes across each array (a linear variable filter) means every pixel sees a slightly different wavelength. Each array is split into 17 spectral channels: 6 × 17 = 102 bands from 0.75 to 5.0 µm. As the telescope steps across the sky, every star is seen at many wavelengths, which builds its spectrum.'),
    h('table', { class: 'table' }, h('tr', {}, ['Array', 'Wavelengths', 'Resolving power', 'Type'].map((x) => h('th', {}, x))), DETECTORS.map(det)),
    h('p', { class: 'tiny' }, 'Source: IRSA SPHEREx mission page and tutorials. “Resolving power” R = λ/Δλ: higher R separates narrower spectral features.'),
    h('ul', {},
      h('li', {}, h('b', {}, 'Per-array co-adds: '), 'select one or more arrays in Display. SkyShift averages each array separately and then combines arrays with equal weight, which lifts faint objects out of the noise.'),
      h('li', {}, h('b', {}, 'False colour: '), 'the Colour mode maps short (D1–D2), middle (D3–D4) and long (D5–D6) wavelengths to blue, green and red. Very cold brown dwarfs look red.'),
      h('li', {}, h('b', {}, 'Spectra on the fly: '), 'each exposure gives one wavelength sample at the target; the Spectrum tab plots them all, coloured by survey pass, with uncertainties.'),
      h('li', {}, h('b', {}, 'Lines to look for: '), 'hydrogen Paschen α (1.88 µm) and Brackett α (4.052 µm), the 3.3 µm feature of carbon-rich PAH molecules, and the 1.083 µm helium line from Earth’s upper atmosphere (a contaminant).')),

    h('h2', { id: 'movers' }, 'How to spot a moving object'),
    h('p', {}, 'Pluto was found in 1930 by blinking two photographs taken days apart. Backyard Worlds volunteers use the same idea with WISE images and have found many brown dwarfs. In SkyShift:'),
    h('ol', {},
      h('li', {}, 'Choose “Per survey” frames and the Blink mode: the first and last passes alternate. Anything that jumps is moving.'),
      h('li', {}, 'Switch to Difference: still stars cancel to grey, a mover leaves a dark spot where it was and a bright spot where it is.'),
      h('li', {}, 'Turn on Gaia: circles show where known stars should be on each date. A mover with no Gaia circle is interesting.'),
      h('li', {}, 'Use Discover → “Spot the movers” for automatic suggestions, then check them by eye.')),
    h('p', {}, 'Earth’s orbit also makes nearby stars wobble back and forth over a year (parallax). Gaia parallaxes give their distances; the Object panel shows them.'),

    h('h2', { id: 'modes' }, 'Modes'),
    h('dl', { class: 'kv', style: { fontSize: '.95rem' } },
      h('dt', {}, 'Movie'), h('dd', { style: { fontFamily: 'inherit' } }, 'every frame in time order'),
      h('dt', {}, 'Blink'), h('dd', { style: { fontFamily: 'inherit' } }, 'two chosen epochs flip back and forth'),
      h('dt', {}, 'Difference'), h('dd', { style: { fontFamily: 'inherit' } }, 'each epoch minus a reference (mean of the others, the first, or the previous), matched array by array so wavelengths agree'),
      h('dt', {}, 'Stack'), h('dd', { style: { fontFamily: 'inherit' } }, 'epochs added cumulatively for depth'),
      h('dt', {}, 'Colour'), h('dd', { style: { fontFamily: 'inherit' } }, 'false-colour composite of three wavelength groups')),
    h('p', {}, 'All frames share one brightness stretch, so a star that looks brighter really is brighter (at that wavelength). Images are aligned on the sky using the world-coordinate solution in each file.'),

    h('h2', { id: 'flags' }, 'Contamination and quality flags'),
    h('p', {}, 'Every SPHEREx pixel carries flags. Red-tinted pixels (Display → Contamination flags) have one of the “bad” flags below and are left out of photometry. SOURCE only marks pixels on known sources.'),
    h('table', { class: 'table' }, h('tr', {}, ['Bit', 'Flag', 'Meaning', 'Treated as bad'].map((x) => h('th', {}, x))),
      FLAG_BITS.map(([b, n, d]) => h('tr', {}, h('td', {}, b), h('td', { class: 'mono' }, n), h('td', {}, d), h('td', {}, BAD_MASK & (1 << b) ? 'yes' : '–')))),
    h('p', { class: 'tiny' }, 'Flag names and meanings are read from the FLAGS header of SPHEREx Level 2 files (keywords MSKNnnnn/MSKDnnnn). The “bad” list follows the IRSA Source Discovery Tool tutorial.'),

    h('h2', { id: 'url' }, 'Links and embedding'),
    h('p', {}, 'Every view is described by its address, so you can bookmark, share or embed it. Use the main page with query parameters:'),
    h('pre', { class: 'card mono', style: { whiteSpace: 'pre-wrap' } }, `${location.origin}${location.pathname}?ra=133.786245&dec=-7.244372&fov=6&det=456&mode=blink`),
    h('table', { class: 'table' }, h('tr', {}, h('th', {}, 'Parameter'), h('th', {}, 'Meaning')),
      [['ra, dec', 'Position: degrees (133.786) or sexagesimal (08:55:10.8, -07:14:42)'], ['name, id', 'Label shown for the field; id of a preset (barnard, epsindib, wise0855, rwaur, rdra)'], ['target', 'Open a preset by id, e.g. target=rdra'],
        ['pmra, pmdec, epoch', 'Proper motion (mas/yr, μα* and μδ) and reference epoch (year) for the track and photometry'], ['fov', 'Field of view in arcminutes (1–60)'], ['det', 'Detector arrays, e.g. 456'], ['wl', 'Wavelength window in µm, e.g. 3-4'],
        ['group', 'exposure, day or survey'], ['mode', 'movie, blink, diff, stack, color or expr'], ['expr, where', 'Image equation and selection, as typed in the equation box'], ['diffref', 'mean, first or prev'], ['blink', 'Two frame numbers (from 0), e.g. 0,3'],
        ['stretch, lo, hi', 'asinh/log/sqrt/linear and black/white percentiles'], ['invert, cmap', 'Inverted greyscale; colour map gray/viridis/heat/ice'], ['speed', 'Milliseconds per frame'], ['track', '1 to follow the target’s proper motion'],
        ['ov', 'Overlays: gaia, wise, flags, track, compass'], ['eph', 'Follow an asteroid or comet loaded on the Chase page'], ['t', 'Frame number to open on'], ['embed', '1 for the compact embeddable view']].map(([a, b]) => h('tr', {}, h('td', { class: 'mono' }, a), h('td', {}, b)))),
    h('p', {}, 'WiseView-style parameters are understood too: ', h('code', {}, 'size'), ' (unWISE pixels of 2.75″), ', h('code', {}, 'speed'), ', ', h('code', {}, 'invert'), ', ', h('code', {}, 'linear'), ', ', h('code', {}, 'diff'), ', ', h('code', {}, 'gaia'), ', ', h('code', {}, 'window'), ' (years; ≥0.25 gives one frame per survey), ', h('code', {}, 'pmra'), '/', h('code', {}, 'pmdec'), ' (read as mas/yr). Parameters SkyShift has no use for are ignored.'),
    h('p', {}, 'Embed code (Share → Embed) gives an iframe. The embedded app runs in its own page and cannot read or change the page that hosts it.'),

    h('h2', { id: 'keys' }, 'Keyboard and touch'),
    h('table', { class: 'table' }, [['Space', 'Play / pause'], ['← →', 'Previous / next frame'], ['1–5', 'Movie, Blink, Difference, Stack, Colour'], ['+ − R', 'Zoom in, out, reset'], ['G W F', 'Gaia, WISE, flags overlays'], ['I', 'Invert'], ['?', 'Explain this view'], ['Alt+← / Alt+→', 'Back / forward between pages']]
      .map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d)))),
    h('p', {}, 'On touch screens: pinch to zoom, drag to pan, tap to inspect, and swipe in from the left or right edge to go back or forward.'),

    h('h2', { id: 'class' }, 'Classroom activities'),
    h('ol', {},
      h('li', {}, h('b', {}, 'The runaway star. '), h('a', { href: '#/view?target=barnard&mode=blink' }, 'Open Barnard’s Star'), '. Blink the first and last passes. Turn on the predicted track. How far does it move in six months? (Use the ruler.) Gaia says about 10.4″ per year: does SkyShift agree?'),
      h('li', {}, h('b', {}, 'A cold neighbour. '), h('a', { href: '#/view?target=wise0855&det=456&mode=blink' }, 'Open WISE 0855'), '. Compare D1–D2 with D5–D6. Why is it visible only at long wavelengths? Look at its spectrum.'),
      h('li', {}, h('b', {}, 'A family portrait. '), h('a', { href: '#/view?target=epsindib&fov=15&ov=gaia,track,compass' }, 'Open Epsilon Indi B'), ' with a 15′ field. Find the host star ε Indi A and the brown-dwarf pair. Why does SPHEREx see the pair as one dot?'),
      h('li', {}, h('b', {}, 'Breathing stars. '), h('a', { href: '#/view?target=rdra' }, 'Open R Draconis'), ' and ', h('a', { href: '#/view?target=rwaur' }, 'RW Aurigae'), '. Open the light curve. Did their brightness change between passes? By how much, and how sure are you?'),
      h('li', {}, h('b', {}, 'Be a discoverer. '), 'Press “Random field” on Home, run Discover, and decide whether each candidate is real. Save your best one and export it.')),

    h('h2', { id: 'limits' }, 'Limitations (honest list)'),
    h('ul', {},
      h('li', {}, 'Very bright stars (Barnard’s Star, R Draconis, ε Indi A) saturate SPHEREx: their cores have no valid pixels. SkyShift marks these frames and leaves them out of spectra.'),
      h('li', {}, 'SPHEREx pixels are 6.15″, so neighbouring objects blend; SkyShift warns when Gaia stars fall inside the photometry aperture. Forced photometry of blends is not yet implemented.'),
      h('li', {}, 'Photometry is simple aperture photometry for quick looks, not a replacement for the IRSA SPHEREx Spectrophotometry Tool.'),
      h('li', {}, 'Asteroids and comets: type their name, number or designation on the Chase page (positions from NASA JPL Horizons, an extra source beyond the challenge’s resources), or upload your own table of times and positions; SkyShift follows them along it.'),
      h('li', {}, 'Star names resolve for the five challenge targets; any other star opens by its coordinates or its Gaia DR3 source ID. Asteroid and comet names are looked up in NASA JPL Horizons.'),
      h('li', {}, 'Exact water, CO₂ and CO ice band wavelengths were not found in the approved sources, so they are not marked on spectra.'),
      h('li', {}, 'Image pixels come from IRSA’s cloud bucket, read directly or collected in one request by a small relay where one is available. Searches for new positions use IRSA’s live search through a small relay where one is available, and otherwise a pre-built index of every SPHEREx image, refreshed from IRSA every 6 hours. Gaia, WISE and NEOSSat overlays need the relay; without it the app says so and the images still work.')),
  ));
  root.append(article);
  return () => article.dispose?.();
}

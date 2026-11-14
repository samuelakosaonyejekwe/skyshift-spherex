// About: project, copyright and licence, hosting addresses, data credits and terms.

import { h, cardify } from '../ui/dom.js';
import { getConfig } from '../lib/net.js';

export const title = 'About';

export const SPHEREX_ACK = 'This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.';

export async function render(root) {
  const cfg = getConfig();
  let version = '';
  try { version = (await (await fetch('./version.json', { cache: 'no-cache' })).json()).version; } catch { /* offline */ }
  const article = cardify(h('article', { class: 'prose' },
    h('h1', {}, 'SkyShift: A Time Machine for the SPHEREx Sky'),
    h('p', { class: 'muted' }, 'A public web tool for the 2026 NASA Space Apps Challenge “Planet X and SPHEREx”, by team SkyShift Cyprus.'),
    h('p', {}, 'SkyShift lets anyone enter a patch of sky and watch NASA SPHEREx infrared images of it change over time, so moving and changing objects stand out. It is free, needs no account, installs on phones and computers, and works offline for fields you have viewed.'),
    h('div', { class: 'card' },
      h('p', { style: { margin: 0 } }, h('b', {}, 'Copyright © 2026 Samuel Akosa Onyejekwe. Licensed under the Apache License 2.0.')),
      h('p', { class: 'tiny', style: { margin: '6px 0 0' } }, 'You may use, share and adapt SkyShift under the Apache License 2.0, keeping the copyright and NOTICE file. Third-party data and software keep their own licences and credits, listed below.')),
    h('h2', {}, 'Where SkyShift lives'),
    h('ul', {},
      h('li', {}, 'Live app: ', h('a', { href: cfg.hosts?.primary || 'https://samuelakosaonyejekwe.github.io/skyshift-spherex/' }, cfg.hosts?.primary || 'https://samuelakosaonyejekwe.github.io/skyshift-spherex/')),
      h('li', {}, 'Backup mirror: ', ...(() => {
        // every https address in the mirror list (or the backup text) becomes a link, like the other two
        const urls = cfg.hosts?.mirrors?.length ? cfg.hosts.mirrors : String(cfg.hosts?.backup || '').match(/https:\/\/[^\s)]+/g) || [];
        return urls.length ? urls.flatMap((u, i) => [i ? ' · ' : null, h('a', { href: u, target: '_blank', rel: 'noopener' }, u)]).filter(Boolean) : [cfg.hosts?.backup || 'not set up yet'];
      })()),
      h('li', {}, 'Source code: ', h('a', { href: cfg.hosts?.code || 'https://github.com/samuelakosaonyejekwe/skyshift-spherex' }, cfg.hosts?.code || 'https://github.com/samuelakosaonyejekwe/skyshift-spherex'))),
    h('p', {}, 'Both hosts serve the same build. Installed copies keep working offline even if a host is unreachable, and data requests go from your device straight to the archives.'),
    version ? h('p', { class: 'tiny' }, `App version ${version}`) : null,

    h('h2', {}, 'Data credits and terms'),
    h('h3', {}, 'SPHEREx (NASA/JPL/Caltech) via NASA/IPAC Infrared Science Archive (IRSA)'),
    h('blockquote', { class: 'card' }, SPHEREX_ACK),
    h('ul', {},
      h('li', {}, 'SPHEREx Data Release 1 spectral images: DOI 10.26131/IRSA678; DR1 spectral all-sky cube: DOI 10.26131/IRSA679.'),
      h('li', {}, 'SPHEREx Quick Release 3: DOI 10.26131/IRSA662.'),
      h('li', {}, 'Mission: Bock et al. (2026), ApJ 999, 139. Pipeline: Akeson et al. (2026), ApJS 285, 67. Sky simulator: Crill et al. (2025), ApJS 281, 10. Instrument and calibration: Korngut et al. (2026).'),
      h('li', {}, 'Images are read from IRSA’s public cloud copy (bucket nasa-irsa-spherex) and searched with IRSA’s TAP service. The all-sky view uses IRSA’s SPHEREx HiPS.')),
    h('h3', {}, 'Gaia (ESA)'),
    h('p', {}, 'Gaia DR3 data from the European Space Agency mission Gaia, processed by the Gaia Data Processing and Analysis Consortium (DPAC), accessed through IRSA and the Mikulski Archive for Space Telescopes (MAST). ', h('a', { href: 'https://archives.esac.esa.int/doi/html/data/astronomy/gaia/DR3.html', target: '_blank', rel: 'noopener' }, 'Gaia DR3 DOI and citation'), '.'),
    h('h3', {}, 'WISE'),
    h('p', {}, 'CatWISE2020 and AllWISE catalogues, served by IRSA. Image comparisons with WISE/NEOWISE open in WiseView (Backyard Worlds: Planet 9).'),
    h('h3', {}, 'NEOSSat (Canadian Space Agency)'),
    h('p', {}, 'NEOSSat observations are listed from the Canadian Astronomy Data Centre (CADC, National Research Council of Canada). NEOSSat astronomy data are released under Canada’s Directive on Open Government and licensed under the Open Government Licence – Canada.'),
    h('h3', {}, 'Software'),
    h('ul', {},
      h('li', {}, 'Aladin Lite (CDS, Strasbourg Astronomical Data Centre), LGPL-3.0-or-later: the sky atlas.'),
      h('li', {}, 'Astropy: used to validate SkyShift’s browser calculations (coordinates, WCS) during development; the in-browser code follows the methods shown in the IRSA tutorials.'),
      h('li', {}, 'Everything else is original code written for SkyShift.')),
    h('p', { class: 'tiny' }, 'SkyShift is an independent project. It is not endorsed by NASA, Caltech/IPAC, ESA, the Canadian Space Agency, NRC/CADC or CDS, and it uses none of their logos.'),
    h('h2', {}, 'Privacy'),
    h('p', {}, 'No accounts, no tracking, no analytics. Searches go from your device to the archives (directly, or via a relay that forwards the request and keeps no logs of it), or use the image index published with the app. Saved fields, candidates and cached images stay in your browser’s storage.'),
  ));
  root.append(article);
  return () => article.dispose?.();
}

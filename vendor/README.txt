Aladin Lite 3.9.2-beta (CDS, Strasbourg Astronomical Data Center), LGPL-3.0-or-later.
Source: https://github.com/cds-astro/aladin-lite (npm package "aladin-lite", dist/aladin.js). Licence text: ALADIN-LICENSE.txt.

Local modification (for privacy; SkyShift sends no tracking data):
- The startup usage logger (function that called https://alasky.unistra.fr/cgi/AladinLiteLogger/log.py with the page URL
  and referrer) is disabled by making it return immediately: `tg.log=function(Q,A){return;try{...`.
No other changes.

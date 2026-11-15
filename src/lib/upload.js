// Upload parsing (runs in a Web Worker). Formats are detected by content, not extension.
// Everything is read as data: no macros, formulas or scripts are ever executed, file and
// archive sizes are capped, and malformed files fail with a clear message.

import { parseHeader, BLOCK, dataSize } from './fits.js';
import { CelestialWCS } from './wcs.js';
import { parsePosition, parseAngle, wrap360, fromGalactic } from './coords.js';
import { ephemerisFromTable, ephemerisFromText } from './ephem.js';

export const LIMITS = { fileBytes: 30 * 1024 * 1024, unzipBytes: 120 * 1024 * 1024, zipEntries: 200, rows: 20000, ratio: 200 };

const td = new TextDecoder('utf-8', { fatal: false });
const RA_NAMES = /^(ra|ra_?deg|raj2000|ra_?icrs|alpha|_?raj2000|right_?ascension|s_ra|ra\(deg\))$/i;
const DEC_NAMES = /^(dec|de|dec_?deg|dej2000|decj2000|de_?icrs|dec_?icrs|delta|declination|s_dec|dec\(deg\))$/i;
const NAME_NAMES = /^(name|id|object|obj|target|designation|source_?id|source_?name|main_?id|star|label)$/i;
const PMRA_NAMES = /^(pmra|pm_?ra|mura|pmra_?masyr)$/i;
const PMDEC_NAMES = /^(pmdec|pm_?dec|pmde|mudec)$/i;
const TIME_NAMES = /^(date|time|epoch|jd|mjd|utc|ut|t|datetime|date_?obs|obs_?date|date.*\(ut\).*|date_+\(ut\).*)$/i;

export async function parseUpload(name, buf, mapping = null) {
  const bytes = new Uint8Array(buf);
  if (bytes.length > LIMITS.fileBytes) throw new Error(`File is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is ${LIMITS.fileBytes / 1048576} MB.`);
  if (!bytes.length) throw new Error('The file is empty.');
  const head = bytes.subarray(0, 8);
  const ascii = String.fromCharCode(...bytes.subarray(0, 80));
  // gzip
  if (head[0] === 0x1f && head[1] === 0x8b) {
    const inner = await gunzip(bytes);
    if (/\.tar$/i.test(name.replace(/\.gz$/i, '')) || isTar(inner)) return fromArchive(name, untar(inner), mapping);
    return parseUpload(name.replace(/\.gz$/i, ''), inner.buffer, mapping);
  }
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const entries = await unzip(bytes);
    if (entries.has('xl/workbook.xml')) return finish('Excel workbook', tableFromXlsx(entries), mapping);
    if (entries.has('content.xml') && /opendocument\.spreadsheet/.test(td.decode(entries.get('mimetype') || new Uint8Array()))) return finish('OpenDocument spreadsheet', tableFromOds(entries.get('content.xml')), mapping);
    if (entries.has('word/document.xml')) return finish('Word document', tableFromText(xmlText(td.decode(entries.get('word/document.xml')), /<\/w:p>/g)), mapping, 'text');
    return fromArchive(name, entries, mapping);
  }
  if (isTar(bytes)) return fromArchive(name, untar(bytes), mapping);
  if (ascii.startsWith('SIMPLE  =')) return parseFits(bytes, mapping);
  if (ascii.startsWith('%PDF')) {
    const text = await pdfText(bytes);
    if (!text.trim()) throw new Error('No readable text found in this PDF (it may be scanned images). Copy the table into a text file, or type the coordinates.');
    return finish('PDF document (text extracted)', tableFromText(text), mapping, 'text');
  }
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG' || (head[0] === 0xff && head[1] === 0xd8) || ascii.startsWith('RIFF') || ascii.startsWith('II*') || ascii.startsWith('MM\0*')) {
    return { format: 'picture', userImage: { kind: 'picture', bytes: bytes.length, note: 'Pictures are shown as user-supplied images only; they are placed on the sky only if they carry WCS (use FITS for that). Reading tables from screenshots (OCR) is not available yet.' }, targets: [], columns: [], preview: [], errors: [] };
  }
  if (bytes.includes(0) && !/^[\x09\x0a\x0d\x20-\x7e]/.test(ascii)) throw new Error('This looks like a binary file SkyShift does not recognise (supported: FITS, CSV/TSV, TXT, JSON, VOTable, IPAC, ECSV, Excel, ODS, Word, DS9 regions, MPC/ADES, ZIP/TAR).');
  const text = td.decode(bytes).replace(/^\uFEFF/, '');
  return parseText(name, text, mapping);
}

function parseText(name, text, mapping) {
  const t = text.trimStart();
  if (/^<\?xml[\s\S]{0,300}<VOTABLE|^<VOTABLE/i.test(t)) return finish('VOTable', tableFromVOTable(t), mapping);
  if (/<ades\b/i.test(t.slice(0, 2000))) return finish('MPC ADES (XML)', tableFromAdesXml(t), mapping);
  if (/^#\s*version=\d.*\n.*\|/i.test(t) || /^permID\s*\||^provID\s*\|/m.test(t.slice(0, 3000))) return finish('MPC ADES (PSV)', tableFromDelimited(t.replace(/^#.*$/gm, ''), '|'), mapping);
  if (/^[\[{]/.test(t)) {
    let j;
    try { j = JSON.parse(t); } catch (e) { throw new Error(`JSON could not be read: ${e.message}`); }
    return finish(j?.type === 'FeatureCollection' ? 'GeoJSON' : 'JSON', tableFromJson(j), mapping);
  }
  if (/^# %ECSV/.test(t)) return finish('ECSV', tableFromDelimited(t.replace(/^#.*$/gm, '').trim(), !(t.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').includes(',') ? ' ' : ','), mapping);
  if (/^\s*\|/m.test(t.slice(0, 4000)) && /^\\/m.test(t.slice(0, 4000)) || /^\|[^\n]+\|\s*\n\|/m.test(t.slice(0, 2000))) return finish('IPAC table', tableFromIpac(t), mapping);
  if (/^(# Region file|global |fk5|icrs|circle\()/im.test(t.slice(0, 500))) return finish('DS9 region file', tableFromDs9(t), mapping);
  if (looksMpc80(t)) return finish('MPC 80-column observations', tableFromMpc80(t), mapping);
  if (/^\s*\|.*\|\s*$/m.test(t) && /^\s*\|?\s*:?-{3,}/m.test(t)) return finish('Markdown table', tableFromDelimited(t.split('\n').filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l)).map((l) => l.replace(/^\s*\||\|\s*$/g, '')).join('\n'), '|'), mapping);
  if (/^[\w ]+:\s/m.test(t) && /^\s*-\s/m.test(t) && !/,/.test(t.split('\n')[0])) return finish('YAML list', tableFromYaml(t), mapping);
  const first = t.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#')) || '';
  const delim = first.includes('\t') ? '\t' : first.split(',').length > 2 || (first.includes(',') && !/\d,\d/.test(first)) ? ',' : first.includes(';') ? ';' : null;
  if (delim) {
    const tab = tableFromDelimited(t, delim);
    if (tab.columns.length >= 2) return finish(delim === '\t' ? 'TSV' : delim === ';' ? 'CSV (semicolon)' : 'CSV', tab, mapping);
  }
  return finish('Plain text', tableFromText(t), mapping, 'text');
}

// ------------------------------------------------------------------ table builders -> { columns, rows }
function splitDelimited(line, d) {
  if (d instanceof RegExp || d === ' ') return line.trim().split(/\s+/);
  const out = []; let f = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === d) { out.push(f.trim()); f = ''; } else f += c;
  }
  out.push(f.trim());
  return out;
}
function tableFromDelimited(text, d) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() && !/^\s*#/.test(l));
  if (!lines.length) return { columns: [], rows: [] };
  const first = splitDelimited(lines[0], d);
  const numericFirst = first.filter((x) => Number.isFinite(Number(x)) && x !== '').length >= Math.max(2, first.length - 1);
  const columns = numericFirst ? first.map((_, i) => `col${i + 1}`) : first.map((h, i) => h || `col${i + 1}`);
  const rows = (numericFirst ? lines : lines.slice(1)).slice(0, LIMITS.rows).map((l) => splitDelimited(l, d));
  return { columns, rows };
}
function tableFromText(text) {
  // messy lists: one target per line, mixed formats; name is whatever is not the coordinate
  const rows = [];
  for (const raw of text.split(/\r\n|\r|\n/).slice(0, LIMITS.rows)) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line || line.startsWith('#')) continue;
    rows.push([line]);
  }
  return { columns: ['line'], rows, freeText: true };
}
function attr(tag, name) { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i')); return m ? m[1] : null; }
const unxml = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
function xmlText(xml, paraRe) { return xml.replace(paraRe, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
function tableFromVOTable(x) {
  const fields = [...x.matchAll(/<FIELD\b[^>]*>/gi)].map((m) => attr(m[0], 'name') || attr(m[0], 'ID') || 'col');
  const rows = [...x.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR>/gi)].slice(0, LIMITS.rows).map((m) => [...m[1].matchAll(/<TD\b[^>]*>([\s\S]*?)<\/TD>|<TD\b[^>]*\/>/gi)].map((c) => unxml(c[1] || '')));
  if (!rows.length && /<BINARY|<FITS/i.test(x)) throw new Error('This VOTable stores its data in binary form, which is not read yet. Save it as a TABLEDATA VOTable or CSV.');
  return { columns: fields, rows };
}
function tableFromAdesXml(x) {
  const rows = [], cols = ['permID', 'provID', 'trkSub', 'obsTime', 'ra', 'dec', 'mag', 'band', 'stn'];
  for (const m of x.matchAll(/<optical>([\s\S]*?)<\/optical>/gi)) rows.push(cols.map((c) => unxml((m[1].match(new RegExp(`<${c}>([\\s\\S]*?)</${c}>`, 'i')) || [])[1] || '')));
  return { columns: cols, rows };
}
function tableFromJson(j) {
  if (j?.type === 'FeatureCollection') {
    const rows = j.features.slice(0, LIMITS.rows).map((f) => {
      const [lon, lat] = f.geometry?.coordinates || [];
      return [f.properties?.name ?? f.id ?? '', wrap360(lon), lat];
    });
    return { columns: ['name', 'ra', 'dec'], rows };
  }
  const arr = Array.isArray(j) ? j : Array.isArray(j?.targets) ? j.targets : Array.isArray(j?.data) ? j.data : Array.isArray(j?.candidates) ? j.candidates : null;
  if (!arr) {
    if (j && typeof j === 'object' && ('ra' in j || 'RA' in j)) return tableFromJson([j]);
    throw new Error('JSON must be a list of objects (or have a "targets", "data" or "candidates" list).');
  }
  if (Array.isArray(arr[0])) return { columns: arr[0].map((_, i) => `col${i + 1}`), rows: arr.slice(0, LIMITS.rows).map((r) => r.map(String)) };
  const columns = [...new Set(arr.slice(0, 200).flatMap((o) => Object.keys(o || {})))].filter((k) => typeof arr[0]?.[k] !== 'object' || arr[0]?.[k] === null);
  return { columns, rows: arr.slice(0, LIMITS.rows).map((o) => columns.map((c) => (o?.[c] ?? '') + '')) };
}
function tableFromIpac(t) {
  const lines = t.split(/\r?\n/).filter((l) => !l.startsWith('\\'));
  const hdr = lines.filter((l) => l.startsWith('|'));
  if (!hdr.length) throw new Error('IPAC table header ("|name|…|") not found.');
  const bars = []; for (let i = 0; i < hdr[0].length; i++) if (hdr[0][i] === '|') bars.push(i);
  const columns = bars.slice(0, -1).map((b, k) => hdr[0].slice(b + 1, bars[k + 1]).trim());
  const rows = lines.filter((l) => l.trim() && !l.startsWith('|')).slice(0, LIMITS.rows).map((l) => bars.slice(0, -1).map((b, k) => l.slice(b, bars[k + 1] + 1).replace(/\|/g, '').trim()));
  return { columns, rows };
}
function tableFromDs9(t) {
  const rows = [];
  for (const m of t.matchAll(/\b(circle|point|box|ellipse)\s*\(\s*([^,)]+)\s*,\s*([^,)]+)[^)]*\)(?:\s*#.*?text\s*=\s*\{([^}]*)\})?/gi)) {
    const sexa = /:/.test(m[2]);
    rows.push([m[4] || m[1], sexa ? String(parseAngle(m[2], { hours: true })) : m[2], sexa ? String(parseAngle(m[3])) : m[3]]);
  }
  if (/\bimage\b/i.test(t) && !rows.length) throw new Error('Only sky-coordinate (fk5/icrs) DS9 regions can be read, not image-pixel regions.');
  return { columns: ['name', 'ra', 'dec'], rows };
}
function looksMpc80(t) {
  const ls = t.split(/\r?\n/).filter((l) => l.length >= 77);
  return ls.length > 0 && ls.slice(0, 5).every((l) => /^\d{4} \d\d \d\d\.\d+/.test(l.slice(15, 32)) && /\d\d \d\d \d\d/.test(l.slice(32, 44)));
}
function tableFromMpc80(t) {
  const rows = t.split(/\r?\n/).filter((l) => l.length >= 77).slice(0, LIMITS.rows).map((l) => {
    const name = (l.slice(0, 5).trim() || l.slice(5, 12).trim());
    const ra = parseAngle(l.slice(32, 44).trim(), { hours: true });
    const dec = parseAngle(l.slice(44, 56).trim());
    return [name, String(ra), String(dec), l.slice(15, 32).trim(), l.slice(77, 80).trim()];
  });
  return { columns: ['name', 'ra', 'dec', 'date', 'station'], rows };
}
function tableFromYaml(t) {
  const rows = []; let cur = null; const cols = new Set();
  for (const line of t.split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(\w+)\s*:\s*(.*)$/);
    const kv = line.match(/^\s+(\w+)\s*:\s*(.*)$/);
    if (item) { cur = { [item[1]]: item[2].replace(/^['"]|['"]$/g, '') }; rows.push(cur); cols.add(item[1]); }
    else if (kv && cur) { cur[kv[1]] = kv[2].replace(/^['"]|['"]$/g, ''); cols.add(kv[1]); }
  }
  const columns = [...cols];
  return { columns, rows: rows.slice(0, LIMITS.rows).map((r) => columns.map((c) => r[c] ?? '')) };
}
function tableFromXlsx(entries) {
  const shared = [];
  const ss = entries.get('xl/sharedStrings.xml');
  if (ss) for (const m of td.decode(ss).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(unxml(m[1]));
  const sheetName = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw new Error('No worksheet found in the workbook.');
  const xml = td.decode(entries.get(sheetName));
  const grid = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(`<c ${c[1]}>`, 'r') || '';
      const col = ref.replace(/\d+/g, '').split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const type = attr(`<c ${c[1]}>`, 't');
      const v = ((c[2] || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1]; // cached value only: formulas are never evaluated
      const is = ((c[2] || '').match(/<is>([\s\S]*?)<\/is>/) || [])[1];
      row[col >= 0 ? col : row.length] = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? unxml(is || '') : unxml(v || '');
    }
    grid.push(Array.from(row, (x) => x ?? ''));
    if (grid.length > LIMITS.rows) break;
  }
  return headerise(grid);
}
function tableFromOds(content) {
  const xml = td.decode(content);
  const table = (xml.match(/<table:table\b[\s\S]*?<\/table:table>/) || [''])[0];
  const grid = [];
  for (const r of table.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
    const row = [];
    for (const c of r[1].matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
      const rep = Math.min(50, Number(attr(`<x ${c[1]}>`, 'table:number-columns-repeated') || 1));
      const val = attr(`<x ${c[1]}>`, 'office:value') ?? unxml((c[2] || '').replace(/<\/text:p>/g, ' '));
      for (let i = 0; i < rep; i++) row.push(val);
    }
    while (row.length && row[row.length - 1] === '') row.pop();
    if (row.length) grid.push(row);
    if (grid.length > LIMITS.rows) break;
  }
  return headerise(grid);
}
function headerise(grid) {
  const g = grid.filter((r) => r.some((x) => String(x).trim()));
  if (!g.length) return { columns: [], rows: [] };
  const first = g[0];
  const numeric = first.filter((x) => x !== '' && Number.isFinite(Number(x))).length >= Math.max(2, first.length - 1);
  const width = Math.max(...g.map((r) => r.length));
  const columns = numeric ? Array.from({ length: width }, (_, i) => `col${i + 1}`) : Array.from({ length: width }, (_, i) => String(first[i] ?? `col${i + 1}`) || `col${i + 1}`);
  return { columns, rows: (numeric ? g : g.slice(1)).map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? ''))) };
}

// ------------------------------------------------------------------ FITS (tables and images)
function parseFits(bytes, mapping) {
  let off = 0, hdu = 0;
  const found = [];
  while (off + BLOCK <= bytes.length && hdu < 30) {
    const p = parseHeader(bytes, off);
    if (!p) break;
    const h = p.header;
    found.push({ h, dataStart: p.end, index: hdu });
    off = p.end + dataSize(h);
    hdu++;
  }
  if (!found.length) throw new Error('FITS header could not be read.');
  // image with celestial WCS
  for (const f of found) {
    const h = f.h;
    // a tile-compressed image (ZIMAGE) stores its real size in ZNAXISn; NAXISn there is the table layout
    const n1 = h.ZIMAGE ? h.ZNAXIS1 : h.NAXIS1, n2 = h.ZIMAGE ? h.ZNAXIS2 : h.NAXIS2;
    if ((h.NAXIS >= 2 || h.ZNAXIS >= 2) && /RA-|GLON/.test(h.CTYPE1 || '') && !(h.XTENSION === 'BINTABLE' && !h.ZIMAGE)) {
      const wcs = new CelestialWCS(h);
      let [ra, dec] = wcs.pixToWorld((n1 + 1) / 2, (n2 + 1) / 2);
      // an image in galactic coordinates gives (l, b): convert to ICRS like every other position
      if (/^GLON/.test(h.CTYPE1 || '') && Number.isFinite(ra)) ({ ra, dec } = fromGalactic(ra, dec));
      const fov = (Math.max(n1, n2) * wcs.pixelScaleArcsec) / 60;
      return {
        format: 'FITS image (user-supplied)', columns: [], preview: [], errors: [],
        userImage: { kind: 'fits', width: n1, height: n2, extension: f.index, bunit: h.BUNIT || '', object: h.OBJECT || '', dateObs: h['DATE-OBS'] || '', telescope: h.TELESCOP || '', instrument: h.INSTRUME || '', center: [ra, dec], fovArcmin: fov, pixelScale: wcs.pixelScaleArcsec },
        targets: Number.isFinite(ra) ? [{ name: h.OBJECT || 'Centre of uploaded image', ra, dec }] : [],
      };
    }
  }
  // binary table
  for (const f of found) {
    const h = f.h;
    if (h.XTENSION !== 'BINTABLE' || h.ZIMAGE) continue;
    const cols = [];
    let o = 0;
    for (let k = 1; k <= h.TFIELDS; k++) {
      const m = String(h[`TFORM${k}`]).match(/^(\d*)([LXBIJKAEDCMPQ])/);
      const rep = m[1] ? Number(m[1]) : 1, t = m[2];
      const size = { L: 1, X: 0.125, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 }[t];
      cols.push({ name: h[`TTYPE${k}`] || `col${k}`, t, rep, off: o, scale: h[`TSCAL${k}`] ?? 1, zero: h[`TZERO${k}`] ?? 0 });
      o += t === 'X' ? Math.ceil(rep / 8) : rep * size; // X (bit) columns pack 8 bits per byte
    }
    const nrow = Math.min(h.NAXIS2, LIMITS.rows), width = h.NAXIS1;
    if (f.dataStart + nrow * width > bytes.length) throw new Error('FITS table is truncated.');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rows = [];
    for (let r = 0; r < nrow; r++) {
      const base = f.dataStart + r * width;
      rows.push(cols.map((c) => {
        const at = base + c.off;
        switch (c.t) {
          case 'A': return td.decode(bytes.subarray(at, at + c.rep)).replace(/\0+$/, '').trim();
          case 'E': return String(dv.getFloat32(at, false) * c.scale + c.zero);
          case 'D': return String(dv.getFloat64(at, false) * c.scale + c.zero);
          case 'J': return String(dv.getInt32(at, false) * c.scale + c.zero);
          case 'I': return String(dv.getInt16(at, false) * c.scale + c.zero);
          case 'K': return String(Number(dv.getBigInt64(at, false)) * c.scale + c.zero);
          case 'B': return String(bytes[at]);
          case 'L': return String.fromCharCode(bytes[at]);
          default: return '';
        }
      }));
    }
    return finish('FITS binary table', { columns: cols.map((c) => c.name), rows }, mapping);
  }
  throw new Error('This FITS file has neither a sky-coordinate image (WCS) nor a table with positions.');
}

// ------------------------------------------------------------------ archives
async function fromArchive(name, entries, mapping) {
  const results = [];
  for (const [path, data] of entries) {
    if (results.length >= 20) break;
    if (/\/$|^__MACOSX|\.DS_Store$/.test(path) || !data.length) continue;
    try { results.push({ path, ...(await parseUpload(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), mapping)) }); }
    catch (e) { results.push({ path, error: e.message }); }
  }
  const targets = results.flatMap((r) => (r.targets || []).map((t) => ({ ...t, file: r.path })));
  return { format: `Archive (${entries.size} files)`, files: results.map((r) => ({ path: r.path, format: r.format, targets: r.targets?.length || 0, error: r.error })), targets, columns: [], preview: [], errors: results.filter((r) => r.error).map((r) => ({ line: r.path, msg: r.error })) };
}
async function inflate(data, fmt) {
  const ds = new DecompressionStream(fmt);
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const reader = stream.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > LIMITS.unzipBytes || total > data.length * LIMITS.ratio + 1e6) { reader.cancel(); throw new Error('Archive expands too much (possible zip bomb); refused.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
export const gunzip = (b) => inflate(b, 'gzip');
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('ZIP directory not found (file damaged?).');
  const count = dv.getUint16(eocd + 10, true), cdOff = dv.getUint32(eocd + 16, true);
  if (count > LIMITS.zipEntries) throw new Error(`ZIP has ${count} entries; the limit is ${LIMITS.zipEntries}.`);
  const out = new Map();
  let p = cdOff, total = 0;
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP directory is damaged.');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), lho = dv.getUint32(p + 42, true);
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    total += usize;
    if (total > LIMITS.unzipBytes || usize > csize * LIMITS.ratio + 1e6) throw new Error('Archive expands too much (possible zip bomb); refused.');
    if (name.endsWith('/')) continue;
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const data = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, await inflate(data, 'deflate-raw'));
    else throw new Error(`ZIP entry "${name}" uses an unsupported compression method.`);
  }
  return out;
}
function isTar(b) { return b.length > 512 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar'; }
function untar(b) {
  const out = new Map(); let off = 0, n = 0;
  while (off + 512 <= b.length && n < LIMITS.zipEntries) {
    const name = td.decode(b.subarray(off, off + 100)).replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(td.decode(b.subarray(off + 124, off + 136)).replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(b[off + 156]);
    if (type === '0' || type === '\0') out.set(name, b.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512; n++;
  }
  return out;
}

// ------------------------------------------------------------------ column mapping -> targets
export function detectMapping(columns) {
  const find = (re) => { const i = columns.findIndex((c) => re.test(String(c).trim())); return i >= 0 ? i : null; };
  return { ra: find(RA_NAMES), dec: find(DEC_NAMES), name: find(NAME_NAMES), pmra: find(PMRA_NAMES), pmdec: find(PMDEC_NAMES) };
}

/**
 * A table of times and positions (an ephemeris of an asteroid or comet): a time column with RA/Dec columns, or
 * lines that start with a time followed by RA and Dec (the plain-text tables of ephemeris services). At least 3
 * positions at different times; otherwise null.
 */
function detectEphemeris(columns, rows) {
  const find = (re) => { const i = columns.findIndex((c) => re.test(String(c).trim())); return i >= 0 ? i : null; };
  const time = find(TIME_NAMES), ra = find(RA_NAMES), dec = find(DEC_NAMES);
  let e = time != null && ra != null && dec != null ? ephemerisFromTable(rows, { time, ra, dec }) : null;
  if (!e) e = ephemerisFromText(rows.map((r) => r.map((c) => String(c ?? '').trim()).filter(Boolean).join('  ')).join('\n'));
  return e && e.points.length >= 3 ? { points: e.points, skipped: e.bad.length, from: e.points[0][0], to: e.points[e.points.length - 1][0] } : null;
}

function finish(format, table, mapping, mode = 'table') {
  const res = finishTargets(format, table, mapping, mode);
  const eph = detectEphemeris(table.columns || [], table.rows || []);
  if (eph) { res.ephemeris = eph; res.errors = []; }
  return res;
}

function finishTargets(format, table, mapping, mode = 'table') {
  const { columns, rows } = table;
  const errors = [];
  const targets = [];
  let map = mapping && columns.length ? mapping : detectMapping(columns);
  if (mode === 'text' || table.freeText || (map.ra == null && map.dec == null && columns.length === 1)) {
    rows.forEach((r, i) => {
      const line = r.join(' ');
      const pos = findPositionInText(line);
      if (pos) targets.push({ name: pos.rest || `Line ${i + 1}`, ra: pos.ra, dec: pos.dec, line: i + 1 });
      else if (line.trim()) errors.push({ line: i + 1, text: line.slice(0, 80), msg: 'no coordinates recognised' });
    });
    return { format, columns: ['line'], mapping: null, preview: rows.slice(0, 8), rows: rows.length, targets, errors: errors.slice(0, 50) };
  }
  if (map.ra == null || map.dec == null) {
    // try sexagesimal pair in a single column
    return { format, columns, mapping: map, needsMapping: true, preview: rows.slice(0, 8), rows: rows.length, targets: [], errors: [{ line: 0, msg: 'Which columns hold Right Ascension and Declination? Choose them below.' }] };
  }
  rows.forEach((r, i) => {
    const raS = r[map.ra], decS = r[map.dec];
    const raSexa = /[:hms ]/.test(String(raS).trim());
    const ra = parseAngle(raS, { hours: raSexa }), dec = parseAngle(decS);
    if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) { errors.push({ line: i + 2, text: `${raS} ${decS}`, msg: 'not a valid RA/Dec' }); return; }
    const t = { name: map.name != null ? String(r[map.name]).slice(0, 80) : `Row ${i + 1}`, ra: wrap360(ra), dec, line: i + 2 };
    if (map.pmra != null && Number.isFinite(Number(r[map.pmra]))) t.pmra = Number(r[map.pmra]);
    if (map.pmdec != null && Number.isFinite(Number(r[map.pmdec]))) t.pmdec = Number(r[map.pmdec]);
    targets.push(t);
  });
  return { format, columns, mapping: map, preview: rows.slice(0, 8), rows: rows.length, targets, errors: errors.slice(0, 50) };
}

function findPositionInText(line) {
  const s = line.replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sexa = s.match(/(\d{1,2}[h:\s]\s*\d{1,2}[m:\s]\s*\d{1,2}(?:\.\d+)?s?)\s+([+\-−]?\s*\d{1,2}[d°:\s]\s*\d{1,2}[m′':\s]\s*\d{1,2}(?:\.\d+)?[s″"]?)/i);
  const dec = s.match(/(?:^|\s)(\d{1,3}\.\d+)\s+([+\-−]?\d{1,2}\.\d+)(?:\s|$)/);
  const m = sexa || dec;
  if (!m) return null;
  const pos = parsePosition(`${m[1]} ${/^[+\-−]/.test(m[2].trim()) ? m[2].trim().replace('−', '-').replace(/^([+-])\s+/, '$1') : '+' + m[2].trim()}`);
  if (!pos) return null;
  return { ...pos, rest: s.replace(m[0], ' ').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// ------------------------------------------------------------------ PDF text (content streams; no scripts executed)
async function pdfText(bytes) {
  const raw = new TextDecoder('latin1').decode(bytes);
  const out = [];
  const re = /<<([^]*?)>>\s*stream\r?\n/g;
  let m, n = 0;
  while ((m = re.exec(raw)) && n < 400) {
    n++;
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let data = bytes.subarray(start, end);
    if (/\/FlateDecode/.test(m[1])) {
      try { data = await inflate(data, 'deflate'); } catch { continue; }
    } else if (/\/Filter/.test(m[1])) continue; // images and other encodings are skipped
    const s = new TextDecoder('latin1').decode(data);
    if (!/T[jJ]|Tf/.test(s)) continue;
    // text-showing operators: (..) Tj, [(..) n (..)] TJ, and line moves
    const lines = [];
    let line = '';
    for (const t of s.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj|\[(?:[^\]]*)\]\s*TJ|T\*|-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+T[dD]|ET/g)) {
      const op = t[0];
      if (/T\*|T[dD]$|^ET$/.test(op)) { if (line.trim()) lines.push(line.trim()); line = ''; continue; }
      const parts = op.startsWith('[') ? [...op.matchAll(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g)].map((x) => (x[0].startsWith('(') ? x[0] : Number(x[0]) < -200 ? '( )' : '()')) : [op.slice(0, op.lastIndexOf(')') + 1)];
      for (const p of parts) line += p.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: ' ', r: ' ', t: ' ', b: '', f: '' }[c] ?? c));
    }
    if (line.trim()) lines.push(line.trim());
    out.push(...lines);
  }
  return out.join('\n');
}

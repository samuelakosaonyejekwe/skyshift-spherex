// Background worker for the image inspector: decodes the user's FITS image (including tile-compressed files of tens
// of millions of pixels) off the page, so the page stays responsive. Returns the pixels and the header; the page
// rebuilds the sky solution from the header.
import { readFitsImage } from './lib/userimage.js';

self.onmessage = async (e) => {
  try {
    let bytes = new Uint8Array(e.data.buf);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    const img = readFitsImage(bytes);
    self.postMessage({ ok: true, width: img.width, height: img.height, data: img.data, header: img.header, galactic: img.galactic, compressed: !!img.compressed }, [img.data.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err.message || err) });
  }
};

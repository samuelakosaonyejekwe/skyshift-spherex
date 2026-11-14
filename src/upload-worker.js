// Parses uploaded files off the main thread. Files never leave the device.
import { parseUpload } from './lib/upload.js';

self.onmessage = async (e) => {
  const { id, name, buffer, mapping } = e.data;
  try {
    const result = await parseUpload(name, buffer, mapping);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err.message || err) });
  }
};

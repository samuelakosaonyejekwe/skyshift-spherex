// Publishes data/live.json: the newest SPHEREx archive listing (src/lib/livelist.js), so the Live page has a
// recent snapshot to show at once on any device. Run by the scheduled workflow; keeps the previous file on failure.
import { writeFileSync } from 'node:fs';
import { snapshot } from '../src/lib/livelist.js';
try {
  const s = await snapshot();
  writeFileSync('data/live.json', JSON.stringify(s));
  console.log('data/live.json written:', s.top.period, s.keys.length, 'frames,', s.total, 'periods');
} catch (e) { console.error('live snapshot failed, keeping the previous file:', e.message); }

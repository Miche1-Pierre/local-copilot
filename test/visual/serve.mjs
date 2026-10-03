// Static server for the webview visual checks (dev only, loopback only).
// npm run build && npm run visual → open http://127.0.0.1:5179/test/visual/panel.html or dashboard.html
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = join(import.meta.dirname, '..', '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.map': 'application/json' };
createServer(async (req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
  try {
    const body = await readFile(join(root, path || 'test/visual/dashboard.html'));
    res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(5179, '127.0.0.1', () => console.log('visual check server on http://127.0.0.1:5179'));

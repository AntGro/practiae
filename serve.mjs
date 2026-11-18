// Zero-dependency static server for local dev. No Flask, no Python,
// no build step — the app is static files only.
// Run: node serve.mjs [port]   (default 8000)
// Then open http://localhost:8000/ (or /demo.html for the demo version).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/+$/, '');
const PORT = parseInt(process.argv[2] || process.env.PORT || '8000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const file = normalize(join(ROOT, pathname));
    if (!file.startsWith(ROOT + sep) && file !== ROOT) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Practiae (front-only) at http://localhost:${PORT}/  — demo: http://localhost:${PORT}/demo.html`);
});

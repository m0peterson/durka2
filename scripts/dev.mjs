// Small local runner for this dependency-free app. Netlify enforces rate limits only on deploy.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import session from '../netlify/functions/session.mjs';
import models from '../netlify/functions/models.mjs';
import analyze from '../netlify/functions/analyze.mjs';
const routes = { '/api/session': session, '/api/models': models, '/api/analyze': analyze };
const publicFiles = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/fonts.css': ['fonts.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost:8888');
    if (routes[url.pathname]) {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4_000_000) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const request = new Request(url, { method: req.method, headers: req.headers, ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await routes[url.pathname](request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } else if (publicFiles[url.pathname]) {
      const [file, type] = publicFiles[url.pathname]; res.setHeader('Content-Type', `${type}; charset=utf-8`); res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
    } else { res.writeHead(404); res.end('Not found'); }
  } catch { res.writeHead(500); res.end('Local server error'); }
}).listen(8888, '127.0.0.1', () => console.log('Durkometr: http://localhost:8888 (local only; rate limits are enforced on Netlify)'));

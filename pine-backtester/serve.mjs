#!/usr/bin/env node
// Zero-dependency local server:  node serve.mjs [port]  ->  http://localhost:8080
//
// Besides the app's files it serves /api/history (see src/market.js). The same
// endpoint runs in the cloud as api/history.js (see DEPLOY.md).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const port = +(process.argv[2] || process.env.PORT || 8080);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.pine': 'text/plain',
};

import { history, validRequest } from './src/market.js';

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = decodeURIComponent(u.pathname);
  if (url === '/api/ping') return sendJson(res, 200, { ok: true });
  if (url === '/api/history') {
    const symbol = u.searchParams.get('symbol') || 'MNQ1!';
    const interval = u.searchParams.get('interval') || '1m';
    if (!validRequest(symbol, interval)) return sendJson(res, 400, { error: 'unknown symbol or interval' });
    try {
      const data = await history(symbol, interval);
      return sendJson(res, 200, data);
    } catch (e) {
      return sendJson(res, 502, { error: String(e.message || e) });
    }
  }
  if (url === '/' || url === '/app') {
    res.writeHead(302, { Location: '/app/' });
    return res.end();
  }
  const path = normalize(join(root, url.endsWith('/') ? `${url}index.html` : url));
  if (!path.startsWith(root)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Pine Backtester running at http://localhost:${port}/`));

#!/usr/bin/env node
// Zero-dependency local server:  node serve.mjs [port]  ->  http://localhost:8080
//
// Besides the app's files it serves /api/history, which downloads price history
// from Yahoo Finance's public chart endpoint (no account or key). A web page can't
// call that endpoint itself, so the server fetches it and hands the bars to the page.
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

// ---------------------------------------------------------------- market data
const DAY = 86400;
// How far back Yahoo serves each interval, and the largest window per request.
const LIMITS = {
  '1m': { back: 29 * DAY, chunk: 7 * DAY },
  '2m': { back: 59 * DAY, chunk: 59 * DAY },
  '5m': { back: 59 * DAY, chunk: 59 * DAY },
  '15m': { back: 59 * DAY, chunk: 59 * DAY },
  '30m': { back: 59 * DAY, chunk: 59 * DAY },
  '60m': { back: 729 * DAY, chunk: 729 * DAY },
  '1d': { back: null }, // everything
};
// TradingView-style futures names -> Yahoo continuous front-month symbols.
const FUTURES = ['MNQ', 'NQ', 'MES', 'ES', 'MYM', 'YM', 'M2K', 'RTY', 'MGC', 'GC', 'SIL', 'SI', 'MCL', 'CL', 'NG', 'ZB', 'ZN', 'ZF', 'ZT',
  'HG', 'PL', '6E', '6J', '6B', '6A', '6C', 'M6E', 'MBT', 'BTC', 'ZC', 'ZS', 'ZW'];

export function yahooSymbol(input) {
  let s = String(input || '').trim().toUpperCase();
  if (s.includes(':')) s = s.split(':').pop(); // CME_MINI:MNQ1! -> MNQ1!
  const fut = /^([A-Z0-9]+?)(\d!|!)$/.exec(s); // MNQ1!, ES1!
  if (fut && FUTURES.includes(fut[1])) return `${fut[1]}=F`;
  if (FUTURES.includes(s)) return `${s}=F`;
  const usdt = /^([A-Z]+)USDT?$/.exec(s); // BTCUSDT -> BTC-USD
  if (usdt && !s.includes('-') && s.length > 4) return `${usdt[1]}-USD`;
  return s;
}

const cache = new Map();
async function yahooChunk(sym, interval, p1, p2) {
  const host = ['query2', 'query1'];
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const range = `period1=${p1}&period2=${p2}`;
    // futures and crypto trade around the clock; stocks use regular hours like TradingView's default
    const prepost = /=F$|-USD$/.test(sym);
    const url = `https://${host[attempt % 2]}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&${range}&includePrePost=${prepost}&events=div%2Csplit`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (pine-backtester)', Accept: 'application/json' } });
      const j = await res.json().catch(() => null);
      if (!j || !j.chart) throw new Error(`Yahoo returned ${res.status}`);
      if (j.chart.error) throw new Error(j.chart.error.description || j.chart.error.code);
      return j.chart.result[0];
    } catch (e) {
      lastErr = e;
      if (/No data found|delisted|not found/i.test(e.message)) break;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function history(symbol, interval) {
  const lim = LIMITS[interval];
  if (!lim) throw new Error(`unsupported interval ${interval}`);
  const sym = yahooSymbol(symbol);
  const key = `${sym}|${interval}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const now = Math.floor(Date.now() / 1000);
  const parts = [];
  if (lim.back === null) parts.push(await yahooChunk(sym, interval, 0, now + DAY)); // explicit range keeps daily bars daily
  else {
    const start = now - lim.back;
    // newest first, so a failure on the oldest window still returns recent data
    for (let end = now + 60; end > start; end -= lim.chunk) {
      try {
        parts.push(await yahooChunk(sym, interval, Math.max(start, end - lim.chunk), end));
      } catch (e) {
        if (!parts.length) throw e;
        break;
      }
    }
  }
  const rows = new Map();
  let meta = null;
  for (const r of parts) {
    meta = meta || r.meta;
    const q = r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!r.timestamp || !q) continue;
    r.timestamp.forEach((t, i) => {
      const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
      if ([o, h, l, c].some((v) => v === null || v === undefined || Number.isNaN(v))) return;
      rows.set(t, [t * 1000, o, h, l, c, q.volume[i] || 0]);
    });
  }
  if (!rows.size) throw new Error(`no ${interval} data for ${sym}`);
  const sorted = [...rows.values()].sort((a, b) => a[0] - b[0]);
  // Yahoo serves floats like 21000.250000001; snap to the instrument's price precision
  const dec = meta && Number.isInteger(meta.priceHint) ? meta.priceHint : 6;
  const fix = (v) => +v.toFixed(Math.max(dec, 2));
  const data = {
    symbol, yahooSymbol: sym, interval,
    name: meta && (meta.shortName || meta.longName || meta.symbol),
    exchangeTimezone: meta && meta.exchangeTimezoneName,
    time: sorted.map((r) => r[0]), open: sorted.map((r) => fix(r[1])), high: sorted.map((r) => fix(r[2])),
    low: sorted.map((r) => fix(r[3])), close: sorted.map((r) => fix(r[4])), volume: sorted.map((r) => r[5]),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const url = decodeURIComponent(u.pathname);
  if (url === '/api/ping') return sendJson(res, 200, { ok: true });
  if (url === '/api/history') {
    try {
      const data = await history(u.searchParams.get('symbol') || 'MNQ1!', u.searchParams.get('interval') || '1m');
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

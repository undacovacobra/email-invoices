#!/usr/bin/env node
// Builds / extends the saved market-data archive in data/.
//
// Yahoo only serves a rolling window of intraday history (1-minute: ~30 days,
// 5-30 minute: ~60 days, 1-hour: ~2 years). Running this regularly (the GitHub
// Action in .github/workflows/update-market-archive.yml does it weekly) adds the new
// bars to the archive, so the history the app can backtest on keeps growing.
//
//   node scripts/update-archive.mjs            all symbols below
//   node scripts/update-archive.mjs MNQ1! ES1!   just these
//
// Layout: data/index.json lists the files; bars live in gzip'd JSON chunks,
// data/<SYMBOL>/<interval>/<chunk>.json.gz with chunks by month (<=30m), year (1h)
// or one file (daily), so a weekly update only rewrites the newest chunk.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { history, rawHistory } from '../src/market.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const SYMBOLS = process.argv.slice(2).length ? process.argv.slice(2) : ['MNQ1!', 'NQ1!', 'MES1!', 'ES1!'];
const INTERVALS = ['1m', '5m', '15m', '30m', '60m', '1d'];

export const fileKey = (yahooSym) => yahooSym.replace(/[^A-Za-z0-9]/g, '_');
const chunkOf = (interval, ms) => {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (interval === '1d') return 'all';
  if (interval === '60m') return String(y);
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

async function readChunk(path) {
  try {
    return JSON.parse(gunzipSync(await readFile(path)).toString());
  } catch {
    return null;
  }
}

function merge(old, add, frozenUntil = -Infinity) {
  const m = new Map();
  if (old) old.t.forEach((t, i) => m.set(t, [t, old.o[i], old.h[i], old.l[i], old.c[i], old.v[i]]));
  // bars up to frozenUntil came from a better source (e.g. exchange data) and are kept
  add.forEach((r) => { if (r[0] > frozenUntil) m.set(r[0], r); });
  const rows = [...m.values()].sort((a, b) => a[0] - b[0]);
  return { t: rows.map((r) => r[0]), o: rows.map((r) => r[1]), h: rows.map((r) => r[2]), l: rows.map((r) => r[3]), c: rows.map((r) => r[4]), v: rows.map((r) => r[5]) };
}

async function main() {
  const indexPath = join(root, 'index.json');
  let index = { updated: null, symbols: {} };
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); } catch { /* first run */ }
  for (const symbol of SYMBOLS) {
    for (const interval of INTERVALS) {
      let live;
      try {
        // daily bars of micro contracts are extended with the full-size contract
        live = interval === '1d' ? await history(symbol, interval) : await rawHistory(symbol, interval);
      } catch (e) {
        console.log(`${symbol} ${interval}: skipped (${e.message})`);
        continue;
      }
      const key = fileKey(live.yahooSymbol);
      const dir = join(root, key, interval);
      await mkdir(dir, { recursive: true });
      // the newest bar may still be forming: leave it to the live download
      const n = live.time.length - 1;
      const byChunk = new Map();
      for (let i = 0; i < n; i++) {
        const c = chunkOf(interval, live.time[i]);
        if (!byChunk.has(c)) byChunk.set(c, []);
        byChunk.get(c).push([Math.round(live.time[i] / 1000), live.open[i], live.high[i], live.low[i], live.close[i], live.volume[i]]);
      }
      let added = 0;
      const prev = (index.symbols[key] || {})[interval] || {};
      for (const [c, rows] of byChunk) {
        const path = join(dir, `${c}.json.gz`);
        const old = await readChunk(path);
        const merged = merge(old, rows, prev.frozenUntil ?? -Infinity);
        added += merged.t.length - (old ? old.t.length : 0);
        const body = gzipSync(JSON.stringify(merged), { level: 9 });
        await writeFile(path, body);
      }
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json.gz')).sort();
      let bars = 0;
      let from = Infinity;
      let to = -Infinity;
      for (const f of files) {
        const d = (await readChunk(join(dir, f))) || { t: [] };
        bars += d.t.length;
        if (d.t.length) { from = Math.min(from, d.t[0]); to = Math.max(to, d.t[d.t.length - 1]); }
      }
      index.symbols[key] = index.symbols[key] || {};
      index.symbols[key][interval] = { ...prev, files, bars, from, to };
      console.log(`${live.yahooSymbol} ${interval}: +${added} new bars, ${bars} saved in ${files.length} file(s)`);
    }
  }
  index.updated = new Date().toISOString();
  await writeFile(indexPath, `${JSON.stringify(index, null, 1)}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

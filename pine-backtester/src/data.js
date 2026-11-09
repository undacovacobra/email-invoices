// OHLCV data loading: CSV (including TradingView's "Export chart data" file),
// a public crypto exchange feed, and a synthetic sample series.

function parseTime(v) {
  const s = String(v).trim().replace(/^"|"$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) {
    const x = +s;
    return x > 1e11 ? x : x * 1000; // ms vs seconds
  }
  // 2024-01-02, 2024-01-02 09:30, 2024-01-02T09:30:00 (no zone -> UTC), 2024.01.02
  const m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // 01/02/2024 (US style)
  const u = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (u) return Date.UTC(+u[3], +u[1] - 1, +u[2], +(u[4] || 0), +(u[5] || 0), +(u[6] || 0));
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
}

function splitLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === delim && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

export function parseCSV(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw new Error('CSV needs a header row and at least one data row');
  const first = lines[0];
  const delim = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const header = splitLine(first, delim).map((h) => h.toLowerCase().replace(/[<>"]/g, '').trim());
  const find = (...names) => header.findIndex((h) => names.includes(h));
  let iTime = find('time', 'timestamp', 'datetime', 'date time', 'open time', 'opentime', 'unix', 'date');
  const iDate = find('date', 'day');
  const iClock = find('time');
  const combineDateTime = iDate >= 0 && iClock >= 0 && iDate !== iClock;
  if (combineDateTime) iTime = iDate;
  const iOpen = find('open', 'o');
  const iHigh = find('high', 'h');
  const iLow = find('low', 'l');
  const iClose = find('close', 'c', 'last', 'price');
  const iVol = find('volume', 'vol', 'v', 'volume usdt', 'basic volume');
  if ([iTime, iOpen, iHigh, iLow, iClose].some((i) => i < 0)) {
    throw new Error(`CSV must have time, open, high, low and close columns (found: ${header.join(', ')})`);
  }
  const rows = [];
  for (let k = 1; k < lines.length; k++) {
    const c = splitLine(lines[k], delim);
    const t = combineDateTime ? parseTime(`${c[iDate]} ${c[iClock]}`) : parseTime(c[iTime]);
    const r = [t, +c[iOpen], +c[iHigh], +c[iLow], +c[iClose], iVol >= 0 ? +c[iVol] || 0 : 0];
    if (r.slice(0, 5).some((x) => Number.isNaN(x))) continue;
    rows.push(r);
  }
  return fromRows(rows);
}

export function fromRows(rows) {
  rows.sort((a, b) => a[0] - b[0]);
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let last = -Infinity;
  for (const [t, o, h, l, c, v] of rows) {
    if (t === last) continue;
    last = t;
    d.time.push(t); d.open.push(o); d.high.push(Math.max(h, o, c)); d.low.push(Math.min(l, o, c)); d.close.push(c); d.volume.push(v);
  }
  if (!d.time.length) throw new Error('no valid rows found');
  return d;
}

// Deterministic random-walk data so the app works offline.
export function sampleData(n = 1500, stepMs = 4 * 3600000, seed = 42) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const rows = [];
  let p = 30000, drift = 0;
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    if (i % 150 === 0) drift = (rnd() - 0.5) * 0.004;
    const o = p;
    const c = o * (1 + drift + gauss() * 0.012);
    const h = Math.max(o, c) * (1 + Math.abs(gauss()) * 0.005);
    const l = Math.min(o, c) * (1 - Math.abs(gauss()) * 0.005);
    rows.push([start + i * stepMs, +o.toFixed(2), +h.toFixed(2), +l.toFixed(2), +c.toFixed(2), +(500 + rnd() * 1500).toFixed(3)]);
    p = c;
  }
  return fromRows(rows);
}

// Public market-data endpoint (no API key). Works from the browser; pages
// backwards to collect up to `bars` candles.
export async function fetchBinance(symbol, interval, bars = 3000) {
  const rows = [];
  let end;
  while (rows.length < bars) {
    const limit = Math.min(1000, bars - rows.length);
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol.toUpperCase())}&interval=${interval}&limit=${limit}${end ? `&endTime=${end}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`exchange returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const k = await res.json();
    if (!k.length) break;
    rows.unshift(...k.map((x) => [x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]));
    end = k[0][0] - 1;
    if (k.length < limit) break;
  }
  return fromRows(rows);
}

// ta.* built-ins.
//
// Every call site of a ta function gets its own state (exactly like Pine), keyed
// by `key`. State is stored in arrays indexed by bar so that re-evaluating a call
// on the same bar overwrites instead of double-counting. Formulas follow the
// reference implementations in the Pine Script manual so results line up with
// what TradingView shows.

export const isNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const num = (v) => (isNa(v) ? NaN : +v);

function st(rt, key) {
  let s = rt.taState.get(key);
  if (!s) { s = {}; rt.taState.set(key, s); }
  return s;
}
function put(s, name, bar, v) {
  const a = s[name] || (s[name] = []);
  a[bar] = v;
  return a;
}
const at = (a, i) => (i < 0 || a[i] === undefined ? NaN : a[i]);

function windowVals(a, bar, len) {
  if (!(len >= 1) || bar - len + 1 < 0) return null;
  const out = new Array(len);
  for (let k = 0; k < len; k++) {
    const v = a[bar - k];
    if (isNa(v)) return null;
    out[k] = v; // out[0] = current, out[k] = k bars ago
  }
  return out;
}

// ---- primitives usable by composites ------------------------------------
export function sma(rt, key, src, len) {
  len = Math.round(num(len));
  const s = st(rt, key);
  const a = put(s, 'src', rt.bar, num(src));
  const w = windowVals(a, rt.bar, len);
  if (!w) return NaN;
  let sum = 0;
  for (const v of w) sum += v;
  return sum / len;
}

function smoothed(rt, key, src, len, alpha) {
  const s = st(rt, key);
  const a = put(s, 'src', rt.bar, num(src));
  const out = s.out || (s.out = []);
  const prev = at(out, rt.bar - 1);
  let v;
  if (isNa(prev)) {
    const w = windowVals(a, rt.bar, len);
    v = w ? w.reduce((x, y) => x + y, 0) / len : NaN;
  } else {
    v = alpha * num(src) + (1 - alpha) * prev;
  }
  out[rt.bar] = v;
  return v;
}
export function ema(rt, key, src, len) {
  len = Math.round(num(len));
  return smoothed(rt, key, src, len, 2 / (len + 1));
}
export function rma(rt, key, src, len) {
  len = Math.round(num(len));
  return smoothed(rt, key, src, len, 1 / len);
}
export function wma(rt, key, src, len) {
  len = Math.round(num(len));
  const a = put(st(rt, key), 'src', rt.bar, num(src));
  const w = windowVals(a, rt.bar, len);
  if (!w) return NaN;
  let norm = 0, sum = 0;
  for (let k = 0; k < len; k++) {
    const weight = len - k;
    norm += weight;
    sum += w[k] * weight;
  }
  return sum / norm;
}
function stdevImpl(rt, key, src, len, biased = true) {
  len = Math.round(num(len));
  const a = put(st(rt, key), 'src', rt.bar, num(src));
  const w = windowVals(a, rt.bar, len);
  if (!w) return NaN;
  const mean = w.reduce((x, y) => x + y, 0) / len;
  let ss = 0;
  for (const v of w) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (biased ? len : len - 1));
}
export function trueRange(rt, handleNa) {
  const b = rt.bar;
  const h = rt.data.high[b], l = rt.data.low[b];
  if (b === 0) return handleNa ? h - l : NaN;
  const pc = rt.data.close[b - 1];
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}
function highestImpl(rt, key, src, len, wantBars, lowest) {
  len = Math.round(num(len));
  const a = put(st(rt, key), 'src', rt.bar, num(src));
  if (rt.bar - len + 1 < 0) return NaN;
  let best = NaN, bestK = 0;
  for (let k = 0; k < len; k++) {
    const v = a[rt.bar - k];
    if (isNa(v)) continue;
    if (isNa(best) || (lowest ? v < best : v > best)) { best = v; bestK = k; }
  }
  if (isNa(best)) return NaN;
  return wantBars ? -bestK : best;
}
function hist(rt, key, name, v) {
  return put(st(rt, key), name, rt.bar, v);
}

const DAY_MS = 86400000;

// ---- the table of exported functions -------------------------------------
// Each entry: [paramNames, impl(rt, key, ...args)]
export const TA = {
  sma: [['source', 'length'], (rt, k, s, l) => sma(rt, k, s, l)],
  ema: [['source', 'length'], (rt, k, s, l) => ema(rt, k, s, l)],
  rma: [['source', 'length'], (rt, k, s, l) => rma(rt, k, s, l)],
  wma: [['source', 'length'], (rt, k, s, l) => wma(rt, k, s, l)],
  vwma: [['source', 'length'], (rt, k, s, l) => {
    const v = rt.data.volume[rt.bar];
    return sma(rt, k + '/sv', num(s) * v, l) / sma(rt, k + '/v', v, l);
  }],
  swma: [['source'], (rt, k, s) => {
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, 4);
    return w ? (w[3] + 2 * w[2] + 2 * w[1] + w[0]) / 6 : NaN;
  }],
  hma: [['source', 'length'], (rt, k, s, l) => {
    l = Math.round(num(l));
    const half = wma(rt, k + '/h', s, Math.floor(l / 2));
    const full = wma(rt, k + '/f', s, l);
    return wma(rt, k + '/o', 2 * half - full, Math.floor(Math.sqrt(l)));
  }],
  alma: [['series', 'length', 'offset', 'sigma', 'floor'], (rt, k, s, l, off = 0.85, sigma = 6, fl = false) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, l);
    if (!w) return NaN;
    const m = fl ? Math.floor(off * (l - 1)) : off * (l - 1);
    const sd = l / sigma;
    let norm = 0, sum = 0;
    for (let i = 0; i < l; i++) {
      const wt = Math.exp(-((i - m) ** 2) / (2 * sd * sd));
      norm += wt;
      sum += w[l - 1 - i] * wt;
    }
    return sum / norm;
  }],
  rsi: [['source', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    const prev = at(a, rt.bar - 1);
    const ch = num(s) - prev;
    const u = isNa(ch) ? NaN : Math.max(ch, 0);
    const d = isNa(ch) ? NaN : Math.max(-ch, 0);
    const ru = rma(rt, k + '/u', u, l);
    const rd = rma(rt, k + '/d', d, l);
    if (isNa(ru) || isNa(rd)) return NaN;
    if (rd === 0) return 100;
    if (ru === 0) return 0;
    return 100 - 100 / (1 + ru / rd);
  }],
  atr: [['length'], (rt, k, l) => rma(rt, k, trueRange(rt, true), l)],
  stdev: [['source', 'length', 'biased'], (rt, k, s, l, b = true) => stdevImpl(rt, k, s, l, b)],
  variance: [['source', 'length', 'biased'], (rt, k, s, l, b = true) => stdevImpl(rt, k, s, l, b) ** 2],
  dev: [['source', 'length'], (rt, k, s, l) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, l);
    if (!w) return NaN;
    const mean = w.reduce((x, y) => x + y, 0) / l;
    return w.reduce((x, y) => x + Math.abs(y - mean), 0) / l;
  }],
  highest: [['source', 'length'], (rt, k, s, l) => {
    if (l === undefined) { l = s; s = rt.data.high[rt.bar]; }
    return highestImpl(rt, k, s, l, false, false);
  }],
  lowest: [['source', 'length'], (rt, k, s, l) => {
    if (l === undefined) { l = s; s = rt.data.low[rt.bar]; }
    return highestImpl(rt, k, s, l, false, true);
  }],
  highestbars: [['source', 'length'], (rt, k, s, l) => {
    if (l === undefined) { l = s; s = rt.data.high[rt.bar]; }
    return highestImpl(rt, k, s, l, true, false);
  }],
  lowestbars: [['source', 'length'], (rt, k, s, l) => {
    if (l === undefined) { l = s; s = rt.data.low[rt.bar]; }
    return highestImpl(rt, k, s, l, true, true);
  }],
  crossover: [['source1', 'source2'], (rt, k, a, b) => {
    const A = hist(rt, k, 'a', num(a)), B = hist(rt, k, 'b', num(b));
    const pa = at(A, rt.bar - 1), pb = at(B, rt.bar - 1);
    return num(a) > num(b) && pa <= pb;
  }],
  crossunder: [['source1', 'source2'], (rt, k, a, b) => {
    const A = hist(rt, k, 'a', num(a)), B = hist(rt, k, 'b', num(b));
    const pa = at(A, rt.bar - 1), pb = at(B, rt.bar - 1);
    return num(a) < num(b) && pa >= pb;
  }],
  cross: [['source1', 'source2'], (rt, k, a, b) => {
    const A = hist(rt, k, 'a', num(a)), B = hist(rt, k, 'b', num(b));
    const pa = at(A, rt.bar - 1), pb = at(B, rt.bar - 1);
    return (num(a) > num(b) && pa <= pb) || (num(a) < num(b) && pa >= pb);
  }],
  change: [['source', 'length'], (rt, k, s, l = 1) => {
    const a = hist(rt, k, 'src', typeof s === 'boolean' ? +s : num(s));
    const v = a[rt.bar] - at(a, rt.bar - Math.round(num(l)));
    return typeof s === 'boolean' ? v !== 0 : v;
  }],
  mom: [['source', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    return a[rt.bar] - at(a, rt.bar - Math.round(num(l)));
  }],
  roc: [['source', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    const p = at(a, rt.bar - Math.round(num(l)));
    return (100 * (a[rt.bar] - p)) / p;
  }],
  rising: [['source', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    for (let i = 1; i <= l; i++) if (!(a[rt.bar] > at(a, rt.bar - i))) return false;
    return true;
  }],
  falling: [['source', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    for (let i = 1; i <= l; i++) if (!(a[rt.bar] < at(a, rt.bar - i))) return false;
    return true;
  }],
  cum: [['source'], (rt, k, s) => {
    const o = st(rt, k);
    const out = o.out || (o.out = []);
    const prev = at(out, rt.bar - 1);
    const v = (isNa(prev) ? 0 : prev) + (isNa(s) ? 0 : num(s));
    out[rt.bar] = v;
    return v;
  }],
  macd: [['source', 'fastlen', 'slowlen', 'siglen'], (rt, k, s, f, sl, sg) => {
    const m = ema(rt, k + '/f', s, f) - ema(rt, k + '/s', s, sl);
    const sig = ema(rt, k + '/g', m, sg);
    return [m, sig, m - sig];
  }],
  bb: [['series', 'length', 'mult'], (rt, k, s, l, m) => {
    const basis = sma(rt, k + '/m', s, l);
    const dev = num(m) * stdevImpl(rt, k + '/d', s, l, true);
    return [basis, basis + dev, basis - dev];
  }],
  bbw: [['series', 'length', 'mult'], (rt, k, s, l, m) => {
    const basis = sma(rt, k + '/m', s, l);
    const dev = num(m) * stdevImpl(rt, k + '/d', s, l, true);
    return ((basis + dev - (basis - dev)) / basis) * 100;
  }],
  kc: [['series', 'length', 'mult', 'useTrueRange'], (rt, k, s, l, m, useTr = true) => {
    const basis = ema(rt, k + '/m', s, l);
    const b = rt.bar;
    const range = useTr ? trueRange(rt, true) : rt.data.high[b] - rt.data.low[b];
    const r = ema(rt, k + '/r', range, l);
    return [basis, basis + r * m, basis - r * m];
  }],
  stoch: [['source', 'high', 'low', 'length'], (rt, k, s, h, lo, l) => {
    const hh = highestImpl(rt, k + '/h', h, l, false, false);
    const ll = highestImpl(rt, k + '/l', lo, l, false, true);
    return (100 * (num(s) - ll)) / (hh - ll);
  }],
  cci: [['source', 'length'], (rt, k, s, l) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, l);
    if (!w) return NaN;
    const mean = w.reduce((x, y) => x + y, 0) / l;
    const md = w.reduce((x, y) => x + Math.abs(y - mean), 0) / l;
    return (num(s) - mean) / (0.015 * md);
  }],
  mfi: [['series', 'length'], (rt, k, s, l) => {
    const a = hist(rt, k, 'src', num(s));
    const vol = rt.data.volume[rt.bar];
    const ch = num(s) - at(a, rt.bar - 1);
    const up = isNa(ch) ? NaN : (ch <= 0 ? 0 : vol * num(s));
    const dn = isNa(ch) ? NaN : (ch >= 0 ? 0 : vol * num(s));
    const U = hist(rt, k, 'up', up), D = hist(rt, k, 'dn', dn);
    const wu = windowVals(U, rt.bar, l), wd = windowVals(D, rt.bar, l);
    if (!wu || !wd) return NaN;
    const su = wu.reduce((x, y) => x + y, 0), sd = wd.reduce((x, y) => x + y, 0);
    return 100 - 100 / (1 + su / sd);
  }],
  wpr: [['length'], (rt, k, l) => {
    const hh = highestImpl(rt, k + '/h', rt.data.high[rt.bar], l, false, false);
    const ll = highestImpl(rt, k + '/l', rt.data.low[rt.bar], l, false, true);
    return (100 * (rt.data.close[rt.bar] - hh)) / (hh - ll);
  }],
  barssince: [['condition'], (rt, k, c) => {
    const o = st(rt, k);
    const last = o.last || (o.last = []);
    let v = at(last, rt.bar - 1);
    if (c) v = rt.bar;
    last[rt.bar] = v;
    return isNa(v) ? NaN : rt.bar - v;
  }],
  valuewhen: [['condition', 'source', 'occurrence'], (rt, k, c, s, occ = 0) => {
    const o = st(rt, k);
    if (!o.vals) o.vals = [];
    if (o.lastBar === rt.bar && o.pushed) o.vals.pop();
    o.lastBar = rt.bar;
    o.pushed = !!c;
    if (c) o.vals.push(s);
    const i = o.vals.length - 1 - Math.round(num(occ));
    return i >= 0 ? o.vals[i] : NaN;
  }],
  pivothigh: [['source', 'leftbars', 'rightbars'], (rt, k, s, lb, rb) => {
    if (rb === undefined) { rb = lb; lb = s; s = rt.data.high[rt.bar]; }
    const a = hist(rt, k, 'src', num(s));
    const c = rt.bar - rb;
    if (c - lb < 0) return NaN;
    const v = a[c];
    if (isNa(v)) return NaN;
    for (let i = c - lb; i <= rt.bar; i++) {
      if (i === c) continue;
      if (isNa(a[i]) || a[i] > v || (i > c && a[i] === v) || (i < c && a[i] === v)) return NaN;
    }
    return v;
  }],
  pivotlow: [['source', 'leftbars', 'rightbars'], (rt, k, s, lb, rb) => {
    if (rb === undefined) { rb = lb; lb = s; s = rt.data.low[rt.bar]; }
    const a = hist(rt, k, 'src', num(s));
    const c = rt.bar - rb;
    if (c - lb < 0) return NaN;
    const v = a[c];
    if (isNa(v)) return NaN;
    for (let i = c - lb; i <= rt.bar; i++) {
      if (i === c) continue;
      if (isNa(a[i]) || a[i] < v || a[i] === v) return NaN;
    }
    return v;
  }],
  supertrend: [['factor', 'atrPeriod'], (rt, k, factor, period) => {
    const b = rt.bar;
    const o = st(rt, k);
    const src = (rt.data.high[b] + rt.data.low[b]) / 2;
    const atrA = put(o, 'atr', b, rma(rt, k + '/atr', trueRange(rt, true), period));
    const atrV = atrA[b];
    let upper = src + factor * atrV;
    let lower = src - factor * atrV;
    const prevLower = at(o.lower || [], b - 1);
    const prevUpper = at(o.upper || [], b - 1);
    const pl = isNa(prevLower) ? 0 : prevLower;
    const pu = isNa(prevUpper) ? 0 : prevUpper;
    const prevClose = b > 0 ? rt.data.close[b - 1] : NaN;
    lower = lower > pl || prevClose < pl ? lower : pl;
    upper = upper < pu || prevClose > pu ? upper : pu;
    put(o, 'lower', b, lower);
    put(o, 'upper', b, upper);
    const prevSt = at(o.st || [], b - 1);
    let dir;
    if (isNa(at(atrA, b - 1))) dir = 1;
    else if (prevSt === prevUpper) dir = rt.data.close[b] > upper ? -1 : 1;
    else dir = rt.data.close[b] < lower ? 1 : -1;
    const stv = dir === -1 ? lower : upper;
    put(o, 'st', b, stv);
    return [stv, dir];
  }],
  dmi: [['diLength', 'adxSmoothing'], (rt, k, len, sm) => {
    const b = rt.bar, d = rt.data;
    const up = b > 0 ? d.high[b] - d.high[b - 1] : NaN;
    const down = b > 0 ? -(d.low[b] - d.low[b - 1]) : NaN;
    const plusDM = isNa(up) ? NaN : up > down && up > 0 ? up : 0;
    const minusDM = isNa(down) ? NaN : down > up && down > 0 ? down : 0;
    const trur = rma(rt, k + '/tr', trueRange(rt, false), len);
    const o = st(rt, k);
    let plus = (100 * rma(rt, k + '/p', plusDM, len)) / trur;
    let minus = (100 * rma(rt, k + '/m', minusDM, len)) / trur;
    if (isNa(plus)) plus = at(o.plus || [], b - 1);
    if (isNa(minus)) minus = at(o.minus || [], b - 1);
    put(o, 'plus', b, plus);
    put(o, 'minus', b, minus);
    const sum = plus + minus;
    const adx = 100 * rma(rt, k + '/adx', Math.abs(plus - minus) / (sum === 0 ? 1 : sum), sm);
    return [plus, minus, adx];
  }],
  vwap: [['source'], (rt, k, s) => {
    const b = rt.bar;
    const o = st(rt, k);
    const day = rt.dayKey ? rt.dayKey(rt.data.time[b]) : Math.floor(rt.data.time[b] / DAY_MS);
    const pv = num(s === undefined ? (rt.data.high[b] + rt.data.low[b] + rt.data.close[b]) / 3 : s) * rt.data.volume[b];
    const prevDay = at(o.day || [], b - 1);
    const reset = prevDay !== day;
    const cpv = (reset ? 0 : at(o.pv, b - 1)) + pv;
    const cv = (reset ? 0 : at(o.v, b - 1)) + rt.data.volume[b];
    put(o, 'day', b, day);
    put(o, 'pv', b, cpv);
    put(o, 'v', b, cv);
    return cpv / cv;
  }],
  sar: [['start', 'inc', 'max'], (rt, k, start, inc, max) => {
    const b = rt.bar, d = rt.data;
    const o = st(rt, k);
    const states = o.states || (o.states = []);
    if (b === 0) { states[0] = null; return NaN; }
    let { result, maxMin, accel, isBelow } = states[b - 1] || { result: NaN };
    let isFirstTrendBar = false;
    if (b === 1) {
      if (d.close[1] > d.close[0]) { isBelow = true; maxMin = d.high[1]; result = d.low[0]; }
      else { isBelow = false; maxMin = d.low[1]; result = d.high[0]; }
      isFirstTrendBar = true;
      accel = start;
    }
    result += accel * (maxMin - result);
    if (isBelow) {
      if (result > d.low[b]) {
        isFirstTrendBar = true; isBelow = false;
        result = Math.max(d.high[b], maxMin); maxMin = d.low[b]; accel = start;
      }
    } else if (result < d.high[b]) {
      isFirstTrendBar = true; isBelow = true;
      result = Math.min(d.low[b], maxMin); maxMin = d.high[b]; accel = start;
    }
    if (!isFirstTrendBar) {
      if (isBelow) {
        if (d.high[b] > maxMin) { maxMin = d.high[b]; accel = Math.min(accel + inc, max); }
      } else if (d.low[b] < maxMin) { maxMin = d.low[b]; accel = Math.min(accel + inc, max); }
    }
    if (isBelow) {
      result = Math.min(result, d.low[b - 1]);
      if (b > 1) result = Math.min(result, d.low[b - 2]);
    } else {
      result = Math.max(result, d.high[b - 1]);
      if (b > 1) result = Math.max(result, d.high[b - 2]);
    }
    states[b] = { result, maxMin, accel, isBelow };
    return result;
  }],
  linreg: [['source', 'length', 'offset'], (rt, k, s, l, off = 0) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, l);
    if (!w) return NaN;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let i = 0; i < l; i++) {
      const x = i, y = w[l - 1 - i];
      sx += x; sy += y; sxy += x * y; sxx += x * x;
    }
    const slope = (l * sxy - sx * sy) / (l * sxx - sx * sx);
    const intercept = (sy - slope * sx) / l;
    return intercept + slope * (l - 1 - off);
  }],
  median: [['source', 'length'], (rt, k, s, l) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    const w = windowVals(a, rt.bar, l);
    if (!w) return NaN;
    const srt = [...w].sort((x, y) => x - y);
    return l % 2 ? srt[(l - 1) / 2] : (srt[l / 2 - 1] + srt[l / 2]) / 2;
  }],
  percentrank: [['source', 'length'], (rt, k, s, l) => {
    l = Math.round(num(l));
    const a = hist(rt, k, 'src', num(s));
    if (rt.bar - l < 0) return NaN;
    let cnt = 0;
    for (let i = 1; i <= l; i++) if (a[rt.bar - i] <= a[rt.bar]) cnt++;
    return (100 * cnt) / l;
  }],
  correlation: [['source1', 'source2', 'length'], (rt, k, x, y, l) => {
    l = Math.round(num(l));
    const A = hist(rt, k, 'a', num(x)), B = hist(rt, k, 'b', num(y));
    const wa = windowVals(A, rt.bar, l), wb = windowVals(B, rt.bar, l);
    if (!wa || !wb) return NaN;
    const ma = wa.reduce((p, q) => p + q, 0) / l, mb = wb.reduce((p, q) => p + q, 0) / l;
    let cov = 0, va = 0, vb = 0;
    for (let i = 0; i < l; i++) {
      cov += (wa[i] - ma) * (wb[i] - mb);
      va += (wa[i] - ma) ** 2;
      vb += (wb[i] - mb) ** 2;
    }
    return cov / Math.sqrt(va * vb);
  }],
  tr: [['handle_na'], (rt, k, h = false) => trueRange(rt, h)],
};

// fixnan and math.sum need per-call-site state too; they live here.
export function fixnan(rt, key, v) {
  const o = st(rt, key);
  const out = o.out || (o.out = []);
  const r = isNa(v) ? at(out, rt.bar - 1) : v;
  out[rt.bar] = r;
  return r;
}
export function rollingSum(rt, key, s, l) {
  l = Math.round(num(l));
  const a = hist(rt, key, 'src', num(s));
  const w = windowVals(a, rt.bar, l);
  return w ? w.reduce((x, y) => x + y, 0) : NaN;
}

// Pine Script interpreter: runs the script once per bar, bar by bar, the way
// TradingView's runtime does, and drives the broker emulator.
import { parse } from './parser.js';
import { TA, isNa, fixnan, rollingSum, trueRange } from './ta.js';
import { Broker } from './broker.js';
import { computeMetrics } from './metrics.js';

export class PineRuntimeError extends Error {
  constructor(message, line) {
    super(line ? `line ${line}: ${message}` : message);
    this.name = 'PineRuntimeError';
    this.line = line;
  }
}

class BreakSignal {}
class ContinueSignal {}
const BREAK = new BreakSignal();
const CONTINUE = new ContinueSignal();

class Scope {
  constructor(parent) { this.parent = parent; this.vars = null; }
  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.vars) {
        const v = s.vars.get(name);
        if (v) return v;
      }
    }
    return null;
  }
  set(name, slot) { (this.vars || (this.vars = new Map())).set(name, slot); }
}

// ---------------------------------------------------------------- colors
const NAMED_COLORS = {
  aqua: '#00BCD4', black: '#363A45', blue: '#2196F3', fuchsia: '#E040FB', gray: '#787B86',
  green: '#4CAF50', lime: '#00E676', maroon: '#880E4F', navy: '#311B92', olive: '#808000',
  orange: '#FF9800', purple: '#9C27B0', red: '#FF5252', silver: '#B2B5BE', teal: '#00897B',
  white: '#FFFFFF', yellow: '#FFEB3B',
};
function parseColor(c) {
  if (typeof c !== 'string') return null;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
}
const hex2 = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
function makeColor(r, g, b, transp = 0) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${hex2(255 * (1 - (isNa(transp) ? 0 : transp) / 100))}`.toUpperCase();
}

// ------------------------------------------------------------- time utils
const fmtCache = new Map();
const partsCache = new Map();
export function timeParts(ms, tz) {
  const key = `${tz}|${ms}`;
  let p = partsCache.get(key);
  if (!p) {
    if (partsCache.size > 4096) partsCache.clear();
    p = timePartsUncached(ms, tz);
    partsCache.set(key, p);
  }
  return p;
}
function timePartsUncached(ms, tz) {
  if (!tz || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT') return utcParts(ms);
  const off = /^(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(tz);
  if (off) {
    const mins = (off[1] === '-' ? -1 : 1) * (+off[2] * 60 + +(off[3] || 0));
    return utcParts(ms + mins * 60000);
  }
  // the UTC offset only changes on DST switches: look it up once per hour
  const hourKey = `${tz}|${Math.floor(ms / 3600000)}`;
  let offset = offsetCache.get(hourKey);
  if (offset === undefined) {
    const q = intlParts(Math.floor(ms / 3600000) * 3600000, tz);
    offset = Date.UTC(q.y, q.mo - 1, q.d, q.h, q.mi, q.s) - Math.floor(ms / 3600000) * 3600000;
    if (offsetCache.size > 20000) offsetCache.clear();
    offsetCache.set(hourKey, offset);
  }
  return utcParts(ms + offset);
}
const offsetCache = new Map();
function intlParts(ms, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) + 1;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd };
}
function utcParts(ms) {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(),
    mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay() + 1,
  };
}
export function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const p = timeParts(guess, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return guess - (asUtc - guess);
}
function weekOfYear(ms) {
  const d = new Date(ms);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = (new Date(t).getUTCDay() + 6) % 7;
  const thursday = t - day * 86400000 + 3 * 86400000;
  const firstThursday = Date.UTC(new Date(thursday).getUTCFullYear(), 0, 4);
  return 1 + Math.round((thursday - firstThursday) / 604800000 - ((new Date(firstThursday).getUTCDay() + 6) % 7 - 3) / 7);
}

// ------------------------------------------------------------- constants
const CONSTANTS = {
  na: NaN,
  'strategy.long': 'long', 'strategy.short': 'short',
  'strategy.fixed': 'fixed', 'strategy.cash': 'cash', 'strategy.percent_of_equity': 'percent_of_equity',
  'strategy.commission.percent': 'percent', 'strategy.commission.cash_per_contract': 'cash_per_contract',
  'strategy.commission.cash_per_order': 'cash_per_order',
  'strategy.direction.all': 'all', 'strategy.direction.long': 'long', 'strategy.direction.short': 'short',
  'strategy.oca.none': 'none', 'strategy.oca.cancel': 'cancel', 'strategy.oca.reduce': 'reduce',
  'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.618033988749895,
  'dayofweek.sunday': 1, 'dayofweek.monday': 2, 'dayofweek.tuesday': 3, 'dayofweek.wednesday': 4,
  'dayofweek.thursday': 5, 'dayofweek.friday': 6, 'dayofweek.saturday': 7,
  'barmerge.gaps_on': true, 'barmerge.gaps_off': false, 'barmerge.lookahead_on': true, 'barmerge.lookahead_off': false,
  'order.ascending': 'asc', 'order.descending': 'desc',
};
for (const [k, v] of Object.entries(NAMED_COLORS)) CONSTANTS[`color.${k}`] = v;
for (const s of ['line', 'linebr', 'stepline', 'stepline_diamond', 'histogram', 'columns', 'circles', 'cross', 'area', 'areabr', 'steplinebr'])
  CONSTANTS[`plot.style_${s}`] = s;
for (const s of ['triangleup', 'triangledown', 'arrowup', 'arrowdown', 'labelup', 'labeldown', 'circle', 'cross', 'xcross', 'diamond', 'square', 'flag'])
  CONSTANTS[`shape.${s}`] = s;
for (const s of ['abovebar', 'belowbar', 'top', 'bottom', 'absolute']) CONSTANTS[`location.${s}`] = s;
for (const s of ['auto', 'tiny', 'small', 'normal', 'large', 'huge']) CONSTANTS[`size.${s}`] = s;
const PREFIX_CONSTANTS = ['display.', 'line.style_', 'hline.style_', 'extend.', 'xloc.', 'yloc.', 'label.style_', 'text.align_',
  'text.wrap_', 'position.', 'format.', 'scale.', 'alert.freq_', 'font.family_', 'currency.', 'session.', 'adjustment.',
  'plot.linestyle_', 'splits.', 'dividends.', 'earnings.', 'shape.', 'location.', 'size.'];

// Names of the built-in price series, for input.source.
export const SOURCES = ['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4'];

const TICKS = [1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.02, 0.01, 0.005, 0.0025, 0.001, 0.0005, 0.00025, 0.0001,
  0.00005, 0.00001, 0.000001, 0.0000001, 0.00000001];
export function inferMintick(data) {
  const n = Math.min(data.close.length, 2000);
  const prices = [];
  for (let i = 0; i < n; i++) prices.push(data.open[i], data.high[i], data.low[i], data.close[i]);
  for (const tk of TICKS) {
    if (prices.every((p) => Math.abs(p / tk - Math.round(p / tk)) < 1e-6)) return tk;
  }
  return 0.00000001;
}

function inferTimeframe(time) {
  const diffs = [];
  for (let i = 1; i < Math.min(time.length, 200); i++) diffs.push(time[i] - time[i - 1]);
  diffs.sort((a, b) => a - b);
  const sec = (diffs[Math.floor(diffs.length / 2)] || 86400000) / 1000;
  if (sec >= 28 * 86400) return { period: 'M', seconds: 2628003, mult: 1, unit: 'M' };
  if (sec >= 7 * 86400) return { period: 'W', seconds: 604800, mult: 1, unit: 'W' };
  if (sec >= 86400) return { period: 'D', seconds: 86400, mult: 1, unit: 'D' };
  if (sec >= 60) { const m = Math.round(sec / 60); return { period: String(m), seconds: m * 60, mult: m, unit: '' }; }
  return { period: `${Math.round(sec)}S`, seconds: Math.round(sec), mult: Math.round(sec), unit: 'S' };
}

function fmtNumber(v, fmt, mintick) {
  if (isNa(v)) return 'NaN';
  if (typeof v !== 'number') return String(v);
  if (fmt === 'mintick') return v.toFixed(Math.min(8, mintick.toFixed(10).replace(/0+$/, '').split('.')[1]?.length || 0));
  if (fmt === 'percent') return `${v.toFixed(2)}%`;
  if (fmt === 'volume') return Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(2);
  if (typeof fmt === 'string' && /^[#0,]*\.?[#0]*$/.test(fmt) && fmt.length) {
    const dec = fmt.includes('.') ? fmt.split('.')[1].length : 0;
    const req = fmt.includes('.') ? (fmt.split('.')[1].match(/0/g) || []).length : 0;
    let s = v.toFixed(dec);
    if (dec > req && s.includes('.')) s = s.replace(new RegExp(`0{0,${dec - req}}$`), '').replace(/\.$/, '');
    return s;
  }
  if (Number.isInteger(v)) return String(v);
  return String(+v.toFixed(8));
}

// ------------------------------------------------------------------ runtime
export class Runtime {
  constructor(source, data, options = {}) {
    this.ast = typeof source === 'string' ? parse(source) : source;
    this.data = data;
    this.n = data.close.length;
    this.opts = options;
    this.inputOverrides = options.inputs || {};
    this.tz = options.timezone || 'UTC';
    // where higher-timeframe bars and daily resets start (see sessionBucket)
    this.session = options.session || { tz: this.tz, start: 0 };
    this.mintick = options.mintick || inferMintick(data);
    this.pointvalue = options.pointvalue || 1;
    this.tf = options.timeframe ? { ...inferTimeframe(data.time), period: options.timeframe } : inferTimeframe(data.time);
    this.symbol = options.symbol || 'SYMBOL';
    this.slots = new Map();
    this.varSlots = [];
    this.exprHist = new Map();
    this.taState = new Map();
    this.functions = new Map();
    this.inputs = new Map();
    this.inputCache = new Map();
    this.plots = new Map();
    this.shapes = new Map();
    this.hlines = new Map();
    this.bgcolors = null;
    this.barcolors = null;
    this.broker = null;
    this.declaration = null;
    this.stratHist = {};
    this.logs = [];
    this.depth = 0;
    this.bar = 0;
    this.types = new Map();
    this.securities = new Map();
    for (const s of this.ast.body) {
      if (s.type === 'FuncDef') this.functions.set(s.name, s);
      if (s.type === 'TypeDef') this.types.set(s.name, s.fields);
    }
    // Only variables that the script reads with the history operator need per-bar history.
    this.histNames = new Set();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.type === 'History' && node.target.type === 'Ident') this.histNames.add(node.target.name);
      for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
    };
    walk(this.ast.body);
    this.builtins = buildBuiltins(this);
  }

  // -------------------------------------------------------------- run loop
  run() {
    const t0 = Date.now();
    const progress = this.opts.onProgress;
    for (let b = 0; b < this.n; b++) {
      this.bar = b;
      if (progress && b % 2000 === 0) progress(b, this.n);
      if (this.broker && b > 0) this.broker.processBar(b);
      this.globalScope = new Scope(null);
      const ctx = { path: '', scope: this.globalScope };
      for (const stmt of this.ast.body) {
        if (stmt.type === 'FuncDef' || stmt.type === 'TypeDef') continue;
        this.exec(stmt, ctx);
      }
      for (const s of this.varSlots) if (s.hist) s.hist[b] = s.value;
      if (this.broker) {
        this.snapshotStrategy(b);
        this.broker.processOnClose(b);
        this.broker.endBar(b);
      }
    }
    return this.results(Date.now() - t0);
  }

  results(ms) {
    const decl = this.declaration || { kind: 'indicator', title: 'Script', overlay: false };
    const out = {
      kind: decl.kind,
      title: decl.title,
      overlay: decl.overlay,
      mintick: this.mintick,
      pointvalue: this.pointvalue,
      timeframe: this.tf.period,
      inputs: [...this.inputs.values()],
      plots: [...this.plots.values()],
      shapes: [...this.shapes.values()],
      hlines: [...this.hlines.values()],
      bgcolors: this.bgcolors,
      barcolors: this.barcolors,
      logs: this.logs,
      elapsedMs: ms,
      strategy: null,
    };
    if (this.broker) {
      const br = this.broker;
      const last = this.data.close[br.lastBar ?? this.n - 1];
      out.strategy = {
        range: { firstBar: br.firstBar, lastBar: br.lastBar },
        config: br.cfg,
        declared: br.declared || br.cfg,
        trades: br.closed,
        openTrades: br.open.map((t) => ({
          entryId: t.entryId, dir: t.dir, qty: t.qty, entryPrice: t.entryPrice, entryBar: t.entryBar,
          entryTime: t.entryTime, entryComment: t.entryComment,
          profit: t.dir * (last - t.entryPrice) * t.qty * br.pv - t.entryCommission,
        })),
        fills: br.fills,
        equity: br.equity,
        metrics: computeMetrics(br, this.data),
      };
    }
    return out;
  }

  // trading-day number of a timestamp (session-anchored), used by ta.vwap
  dayKey(t) { return sessionBucket(t, 86400, this.session, ''); }

  snapshotStrategy(b) {
    const br = this.broker;
    const vals = {
      'strategy.position_size': br.positionSize,
      'strategy.position_avg_price': br.positionAvgPrice,
      'strategy.equity': br.equityAt(this.data.close[b]),
      'strategy.netprofit': br.realized,
      'strategy.openprofit': br.openProfit(this.data.close[b]),
      'strategy.opentrades': br.open.length,
      'strategy.closedtrades': br.closed.length,
    };
    for (const [k, v] of Object.entries(vals)) (this.stratHist[k] || (this.stratHist[k] = []))[b] = v;
  }

  // ------------------------------------------------------------ variables
  builtinVar(name, bar) {
    const d = this.data;
    if (bar < 0) return undefined;
    switch (name) {
      case 'open': return d.open[bar];
      case 'high': return d.high[bar];
      case 'low': return d.low[bar];
      case 'close': return d.close[bar];
      case 'volume': return d.volume[bar];
      case 'time': return d.time[bar];
      case 'time_close': return d.time[bar] + this.tf.seconds * 1000;
      case 'time_tradingday': return d.time[bar];
      case 'timenow': return Date.now();
      case 'bar_index': return bar;
      case 'last_bar_index': return this.n - 1;
      case 'last_bar_time': return d.time[this.n - 1];
      case 'hl2': return (d.high[bar] + d.low[bar]) / 2;
      case 'hlc3': return (d.high[bar] + d.low[bar] + d.close[bar]) / 3;
      case 'ohlc4': return (d.open[bar] + d.high[bar] + d.low[bar] + d.close[bar]) / 4;
      case 'hlcc4': return (d.high[bar] + d.low[bar] + 2 * d.close[bar]) / 4;
      case 'year': return timeParts(d.time[bar], this.tz).y;
      case 'month': return timeParts(d.time[bar], this.tz).mo;
      case 'dayofmonth': return timeParts(d.time[bar], this.tz).d;
      case 'dayofweek': return timeParts(d.time[bar], this.tz).wd;
      case 'hour': return timeParts(d.time[bar], this.tz).h;
      case 'minute': return timeParts(d.time[bar], this.tz).mi;
      case 'second': return timeParts(d.time[bar], this.tz).s;
      case 'weekofyear': return weekOfYear(d.time[bar]);
      case 'barstate.isfirst': return bar === 0;
      case 'barstate.islast': return bar === this.n - 1;
      case 'barstate.islastconfirmedhistory': return bar === this.n - 1;
      case 'barstate.isconfirmed': case 'barstate.ishistory': case 'barstate.isnew': return true;
      case 'barstate.isrealtime': return false;
      case 'syminfo.ticker': case 'syminfo.tickerid': case 'syminfo.description': return this.symbol;
      case 'syminfo.prefix': return '';
      case 'syminfo.mintick': return this.mintick;
      case 'syminfo.pointvalue': return this.pointvalue;
      case 'syminfo.currency': return this.opts.currency || 'USD';
      case 'syminfo.basecurrency': return '';
      case 'syminfo.timezone': return this.tz;
      case 'syminfo.type': return 'crypto';
      case 'syminfo.session': return 'regular';
      case 'timeframe.period': return this.tf.period;
      case 'timeframe.multiplier': return this.tf.mult;
      case 'timeframe.isintraday': return this.tf.seconds < 86400;
      case 'timeframe.isdaily': return this.tf.period === 'D';
      case 'timeframe.isweekly': return this.tf.period === 'W';
      case 'timeframe.ismonthly': return this.tf.period === 'M';
      case 'timeframe.isdwm': return this.tf.seconds >= 86400;
      case 'timeframe.isminutes': return this.tf.unit === '';
      case 'timeframe.isseconds': return this.tf.unit === 'S';
      case 'timeframe.isticks': return false;
      // computed built-ins: only the current bar is available here; history
      // references to them go through the generic per-expression history.
      case 'ta.tr': return bar === this.bar ? trueRange(this, false) : NaN;
      case 'ta.vwap': return bar === this.bar ? TA.vwap[1](this, '__vwap', undefined) : NaN;
      case 'ta.obv': return bar === this.bar ? this.obv() : NaN;
      case 'strategy.initial_capital': return this.broker ? this.broker.cfg.initial_capital : NaN;
      case 'strategy.grossprofit': return this.broker ? this.broker.closed.filter((t) => t.profit > 0).reduce((s, t) => s + t.profit, 0) : NaN;
      case 'strategy.grossloss': return this.broker ? -this.broker.closed.filter((t) => t.profit <= 0).reduce((s, t) => s + t.profit, 0) : NaN;
      case 'strategy.wintrades': return this.broker ? this.broker.closed.filter((t) => t.profit > 0).length : NaN;
      case 'strategy.losstrades': return this.broker ? this.broker.closed.filter((t) => t.profit < 0).length : NaN;
      case 'strategy.eventrades': return this.broker ? this.broker.closed.filter((t) => t.profit === 0).length : NaN;
      case 'strategy.max_drawdown': return this.broker ? this.broker.maxDD : NaN;
      case 'strategy.max_runup': return this.broker ? this.broker.maxRunup : NaN;
      case 'strategy.position_entry_name': return this.broker && this.broker.open.length ? this.broker.open[0].entryId : '';
      case 'strategy.account_currency': return this.opts.currency || 'USD';
      default: break;
    }
    if (name.startsWith('strategy.') && this.broker) {
      if (bar === this.bar) {
        const br = this.broker;
        switch (name) {
          case 'strategy.position_size': return br.positionSize;
          case 'strategy.position_avg_price': return br.positionAvgPrice;
          case 'strategy.equity': return br.equityAt(this.data.close[bar]);
          case 'strategy.netprofit': return br.realized;
          case 'strategy.openprofit': return br.openProfit(this.data.close[bar]);
          case 'strategy.opentrades': return br.open.length;
          case 'strategy.closedtrades': return br.closed.length;
          default: break;
        }
      } else if (this.stratHist[name]) {
        const v = this.stratHist[name][bar];
        return v === undefined ? NaN : v;
      }
    }
    if (name.startsWith('strategy.') && !this.broker &&
      ['strategy.position_size', 'strategy.opentrades', 'strategy.closedtrades', 'strategy.netprofit', 'strategy.equity'].includes(name)) return 0;
    return undefined;
  }

  obv() {
    const s = this.taState.get('__obv') || { out: [] };
    this.taState.set('__obv', s);
    const b = this.bar, d = this.data;
    const prev = b > 0 && s.out[b - 1] !== undefined ? s.out[b - 1] : 0;
    const ch = b > 0 ? Math.sign(d.close[b] - d.close[b - 1]) : 0;
    s.out[b] = prev + ch * d.volume[b];
    return s.out[b];
  }

  slotAt(slot, off) {
    if (off === 0) return slot.value;
    if (!slot.hist) return NaN;
    const idx = this.bar - off;
    if (idx < 0) return NaN;
    let v = slot.hist[idx];
    if (v === undefined) {
      for (let j = idx - 1; j >= 0 && j >= idx - 5000; j--) {
        if (slot.hist[j] !== undefined) { v = slot.hist[j]; break; }
      }
    }
    return v === undefined ? NaN : v;
  }

  getSlot(key, isVar, name) {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { value: NaN, hist: name === undefined || this.histNames.has(name) ? [] : null, isVar, init: false, isInt: false };
      this.slots.set(key, slot);
      if (isVar) this.varSlots.push(slot);
    }
    return slot;
  }

  lookupIdent(n, ctx) {
    const slot = ctx.scope.lookup(n.name);
    if (slot) return slot.value;
    const dot = n.name.indexOf('.');
    if (dot > 0) {
      const base = ctx.scope.lookup(n.name.slice(0, dot));
      if (base) return this.getField(base.value, n.name.slice(dot + 1).split('.'), n);
    }
    const v = this.builtinVar(n.name, this.bar);
    if (v !== undefined) return v;
    if (n.name in CONSTANTS) return CONSTANTS[n.name];
    if (PREFIX_CONSTANTS.some((p) => n.name.startsWith(p))) {
      if (n.name === 'format.mintick') return 'mintick';
      if (n.name.startsWith('format.')) return n.name.slice(7);
      return n.name;
    }
    if (this.functions.has(n.name) || this.builtins[n.name]) return n.name; // function reference
    throw new PineRuntimeError(`Undeclared identifier '${n.name}'`, n.line);
  }

  getField(obj, path, n) {
    let v = obj;
    for (const f of path) {
      if (isNa(v)) return NaN; // field of an na object
      if (!v || !v.__udt) throw new PineRuntimeError(`'${n.name}' is not a field of a user-defined type`, n.line);
      if (!(f in v)) throw new PineRuntimeError(`type ${v.__udt} has no field '${f}'`, n.line);
      v = v[f];
    }
    return v;
  }

  setSlot(slot, v) {
    if (slot.isInt && typeof v === 'number') v = Math.trunc(v);
    slot.value = v;
    if (slot.hist) slot.hist[this.bar] = v;
    return v;
  }

  // ----------------------------------------------------------- statements
  exec(s, ctx) {
    try {
      return this.execInner(s, ctx);
    } catch (e) {
      if (e === BREAK || e === CONTINUE) throw e;
      if (!e.line && (e instanceof Error)) {
        const err = new PineRuntimeError(e.message, s.line);
        throw err;
      }
      throw e;
    }
  }

  execInner(s, ctx) {
    switch (s.type) {
      case 'VarDecl': {
        const key = ctx.path ? `${ctx.path}#${s.id}` : s.id;
        const isVar = !!s.mode;
        const slot = this.getSlot(key, isVar, s.name);
        slot.isInt = s.varType === 'int';
        if (!isVar || !slot.init) {
          this.setSlot(slot, this.evalRhs(s.init, ctx));
          slot.init = true;
        } else if (slot.hist) slot.hist[this.bar] = slot.value;
        ctx.scope.set(s.name, slot);
        return slot.value;
      }
      case 'TupleDecl': {
        let v = this.evalRhs(s.init, ctx);
        if (!Array.isArray(v)) {
          if (!isNa(v)) throw new PineRuntimeError('right side of tuple assignment must return a tuple', s.line);
          v = s.names.map(() => NaN); // e.g. request.security before its first higher-timeframe bar
        }
        s.names.forEach((name, i) => {
          if (name === '_') return;
          let slot;
          if (s.reassign) {
            slot = ctx.scope.lookup(name);
            if (!slot) throw new PineRuntimeError(`Undeclared identifier '${name}'`, s.line);
          } else {
            slot = this.getSlot(`${ctx.path}#${s.id}:${i}`, false, name);
            ctx.scope.set(name, slot);
          }
          this.setSlot(slot, v[i]);
        });
        return v;
      }
      case 'Assign': {
        const dot = s.name.indexOf('.');
        if (dot > 0 && !ctx.scope.lookup(s.name)) {
          // obj.field := value
          const base = ctx.scope.lookup(s.name.slice(0, dot));
          if (!base) throw new PineRuntimeError(`Undeclared identifier '${s.name.slice(0, dot)}'`, s.line);
          const path = s.name.slice(dot + 1).split('.');
          const field = path.pop();
          const obj = path.length ? this.getField(base.value, path, s) : base.value;
          if (isNa(obj)) throw new PineRuntimeError(`Cannot assign '${s.name}': the object is na`, s.line);
          if (!obj.__udt || !(field in obj)) throw new PineRuntimeError(`'${s.name}' is not a field of a user-defined type`, s.line);
          let v = this.evalRhs(s.value, ctx);
          if (s.op !== ':=') v = this.binary(s.op[0], obj[field], v);
          if (obj.__int && obj.__int.has(field) && typeof v === 'number') v = Math.trunc(v);
          obj[field] = v;
          return v;
        }
        const slot = ctx.scope.lookup(s.name);
        if (!slot) throw new PineRuntimeError(`Undeclared identifier '${s.name}' (declare it with '=' before using ':=')`, s.line);
        let v = this.evalRhs(s.value, ctx);
        if (s.op !== ':=') v = this.binary(s.op[0], slot.value, v);
        return this.setSlot(slot, v);
      }
      case 'TypeDef': return NaN;
      case 'ExprStmt': return this.eval(s.expr, ctx);
      case 'If': return this.evalIf(s, ctx);
      case 'Switch': return this.evalSwitch(s, ctx);
      case 'For': return this.execFor(s, ctx);
      case 'ForIn': return this.execForIn(s, ctx);
      case 'While': {
        let v = NaN;
        let guard = 0;
        while (this.truthy(this.eval(s.test, ctx))) {
          if (++guard > 500000) throw new PineRuntimeError('loop takes too long', s.line);
          try { v = this.execBlock(s.body, ctx); } catch (e) {
            if (e === BREAK) break;
            if (e === CONTINUE) continue;
            throw e;
          }
        }
        return v;
      }
      case 'Break': throw BREAK;
      case 'Continue': throw CONTINUE;
      case 'FuncDef': this.functions.set(s.name, s); return NaN;
      default: throw new PineRuntimeError(`cannot execute ${s.type}`, s.line);
    }
  }

  evalRhs(n, ctx) {
    if (n.type === 'If') return this.evalIf(n, ctx);
    if (n.type === 'Switch') return this.evalSwitch(n, ctx);
    return this.eval(n, ctx);
  }

  execBlock(block, ctx) {
    const inner = { path: ctx.path, scope: new Scope(ctx.scope) };
    let v = NaN;
    for (const s of block.body) v = this.exec(s, inner);
    return v;
  }

  evalIf(n, ctx) {
    if (this.truthy(this.eval(n.test, ctx))) return this.execBlock(n.consequent, ctx);
    if (n.alternate) {
      if (n.alternate.type === 'If') return this.evalIf(n.alternate, ctx);
      return this.execBlock(n.alternate, ctx);
    }
    return NaN;
  }

  evalSwitch(n, ctx) {
    const disc = n.discriminant ? this.eval(n.discriminant, ctx) : undefined;
    for (const c of n.cases) {
      if (c.test === null) return this.execBlock(c.body, ctx);
      const tv = this.eval(c.test, ctx);
      const match = n.discriminant ? tv === disc : this.truthy(tv);
      if (match) return this.execBlock(c.body, ctx);
    }
    return NaN;
  }

  execFor(s, ctx) {
    const from = this.eval(s.from, ctx);
    const to = this.eval(s.to, ctx);
    if (isNa(from) || isNa(to)) return NaN;
    let step = s.step ? Math.abs(this.eval(s.step, ctx)) : 1;
    if (!(step > 0)) step = 1;
    const dir = to >= from ? 1 : -1;
    const loopScope = new Scope(ctx.scope);
    const slot = this.getSlot(`${ctx.path}#for${s.id}`, false, s.var);
    loopScope.set(s.var, slot);
    const inner = { path: ctx.path, scope: loopScope };
    let v = NaN;
    let guard = 0;
    for (let i = from; dir > 0 ? i <= to : i >= to; i += dir * step) {
      if (++guard > 500000) throw new PineRuntimeError('loop takes too long', s.line);
      slot.value = i;
      try { v = this.execBlock(s.body, inner); } catch (e) {
        if (e === BREAK) break;
        if (e === CONTINUE) continue;
        throw e;
      }
    }
    return v;
  }

  execForIn(s, ctx) {
    const arr = this.eval(s.iterable, ctx);
    const items = arr && arr.__array ? [...arr.items] : Array.isArray(arr) ? arr : [];
    const loopScope = new Scope(ctx.scope);
    const itemSlot = this.getSlot(`${ctx.path}#forin${s.id}`, false, s.item);
    const idxSlot = this.getSlot(`${ctx.path}#forinidx${s.id}`, false, s.index || '');
    loopScope.set(s.item, itemSlot);
    if (s.index) loopScope.set(s.index, idxSlot);
    const inner = { path: ctx.path, scope: loopScope };
    let v = NaN;
    for (let i = 0; i < items.length; i++) {
      itemSlot.value = items[i];
      idxSlot.value = i;
      try { v = this.execBlock(s.body, inner); } catch (e) {
        if (e === BREAK) break;
        if (e === CONTINUE) continue;
        throw e;
      }
    }
    return v;
  }

  // ---------------------------------------------------------- expressions
  truthy(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return !Number.isNaN(v) && v !== 0;
    return !isNa(v) && v !== '';
  }

  binary(op, a, b) {
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return `${isNa(a) ? 'NaN' : a}${isNa(b) ? 'NaN' : b}`;
        return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return a / b;
      case '%': return a % b;
      case '<': return !isNa(a) && !isNa(b) && a < b;
      case '>': return !isNa(a) && !isNa(b) && a > b;
      case '<=': return !isNa(a) && !isNa(b) && a <= b;
      case '>=': return !isNa(a) && !isNa(b) && a >= b;
      case '==': return !isNa(a) && !isNa(b) && a === b;
      case '!=': return !isNa(a) && !isNa(b) && a !== b;
      default: throw new Error(`unknown operator ${op}`);
    }
  }

  eval(n, ctx) {
    switch (n.type) {
      case 'Num': case 'Str': case 'Bool': case 'Color': return n.value;
      case 'Ident': return this.lookupIdent(n, ctx);
      case 'Call': return this.evalCall(n, ctx);
      case 'History': return this.evalHistory(n, ctx);
      case 'Unary': {
        const v = this.eval(n.arg, ctx);
        if (n.op === 'not') return !this.truthy(v);
        return n.op === '-' ? -v : +v;
      }
      case 'Binary': return this.binary(n.op, this.eval(n.left, ctx), this.eval(n.right, ctx));
      case 'Logical': {
        const l = this.truthy(this.eval(n.left, ctx));
        if (n.op === 'and') return l && this.truthy(this.eval(n.right, ctx));
        return l || this.truthy(this.eval(n.right, ctx));
      }
      case 'Ternary': return this.truthy(this.eval(n.test, ctx)) ? this.eval(n.cons, ctx) : this.eval(n.alt, ctx);
      case 'Tuple': return n.items.map((x) => this.eval(x, ctx));
      case 'If': return this.evalIf(n, ctx);
      case 'Switch': return this.evalSwitch(n, ctx);
      default: throw new PineRuntimeError(`cannot evaluate ${n.type}`, n.line);
    }
  }

  evalHistory(n, ctx) {
    const off = Math.round(this.eval(n.offset, ctx));
    if (isNa(off) || off < 0) throw new PineRuntimeError('history reference offset must be a non-negative number', n.line);
    const t = n.target;
    if (t.type === 'Ident') {
      const slot = ctx.scope.lookup(t.name);
      if (slot) return this.slotAt(slot, off);
      if (!t.name.startsWith('ta.') && this.builtinVar(t.name, this.bar) !== undefined) {
        const v = this.builtinVar(t.name, this.bar - off);
        return v === undefined ? NaN : v;
      }
    }
    // generic: keep a per-call-site history of the expression's value
    const key = `${ctx.path}:h${n.id}`;
    let arr = this.exprHist.get(key);
    if (!arr) { arr = []; this.exprHist.set(key, arr); }
    const v = this.eval(t, ctx);
    arr[this.bar] = v;
    const i = this.bar - off;
    if (i < 0) return NaN;
    return arr[i] === undefined ? NaN : arr[i];
  }

  callKey(n, ctx) {
    return ctx.path ? `${ctx.path}:${n.id}` : n.id;
  }

  evalCall(n, ctx) {
    let name = n.callee;
    if (n.method) {
      const obj = this.eval(n.args[0], ctx);
      if (obj && obj.__udt) return this.udtMethod(obj, name, n);
      const prefix = obj && obj.__array ? 'array.' : typeof obj === 'string' ? 'str.' : 'math.';
      return this.callBuiltin(prefix + name, n, ctx, [obj, ...n.args.slice(1).map((a) => this.eval(a, ctx))]);
    }
    const user = this.functions.get(name);
    if (user) return this.callUser(user, n, ctx);
    if (name === 'request.security') return this.evalSecurity(n, ctx);
    if (name === 'runtime.error') throw new PineRuntimeError(`the script stopped itself (runtime.error): ${this.eval(n.args[0] || n.named.message, ctx)}`, n.line);
    const tdot = name.lastIndexOf('.');
    if (tdot > 0 && this.types.has(name.slice(0, tdot))) return this.udtCall(name.slice(0, tdot), name.slice(tdot + 1), n, ctx);
    if (this.builtins[name]) {
      // inputs can't change during a run: evaluate them once per call site
      if (name === 'input' || name.startsWith('input.')) {
        const key = this.callKey(n, ctx);
        const c = this.inputCache.get(key);
        if (c !== undefined) return c.source ? this.builtinVar(c.source, this.bar) : c.value;
        const value = this.callBuiltin(name, n, ctx);
        const inp = this.inputs.get(key);
        const src = inp && inp.type === 'source' ? (SOURCES.includes(this.inputOverrides[inp.key]) ? this.inputOverrides[inp.key] : inp.defval) : null;
        this.inputCache.set(key, { value, source: src });
        return value;
      }
      return this.callBuiltin(name, n, ctx);
    }
    // method-call syntax on a variable: myArray.push(x)
    const dot = name.indexOf('.');
    if (dot > 0) {
      const slot = ctx.scope.lookup(name.slice(0, dot));
      if (slot) {
        const obj = slot.value;
        const rest = name.slice(dot + 1);
        if (obj && obj.__udt) return this.udtMethod(obj, rest, n);
        const prefix = obj && obj.__array ? 'array.' : typeof obj === 'string' ? 'str.' : 'math.';
        return this.callBuiltin(prefix + rest, n, ctx, [obj, ...n.args.map((a) => this.eval(a, ctx))]);
      }
    }
    if (/^(label|line|box|table|linefill|polyline|chart\.point|log)\./.test(name) || name === 'alert' || name === 'alertcondition' || name === 'fill' || name === 'library') {
      for (const a of n.args) this.eval(a, ctx);
      return NaN;
    }
    if (name.startsWith('request.')) {
      throw new PineRuntimeError(`${name}() is not supported yet`, n.line);
    }
    throw new PineRuntimeError(`Could not find function or function reference '${name}'`, n.line);
  }

  // ---- user-defined types
  udtCall(type, method, n, ctx) {
    const fields = this.types.get(type);
    if (method === 'new') {
      const obj = { __udt: type, __int: new Set(fields.filter((f) => f.type === 'int').map((f) => f.name)) };
      fields.forEach((f, i) => {
        let v;
        if (i < n.args.length) v = this.eval(n.args[i], ctx);
        else if (n.named[f.name]) v = this.eval(n.named[f.name], ctx);
        else if (f.def) v = this.eval(f.def, ctx);
        else v = NaN;
        obj[f.name] = f.type === 'int' && typeof v === 'number' ? Math.trunc(v) : v;
      });
      return obj;
    }
    if (method === 'copy') return this.udtMethod(this.eval(n.args[0], ctx), 'copy', n);
    throw new PineRuntimeError(`${type}.${method}() is not supported`, n.line);
  }

  udtMethod(obj, method, n) {
    if (method === 'copy') return isNa(obj) ? NaN : { ...obj };
    throw new PineRuntimeError(`method '${method}' is not supported on type ${obj.__udt}`, n.line);
  }

  // ---- request.security on the chart's own symbol at a higher timeframe.
  // Higher-timeframe bars are built from the chart's bars. With
  // lookahead=barmerge.lookahead_on every chart bar sees the value of the
  // higher-timeframe bar it belongs to; with lookahead off it sees the last
  // completed one (what TradingView shows on historical bars).
  evalSecurity(n, ctx) {
    const arg = (i, name) => (i < n.args.length ? n.args[i] : n.named[name]);
    const tfNode = arg(1, 'timeframe');
    const exprNode = arg(2, 'expression');
    if (!exprNode) throw new PineRuntimeError('request.security() needs an expression', n.line);
    const lookNode = arg(4, 'lookahead');
    const lookahead = lookNode ? this.truthy(this.eval(lookNode, ctx)) : false;
    const tfRaw = tfNode ? this.eval(tfNode, ctx) : '';
    const tf = tfRaw === '' || isNa(tfRaw) ? this.tf.period : String(tfRaw);
    const secs = tfSeconds(tf);
    if (secs <= this.tf.seconds) return this.eval(exprNode, ctx); // same (or lower) timeframe
    const key = `${this.callKey(n, ctx)}|${tf}`;
    let sec = this.securities.get(key);
    if (!sec) {
      sec = buildHigherTimeframe(this.data, tf, secs, this.session, this.tf.seconds);
      sec.values = [];
      sec.done = -1;
      sec.varSlots = [];
      sec.tf = { ...inferTimeframe(sec.data.time), period: tf, seconds: secs };
      this.securities.set(key, sec);
    }
    const b = this.bar;
    const target = lookahead || sec.last[b] ? sec.map[b] : sec.map[b] - 1;
    while (sec.done < target) {
      const hb = sec.done + 1;
      const saved = [this.data, this.n, this.bar, this.varSlots, this.tf];
      this.data = sec.data; this.n = sec.data.close.length; this.bar = hb; this.varSlots = sec.varSlots; this.tf = sec.tf;
      try {
        sec.values[hb] = this.eval(exprNode, { path: `${ctx.path}S${n.id}`, scope: ctx.scope });
        for (const s of sec.varSlots) if (s.hist) s.hist[hb] = s.value;
      } finally {
        [this.data, this.n, this.bar, this.varSlots, this.tf] = saved;
      }
      sec.done = hb;
    }
    return target >= 0 ? sec.values[target] : NaN;
  }

  callUser(f, n, ctx) {
    if (++this.depth > 200) throw new PineRuntimeError('too much recursion', n.line);
    try {
      const path = ctx.path ? `${ctx.path}>${n.id}` : String(n.id);
      const scope = new Scope(this.globalScope);
      f.params.forEach((p, i) => {
        let v;
        if (i < n.args.length) v = this.eval(n.args[i], ctx);
        else if (n.named[p.name]) v = this.eval(n.named[p.name], ctx);
        else if (p.def) v = this.eval(p.def, ctx);
        else v = NaN;
        const slot = this.getSlot(`${path}#p${i}`, false, p.name);
        this.setSlot(slot, v);
        scope.set(p.name, slot);
      });
      let v = NaN;
      const inner = { path, scope };
      for (const s of f.body.body) v = this.exec(s, inner);
      return v;
    } finally {
      this.depth--;
    }
  }

  callBuiltin(name, n, ctx, preArgs) {
    const def = this.builtins[name];
    if (!def) throw new PineRuntimeError(`Could not find function '${name}'`, n.line);
    const [params, fn] = def;
    let args;
    if (preArgs) args = preArgs;
    else if (params === '...') args = n.args.map((a) => this.eval(a, ctx));
    else {
      // unknown named arguments are ignored (cosmetic params like editable=, display=)
      if (!n.named_) n.named_ = Object.entries(n.named).map(([k, a]) => [params.indexOf(k), a]).filter(([i]) => i >= 0);
      args = new Array(params.length);
      for (let i = 0; i < n.args.length; i++) args[i] = this.eval(n.args[i], ctx);
      for (const [i, a] of n.named_) args[i] = this.eval(a, ctx);
    }
    return fn(args, this.callKey(n, ctx), n, ctx);
  }
}

// ---------------------------------------------------------------- builtins
function buildBuiltins(rt) {
  const B = {};
  const def = (name, params, fn) => { B[name] = [params, fn]; };
  const n = (v) => (isNa(v) ? NaN : +v);

  // ta.*
  for (const [k, [params, impl]] of Object.entries(TA)) {
    def(`ta.${k}`, params, (a, key) => impl(rt, key, ...trimUndef(a)));
  }
  // v4 compatibility: sma(), ema(), crossover(), ...
  for (const k of Object.keys(TA)) if (!B[k]) B[k] = B[`ta.${k}`];

  // general
  def('na', ['x'], ([x]) => isNa(x));
  def('nz', ['source', 'replacement'], ([x, r]) => (isNa(x) ? (r === undefined ? 0 : r) : x));
  def('fixnan', ['source'], ([x], key) => fixnan(rt, key, x));
  def('int', ['x'], ([x]) => (isNa(x) ? NaN : Math.trunc(x)));
  def('float', ['x'], ([x]) => n(x));
  def('bool', ['x'], ([x]) => rt.truthy(x));
  def('string', ['x'], ([x]) => String(x));
  def('max_bars_back', ['var', 'num'], () => NaN);
  def('timestamp', '...', (args) => {
    if (args.length === 1 && typeof args[0] === 'string') {
      const t = Date.parse(args[0]);
      return Number.isNaN(t) ? NaN : t;
    }
    let tz = rt.tz;
    if (typeof args[0] === 'string') tz = args.shift();
    const [y, mo = 1, d = 1, h = 0, mi = 0, s = 0] = args;
    return zonedToUtc(y, mo, d, h, mi, s, tz);
  });
  for (const [fname, field] of [['year', 'y'], ['month', 'mo'], ['dayofmonth', 'd'], ['dayofweek', 'wd'], ['hour', 'h'], ['minute', 'mi'], ['second', 's']]) {
    def(fname, ['time', 'timezone'], ([t, tz]) => (isNa(t) ? NaN : timeParts(t, tz || rt.tz)[field]));
  }
  def('weekofyear', ['time', 'timezone'], ([t]) => weekOfYear(t));
  const sessionTime = (tf, session, tz, close) => {
    const t = rt.data.time[rt.bar];
    if (!session) return close ? t + rt.tf.seconds * 1000 : t;
    return inSession(t, session, tz || rt.tz) ? (close ? t + rt.tf.seconds * 1000 : t) : NaN;
  };
  def('time', ['timeframe', 'session', 'timezone'], ([tf, s, tz]) => sessionTime(tf, s, tz, false));
  def('time_close', ['timeframe', 'session', 'timezone'], ([tf, s, tz]) => sessionTime(tf, s, tz, true));
  def('timeframe.in_seconds', ['timeframe'], ([tf]) => tfSeconds(tf === undefined ? rt.tf.period : tf));
  def('timeframe.change', ['timeframe'], ([tf]) => {
    const b = rt.bar;
    if (b === 0) return true;
    const sec = tfSeconds(tf) * 1000;
    return Math.floor(rt.data.time[b] / sec) !== Math.floor(rt.data.time[b - 1] / sec);
  });

  // math.*
  const m1 = (f) => ([x]) => (isNa(x) ? NaN : f(x));
  def('math.abs', ['number'], m1(Math.abs));
  def('math.ceil', ['number'], m1(Math.ceil));
  def('math.floor', ['number'], m1(Math.floor));
  def('math.sqrt', ['number'], m1(Math.sqrt));
  def('math.log', ['number'], m1(Math.log));
  def('math.log10', ['number'], m1(Math.log10));
  def('math.exp', ['number'], m1(Math.exp));
  def('math.sign', ['number'], m1(Math.sign));
  def('math.sin', ['angle'], m1(Math.sin));
  def('math.cos', ['angle'], m1(Math.cos));
  def('math.tan', ['angle'], m1(Math.tan));
  def('math.asin', ['angle'], m1(Math.asin));
  def('math.acos', ['angle'], m1(Math.acos));
  def('math.atan', ['angle'], m1(Math.atan));
  def('math.todegrees', ['radians'], m1((x) => (x * 180) / Math.PI));
  def('math.toradians', ['degrees'], m1((x) => (x * Math.PI) / 180));
  def('math.pow', ['base', 'exponent'], ([a, b]) => Math.pow(a, b));
  def('math.round', ['number', 'precision'], ([x, p]) => {
    if (isNa(x)) return NaN;
    if (p === undefined) return Math.sign(x) * Math.round(Math.abs(x));
    const f = Math.pow(10, p);
    return Math.sign(x) * Math.round(Math.abs(x) * f) / f;
  });
  def('math.round_to_mintick', ['number'], ([x]) => Math.round(x / rt.mintick) * rt.mintick);
  def('math.max', '...', (a) => (a.some(isNa) ? NaN : Math.max(...a)));
  def('math.min', '...', (a) => (a.some(isNa) ? NaN : Math.min(...a)));
  def('math.avg', '...', (a) => a.reduce((s, x) => s + x, 0) / a.length);
  def('math.sum', ['source', 'length'], ([s, l], key) => rollingSum(rt, key, s, l));
  def('math.random', ['min', 'max', 'seed'], ([lo = 0, hi = 1]) => lo + Math.random() * (hi - lo));
  for (const k of ['abs', 'ceil', 'floor', 'sqrt', 'log', 'log10', 'exp', 'sign', 'pow', 'round', 'max', 'min', 'avg', 'sum']) {
    if (!B[k]) B[k] = B[`math.${k}`];
  }

  // str.*
  def('str.tostring', ['value', 'format'], ([v, f]) => fmtNumber(v, f, rt.mintick));
  B.tostring = B['str.tostring'];
  def('str.tonumber', ['string'], ([s]) => { const v = parseFloat(s); return Number.isNaN(v) ? NaN : v; });
  def('str.length', ['string'], ([s]) => String(s).length);
  def('str.contains', ['source', 'str'], ([s, x]) => String(s).includes(x));
  def('str.startswith', ['source', 'str'], ([s, x]) => String(s).startsWith(x));
  def('str.endswith', ['source', 'str'], ([s, x]) => String(s).endsWith(x));
  def('str.upper', ['source'], ([s]) => String(s).toUpperCase());
  def('str.lower', ['source'], ([s]) => String(s).toLowerCase());
  def('str.replace_all', ['source', 'target', 'replacement'], ([s, a, b]) => String(s).split(a).join(b));
  def('str.substring', ['source', 'begin_pos', 'end_pos'], ([s, a, b]) => String(s).substring(a, b));
  def('str.format', '...', ([f, ...vals]) => String(f).replace(/\{(\d+)(?:,number,([^}]*))?\}/g, (_, i, fmt) => fmtNumber(vals[+i], fmt, rt.mintick)));
  def('str.split', ['string', 'separator'], ([s, sep]) => ({ __array: true, items: String(s).split(sep) }));

  // color.*
  def('color.new', ['color', 'transp'], ([c, t]) => {
    const p = parseColor(c);
    return p ? makeColor(p.r, p.g, p.b, t) : c;
  });
  def('color.rgb', ['red', 'green', 'blue', 'transp'], ([r, g, b, t = 0]) => makeColor(r, g, b, t));
  def('color.r', ['color'], ([c]) => (parseColor(c) || {}).r ?? NaN);
  def('color.g', ['color'], ([c]) => (parseColor(c) || {}).g ?? NaN);
  def('color.b', ['color'], ([c]) => (parseColor(c) || {}).b ?? NaN);
  def('color.t', ['color'], ([c]) => { const p = parseColor(c); return p ? Math.round(100 - (p.a / 255) * 100) : NaN; });
  def('color.from_gradient', ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'], ([v, lo, hi, c1, c2]) => {
    const a = parseColor(c1), b = parseColor(c2);
    if (!a || !b || isNa(v)) return NaN;
    const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
    return makeColor(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, 100 - ((a.a + (b.a - a.a) * t) / 255) * 100);
  });

  // declarations
  const declare = (kind) => (a) => {
    if (rt.bar !== 0) return NaN;
    rt.declaration = { kind, title: a[0] ?? 'Script', overlay: !!a[2] };
    if (kind === 'strategy') {
      const cfg = {
        pyramiding: a[6], default_qty_type: a[11], default_qty_value: a[12], initial_capital: a[13],
        currency: a[14], slippage: a[15], commission_type: a[16], commission_value: a[17],
        process_orders_on_close: a[18], close_entries_rule: a[19],
      };
      rt.broker = new Broker(rt.data, rt.mintick, rt.opts.properties || {}, rt.pointvalue, rt.opts.range);
      rt.broker.configure(cfg);
      rt.broker.bar = 0;
    }
    return NaN;
  };
  const STRATEGY_PARAMS = ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'pyramiding', 'calc_on_order_fills',
    'calc_on_every_tick', 'max_bars_back', 'backtest_fill_limits_assumption', 'default_qty_type', 'default_qty_value',
    'initial_capital', 'currency', 'slippage', 'commission_type', 'commission_value', 'process_orders_on_close',
    'close_entries_rule', 'margin_long', 'margin_short', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count',
    'max_boxes_count', 'calc_bars_count', 'risk_free_rate', 'use_bar_magnifier', 'fill_orders_on_standard_ohlc',
    'max_polylines_count', 'dynamic_requests', 'behind_chart'];
  def('strategy', STRATEGY_PARAMS, declare('strategy'));
  const INDICATOR_PARAMS = ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'max_bars_back', 'timeframe',
    'timeframe_gaps', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count', 'max_boxes_count', 'calc_bars_count',
    'max_polylines_count', 'dynamic_requests', 'behind_chart'];
  def('indicator', INDICATOR_PARAMS, declare('indicator'));
  B.study = B.indicator;

  // inputs
  const input = (type, params) => (a, key, node) => {
    const p = Object.fromEntries(params.map((k, i) => [k, a[i]]));
    const inKey = p.title || `${type} input ${rt.inputs.size + 1}`;
    let defval = p.defval;
    const arg0 = node.args[0] || node.named.defval;
    if (type === 'auto' && arg0 && arg0.type === 'Ident' && SOURCES.includes(arg0.name)) type = 'source';
    if (type === 'source') defval = arg0 && arg0.type === 'Ident' ? arg0.name : 'close';
    if (type === 'auto') {
      type = typeof defval === 'boolean' ? 'bool' : typeof defval === 'string' ? 'string' : Number.isInteger(defval) ? 'int' : 'float';
    }
    if (!rt.inputs.has(key)) {
      rt.inputs.set(key, {
        key: inKey, title: p.title || inKey, type, defval,
        options: Array.isArray(p.options) ? p.options : p.options && p.options.__array ? p.options.items : undefined,
        minval: p.minval, maxval: p.maxval, step: p.step, group: p.group, tooltip: p.tooltip, inline: p.inline,
      });
    }
    const ov = rt.inputOverrides[inKey];
    const v = ov !== undefined ? ov : defval;
    if (type === 'source') {
      const src = SOURCES.includes(v) ? v : 'close';
      return rt.builtinVar(src, rt.bar);
    }
    if (type === 'int') return Math.round(+v);
    if (type === 'float' || type === 'price') return +v;
    if (type === 'bool') return v === true || v === 'true';
    if (type === 'time') return +v;
    return v;
  };
  const NUM = ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'display'];
  def('input', ['defval', 'title', 'tooltip', 'inline', 'group'], input('auto', ['defval', 'title', 'tooltip', 'inline', 'group']));
  def('input.int', [...NUM, 'options'], input('int', [...NUM, 'options']));
  def('input.float', [...NUM, 'options'], input('float', [...NUM, 'options']));
  const BOOLP = ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'];
  def('input.bool', BOOLP, input('bool', BOOLP));
  const STRP = ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'];
  def('input.string', STRP, input('string', STRP));
  def('input.timeframe', STRP, input('string', STRP));
  def('input.session', STRP, input('string', STRP));
  def('input.symbol', STRP, input('string', STRP));
  def('input.text_area', STRP, input('string', STRP));
  def('input.color', BOOLP, input('color', BOOLP));
  def('input.price', BOOLP, input('price', BOOLP));
  def('input.time', BOOLP, input('time', BOOLP));
  def('input.source', ['defval', 'title', 'tooltip', 'inline', 'group', 'display'], input('source', ['defval', 'title', 'tooltip', 'inline', 'group', 'display']));
  def('input.enum', STRP, input('string', STRP));

  // plotting
  const overlayFor = (force) => (force ? true : rt.declaration ? rt.declaration.overlay : true);
  def('plot', ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable',
    'show_last', 'display', 'format', 'precision', 'force_overlay', 'linestyle'], (a, key) => {
    let p = rt.plots.get(key);
    if (!p) {
      p = {
        id: key, title: a[1] || `Plot ${rt.plots.size + 1}`, style: a[4] || 'line', linewidth: a[3] || 1,
        overlay: overlayFor(a[14]), offset: a[7] || 0, histbase: a[6] || 0,
        values: new Array(rt.n).fill(NaN), colors: new Array(rt.n).fill(null),
        display: a[11],
      };
      rt.plots.set(key, p);
    }
    const v = a[0];
    p.values[rt.bar] = typeof v === 'boolean' ? +v : n(v);
    p.colors[rt.bar] = isNa(a[2]) ? null : a[2] || '#2196F3';
    return key;
  });
  const shape = (isChar) => (a, key) => {
    let s = rt.shapes.get(key);
    const [series, title] = a;
    if (!s) {
      s = {
        id: key, title: title || `Shape ${rt.shapes.size + 1}`, points: [], overlay: overlayFor(isChar ? a[13] : a[14]),
        style: isChar ? 'char' : a[2] || 'xcross', char: isChar ? a[2] : undefined,
        location: a[3] || 'abovebar', size: isChar ? a[9] : a[9],
      };
      rt.shapes.set(key, s);
    }
    const on = typeof series === 'boolean' ? series : !isNa(series) && series !== 0;
    if (on) s.points.push({ bar: rt.bar, color: a[4] || '#2196F3', text: a[6] || (isChar ? a[2] : ''), value: n(series) });
    return key;
  };
  const SHAPEP = ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size',
    'show_last', 'display', 'format', 'force_overlay'];
  def('plotshape', [...SHAPEP.slice(0, 13), 'precision', 'force_overlay'], shape(false));
  def('plotchar', ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size',
    'show_last', 'display', 'format', 'force_overlay'], shape(true));
  def('plotarrow', ['series', 'title', 'colorup', 'colordown', 'offset', 'minheight', 'maxheight', 'editable', 'show_last', 'display'], (a, key) => {
    let s = rt.shapes.get(key);
    if (!s) {
      s = { id: key, title: a[1] || 'Arrows', points: [], overlay: overlayFor(false), style: 'arrow', location: 'auto' };
      rt.shapes.set(key, s);
    }
    const v = n(a[0]);
    if (v > 0) s.points.push({ bar: rt.bar, color: a[2] || '#4CAF50', text: '', value: v, up: true });
    else if (v < 0) s.points.push({ bar: rt.bar, color: a[3] || '#FF5252', text: '', value: v, up: false });
    return key;
  });
  def('hline', ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'], (a, key) => {
    if (!rt.hlines.has(key)) {
      rt.hlines.set(key, { id: key, price: a[0], title: a[1] || '', color: a[2] || '#787B86', linestyle: a[3] || 'dashed', linewidth: a[4] || 1, overlay: overlayFor(false) });
    }
    return key;
  });
  def('bgcolor', ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay'], ([c]) => {
    if (!rt.bgcolors) rt.bgcolors = new Array(rt.n).fill(null);
    rt.bgcolors[rt.bar] = isNa(c) ? null : c;
    return NaN;
  });
  def('barcolor', ['color', 'offset', 'editable', 'show_last', 'title', 'display'], ([c]) => {
    if (!rt.barcolors) rt.barcolors = new Array(rt.n).fill(null);
    rt.barcolors[rt.bar] = isNa(c) ? null : c;
    return NaN;
  });

  // strategy.*
  const br = () => {
    if (!rt.broker) throw new Error('strategy functions need a strategy() declaration');
    return rt.broker;
  };
  const dirOf = (d) => (d === 'long' || d === true ? 1 : d === 'short' || d === false ? -1 : NaN);
  const when = (w) => w === undefined || rt.truthy(w);
  def('strategy.entry', ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert', 'when'],
    ([id, d, qty, limit, stop, ocaName, ocaType, comment, , , w]) => {
      if (!when(w)) return NaN;
      const dir = dirOf(d);
      if (Number.isNaN(dir)) throw new Error('strategy.entry: direction must be strategy.long or strategy.short');
      br().entry({ id, dir, qty, limit, stop, comment, ocaName, ocaType });
      return NaN;
    });
  def('strategy.order', ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert', 'when'],
    ([id, d, qty, limit, stop, ocaName, ocaType, comment, , , w]) => {
      if (!when(w)) return NaN;
      br().order({ id, dir: dirOf(d), qty, limit, stop, comment, ocaName, ocaType });
      return NaN;
    });
  def('strategy.exit', ['id', 'from_entry', 'qty', 'qty_percent', 'profit', 'limit', 'loss', 'stop', 'trail_price', 'trail_points',
    'trail_offset', 'oca_name', 'comment', 'comment_profit', 'comment_loss', 'comment_trailing', 'alert_message',
    'alert_profit', 'alert_loss', 'alert_trailing', 'disable_alert', 'when'], (a) => {
    if (!when(a[21])) return NaN;
    br().exit({
      id: a[0], fromEntry: a[1], qty: a[2], qtyPercent: a[3], profit: a[4], limit: a[5], loss: a[6], stop: a[7],
      trailPrice: a[8], trailPoints: a[9], trailOffset: a[10], comment: a[12], commentProfit: a[13],
      commentLoss: a[14], commentTrailing: a[15],
    });
    return NaN;
  });
  def('strategy.close', ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert', 'when'],
    ([id, comment, qty, qtyPercent, , immediately, , w]) => {
      if (!when(w)) return NaN;
      br().close({ id, comment, qty, qtyPercent, immediately });
      return NaN;
    });
  def('strategy.close_all', ['comment', 'alert_message', 'immediately', 'disable_alert', 'when'], ([comment, , immediately, , w]) => {
    if (!when(w)) return NaN;
    br().closeAll({ comment, immediately });
    return NaN;
  });
  def('strategy.cancel', ['id', 'when'], ([id, w]) => { if (when(w)) br().cancel(id); return NaN; });
  def('strategy.cancel_all', ['when'], ([w]) => { if (when(w)) br().cancelAll(); return NaN; });
  def('strategy.risk.allow_entry_in', ['value'], () => NaN);
  def('strategy.risk.max_drawdown', ['value', 'type', 'alert_message'], () => NaN);
  def('strategy.risk.max_intraday_loss', ['value', 'type', 'alert_message'], () => NaN);
  def('strategy.risk.max_position_size', ['contracts'], () => NaN);
  def('strategy.risk.max_cons_loss_days', ['count', 'alert_message'], () => NaN);
  def('strategy.risk.max_intraday_filled_orders', ['count', 'alert_message'], () => NaN);
  const closedField = (f) => ([i]) => { const t = br().closed[i]; return t ? f(t) : NaN; };
  def('strategy.closedtrades.profit', ['trade_num'], closedField((t) => t.profit));
  def('strategy.closedtrades.entry_price', ['trade_num'], closedField((t) => t.entryPrice));
  def('strategy.closedtrades.exit_price', ['trade_num'], closedField((t) => t.exitPrice));
  def('strategy.closedtrades.entry_bar_index', ['trade_num'], closedField((t) => t.entryBar));
  def('strategy.closedtrades.exit_bar_index', ['trade_num'], closedField((t) => t.exitBar));
  def('strategy.closedtrades.entry_time', ['trade_num'], closedField((t) => t.entryTime));
  def('strategy.closedtrades.exit_time', ['trade_num'], closedField((t) => t.exitTime));
  def('strategy.closedtrades.size', ['trade_num'], closedField((t) => t.dir * t.qty));
  def('strategy.closedtrades.entry_id', ['trade_num'], closedField((t) => t.entryId));
  def('strategy.closedtrades.exit_id', ['trade_num'], closedField((t) => t.exitId));
  def('strategy.closedtrades.commission', ['trade_num'], closedField((t) => t.commission));
  def('strategy.closedtrades.max_runup', ['trade_num'], closedField((t) => t.runup));
  def('strategy.closedtrades.max_drawdown', ['trade_num'], closedField((t) => t.drawdown));
  const openField = (f) => ([i]) => { const t = br().open[i]; return t ? f(t) : NaN; };
  def('strategy.opentrades.entry_price', ['trade_num'], openField((t) => t.entryPrice));
  def('strategy.opentrades.entry_bar_index', ['trade_num'], openField((t) => t.entryBar));
  def('strategy.opentrades.entry_time', ['trade_num'], openField((t) => t.entryTime));
  def('strategy.opentrades.entry_id', ['trade_num'], openField((t) => t.entryId));
  def('strategy.opentrades.size', ['trade_num'], openField((t) => t.dir * t.qty));
  def('strategy.opentrades.profit', ['trade_num'], openField((t) => t.dir * (rt.data.close[rt.bar] - t.entryPrice) * t.qty * rt.pointvalue));
  def('strategy.opentrades.commission', ['trade_num'], openField((t) => t.entryCommission));
  def('strategy.opentrades.max_runup', ['trade_num'], openField((t) => t.maxFav));
  def('strategy.opentrades.max_drawdown', ['trade_num'], openField((t) => t.maxAdv));

  // array.*
  const arr = (items) => ({ __array: true, items });
  const A = (x) => {
    if (!x || !x.__array) throw new Error('expected an array');
    return x.items;
  };
  const idx = (a, i) => (i < 0 ? a.length + i : i);
  for (const t of ['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'table']) {
    def(`array.new_${t}`, ['size', 'initial_value'], ([size = 0, init]) => arr(new Array(size).fill(init === undefined ? NaN : init)));
  }
  def('array.new', ['size', 'initial_value'], ([size = 0, init]) => arr(new Array(size).fill(init === undefined ? NaN : init)));
  def('array.from', '...', (a) => arr([...a]));
  def('array.push', ['id', 'value'], ([a, v]) => { A(a).push(v); return NaN; });
  def('array.pop', ['id'], ([a]) => { const x = A(a).pop(); return x === undefined ? NaN : x; });
  def('array.shift', ['id'], ([a]) => { const x = A(a).shift(); return x === undefined ? NaN : x; });
  def('array.unshift', ['id', 'value'], ([a, v]) => { A(a).unshift(v); return NaN; });
  def('array.insert', ['id', 'index', 'value'], ([a, i, v]) => { A(a).splice(i, 0, v); return NaN; });
  def('array.remove', ['id', 'index'], ([a, i]) => { const x = A(a).splice(idx(A(a), i), 1); return x.length ? x[0] : NaN; });
  def('array.get', ['id', 'index'], ([a, i]) => {
    const items = A(a), j = idx(items, i);
    if (j < 0 || j >= items.length) throw new Error(`array index ${i} is out of bounds (size ${items.length})`);
    return items[j];
  });
  def('array.set', ['id', 'index', 'value'], ([a, i, v]) => {
    const items = A(a), j = idx(items, i);
    if (j < 0 || j >= items.length) throw new Error(`array index ${i} is out of bounds (size ${items.length})`);
    items[j] = v;
    return NaN;
  });
  def('array.size', ['id'], ([a]) => A(a).length);
  def('array.clear', ['id'], ([a]) => { A(a).length = 0; return NaN; });
  def('array.first', ['id'], ([a]) => A(a)[0] ?? NaN);
  def('array.last', ['id'], ([a]) => A(a)[A(a).length - 1] ?? NaN);
  def('array.includes', ['id', 'value'], ([a, v]) => A(a).includes(v));
  def('array.indexof', ['id', 'value'], ([a, v]) => A(a).indexOf(v));
  def('array.lastindexof', ['id', 'value'], ([a, v]) => A(a).lastIndexOf(v));
  def('array.copy', ['id'], ([a]) => arr([...A(a)]));
  def('array.slice', ['id', 'index_from', 'index_to'], ([a, f, t]) => arr(A(a).slice(f, t)));
  def('array.concat', ['id1', 'id2'], ([a, b]) => { A(a).push(...A(b)); return a; });
  def('array.reverse', ['id'], ([a]) => { A(a).reverse(); return NaN; });
  def('array.fill', ['id', 'value', 'index_from', 'index_to'], ([a, v, f = 0, t]) => { A(a).fill(v, f, t); return NaN; });
  def('array.join', ['id', 'separator'], ([a, s = ',']) => A(a).map((x) => fmtNumber(x, undefined, rt.mintick)).join(s));
  def('array.sort', ['id', 'order'], ([a, o = 'asc']) => { A(a).sort((x, y) => (o === 'desc' ? y - x : x - y)); return NaN; });
  const nums = (a) => A(a).filter((x) => !isNa(x));
  def('array.sum', ['id'], ([a]) => nums(a).reduce((s, x) => s + x, 0));
  def('array.avg', ['id'], ([a]) => { const v = nums(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; });
  def('array.max', ['id', 'nth'], ([a, k = 0]) => { const v = [...nums(a)].sort((x, y) => y - x); return v[k] ?? NaN; });
  def('array.min', ['id', 'nth'], ([a, k = 0]) => { const v = [...nums(a)].sort((x, y) => x - y); return v[k] ?? NaN; });
  def('array.range', ['id'], ([a]) => { const v = nums(a); return v.length ? Math.max(...v) - Math.min(...v) : NaN; });
  def('array.median', ['id'], ([a]) => {
    const v = [...nums(a)].sort((x, y) => x - y);
    if (!v.length) return NaN;
    const h = Math.floor(v.length / 2);
    return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
  });
  def('array.stdev', ['id', 'biased'], ([a, biased = true]) => {
    const v = nums(a);
    if (!v.length) return NaN;
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (biased ? v.length : v.length - 1));
  });
  def('array.variance', ['id', 'biased'], (args) => B['array.stdev'][1](args) ** 2);
  def('array.every', ['id'], ([a]) => A(a).every((x) => rt.truthy(x)));
  def('array.some', ['id'], ([a]) => A(a).some((x) => rt.truthy(x)));

  return B;
}

// Which higher-timeframe bar a timestamp belongs to. Bars are anchored to the
// market's session open the way TradingView builds them: CME futures days run
// 18:00 -> 17:00 New York (so 4h bars start 18:00, 22:00, 02:00, ...), US stocks
// start at 09:30 New York, crypto at 00:00 UTC.
//   session = { tz, start }  (start = minutes after local midnight)
export function sessionBucket(ms, secs, session, unit = '') {
  const DAYMS = 86400000;
  const p = timeParts(ms, session.tz);
  const local = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - session.start * 60000;
  const day = Math.floor(local / DAYMS);
  if (unit === 'M') {
    const q = new Date(local);
    return q.getUTCFullYear() * 12 + q.getUTCMonth();
  }
  if (unit === 'W') {
    // evening sessions (futures) open the week on Sunday, others on Monday
    const shift = session.start >= 12 * 60 ? 4 : 3;
    return Math.floor((day + shift) / 7);
  }
  if (secs >= 86400) return Math.floor(day / Math.round(secs / 86400));
  const perDay = Math.ceil(86400 / secs);
  return day * perDay + Math.floor((local - day * DAYMS) / (secs * 1000));
}

function buildHigherTimeframe(d, tf, secs, session, chartSecs) {
  const m = /^(\d*)([SDWM]?)$/.exec(tf) || [];
  const k = m[1] ? +m[1] : 1;
  const unit = m[2] || '';
  const bucket = (t) => {
    if (unit === 'M') return Math.floor(sessionBucket(t, secs, session, 'M') / k);
    if (unit === 'W') return Math.floor(sessionBucket(t, secs, session, 'W') / k);
    return sessionBucket(t, secs, session, '');
  };
  const out = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  const map = new Int32Array(d.time.length);
  const last = new Uint8Array(d.time.length);
  let prev = null;
  for (let i = 0; i < d.time.length; i++) {
    const bk = bucket(d.time[i]);
    if (bk !== prev) {
      if (i > 0) last[i - 1] = 1;
      out.time.push(d.time[i]); out.open.push(d.open[i]); out.high.push(d.high[i]); out.low.push(d.low[i]);
      out.close.push(d.close[i]); out.volume.push(d.volume[i]);
      prev = bk;
    } else {
      const j = out.time.length - 1;
      out.high[j] = Math.max(out.high[j], d.high[i]);
      out.low[j] = Math.min(out.low[j], d.low[i]);
      out.close[j] = d.close[i];
      out.volume[j] += d.volume[i];
    }
    map[i] = out.time.length - 1;
  }
  // the final chart bar closes its higher-timeframe bar only if its close time reaches the boundary
  const n = d.time.length;
  if (n && bucket(d.time[n - 1] + chartSecs * 1000) !== bucket(d.time[n - 1])) last[n - 1] = 1;
  return { data: out, map, last };
}

function trimUndef(a) {
  let end = a.length;
  while (end > 0 && a[end - 1] === undefined) end--;
  return a.slice(0, end);
}

function tfSeconds(tf) {
  const s = String(tf);
  const m = /^(\d*)([SDWM]?)$/.exec(s);
  if (!m) return 60;
  const k = m[1] ? +m[1] : 1;
  switch (m[2]) {
    case 'S': return k;
    case 'D': return k * 86400;
    case 'W': return k * 604800;
    case 'M': return k * 2628003;
    default: return k * 60;
  }
}

function inSession(ms, session, tz) {
  if (!session || session === '24x7') return true;
  const [range, days] = String(session).split(':');
  const p = timeParts(ms, tz);
  if (days && !days.includes(String(p.wd))) return false;
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(range);
  if (!m) return true;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  const t = p.h * 60 + p.mi;
  if (start === end) return true;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

// Convenience wrapper.
export function runScript(source, data, options) {
  return new Runtime(source, data, options).run();
}

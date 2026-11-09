// Browser UI: data loading, Pine editor, chart rendering and the strategy tester.
import { runScript, SOURCES, timeParts } from '../src/runtime.js';
import { parseCSV, sampleData, fetchBinance, guessContract, TIMEFRAMES, barSeconds, resample, SESSIONS } from '../src/data.js';
import { EXAMPLES } from '../src/examples.js';

const LW = window.LightweightCharts;
const $ = (id) => document.getElementById(id);

const store = {
  get(k, d) { try { const v = localStorage.getItem(`pbt.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`pbt.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  data: null,
  dataLabel: '',
  symbol: 'SAMPLE',
  result: null,
  inputOverrides: store.get('inputs', {}),
  propOverrides: store.get('props', {}),
  chart: null,
  eqChart: null,
  candleSeries: null,
  keepRange: null,
  // contract specs: point value (currency per 1.0 price move per contract) and tick size (null = detect)
  spec: { pointvalue: 1, mintick: null, root: '' },
  tz: store.get('tz', 'UTC'),
  base: null, // bars as loaded, before any timeframe change
  baseLabel: '',
  tfSel: store.get('tf', 'native'),
  session: SESSIONS.crypto, // where higher-timeframe bars start (see SESSIONS)
  server: false, // local server with the market-data endpoint is running
};

// ------------------------------------------------------------ formatting
const fmtMoney = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v === Infinity ? '∞' : '—');
const fmtPct = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
const fmtNum = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : v === Infinity ? '∞' : '—');
const fmtQty = (v) => (Number.isFinite(v) ? (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(Math.abs(v) < 1 ? 6 : 4).replace(/0+$/, '').replace(/\.$/, '')) : '—');
const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtTime(ms) {
  const t = timeParts(ms, state.tz);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${t.y}-${p(t.mo)}-${p(t.d)}`;
  return t.h || t.mi ? `${date} ${p(t.h)}:${p(t.mi)}` : date;
}
// The chart library draws UTC timestamps; shift each bar so the axis shows the chosen time zone.
function chartTime(ms) {
  if (state.tz === 'UTC') return Math.floor(ms / 1000);
  const t = timeParts(ms, state.tz);
  return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) / 1000;
}
const priceDecimals = (mintick) => { const s = (mintick || 0.01).toFixed(10).replace(/0+$/, ''); return Math.min(8, s.split('.')[1]?.length || 0); };

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function cssColor(c, fallback) {
  if (!c) return fallback;
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})$/i.exec(c);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${(parseInt(m[2], 16) / 255).toFixed(3)})`;
  }
  return c;
}
function withAlpha(c, a) {
  const m = /^#([0-9a-f]{6})/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// --------------------------------------------------------------- editor
const KW = /\b(if|else|for|to|by|in|while|var|varip|and|or|not|true|false|break|continue|switch|na|int|float|bool|string|color|series|simple|const)\b/;
function highlight(src) {
  const out = [];
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)|(#[0-9a-fA-F]{6,8}\b)|(\b\d+\.?\d*(?:[eE][+-]?\d+)?\b)|(\b(?:ta|math|strategy|input|color|str|array|plot|shape|location|size|request|timeframe|syminfo|barstate|display|hline|format)\.[A-Za-z_.]+)|([A-Za-z_]\w*)(?=\s*\()|(\b[A-Za-z_]\w*\b)/gm;
  let last = 0, m;
  while ((m = re.exec(src))) {
    out.push(esc(src.slice(last, m.index)));
    const t = m[0];
    if (m[1]) out.push(`<span class="tk-cmt">${esc(t)}</span>`);
    else if (m[2] || m[3]) out.push(`<span class="tk-str">${esc(t)}</span>`);
    else if (m[4]) out.push(`<span class="tk-num">${t}</span>`);
    else if (m[5]) out.push(`<span class="tk-ns">${esc(t)}</span>`);
    else if (m[6]) out.push(`<span class="tk-fn">${esc(t)}</span>`);
    else if (KW.test(t) && KW.exec(t)[0] === t) out.push(`<span class="tk-kw">${t}</span>`);
    else out.push(esc(t));
    last = m.index + t.length;
  }
  out.push(esc(src.slice(last)));
  return `${out.join('')}\n`;
}
const code = $('code');
function refreshEditor(errLine) {
  $('highlight').innerHTML = highlight(code.value);
  const lines = code.value.split('\n').length;
  let g = '';
  for (let i = 1; i <= lines; i++) g += `<div${i === errLine ? ' class="err"' : ''}>${i}</div>`;
  $('gutter').innerHTML = g;
  syncScroll();
}
function syncScroll() {
  $('highlight').scrollTop = code.scrollTop;
  $('highlight').scrollLeft = code.scrollLeft;
  $('gutter').scrollTop = code.scrollTop;
}
code.addEventListener('input', () => { refreshEditor(); store.set('code', code.value); });
code.addEventListener('scroll', syncScroll);
code.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = code;
    if (e.shiftKey) {
      const ls = value.lastIndexOf('\n', s - 1) + 1;
      if (value.startsWith('    ', ls)) {
        code.value = value.slice(0, ls) + value.slice(ls + 4);
        code.selectionStart = code.selectionEnd = Math.max(ls, s - 4);
      }
    } else {
      code.value = `${value.slice(0, s)}    ${value.slice(en)}`;
      code.selectionStart = code.selectionEnd = s + 4;
    }
    code.dispatchEvent(new Event('input'));
  } else if (e.key === 'Enter' && !(e.ctrlKey || e.metaKey)) {
    // keep the indentation of the current line; indent after a block opener
    e.preventDefault();
    const { selectionStart: s, selectionEnd: en, value } = code;
    const ls = value.lastIndexOf('\n', s - 1) + 1;
    const line = value.slice(ls, s);
    let indent = /^\s*/.exec(line)[0];
    if (/^\s*(if|else|for|while|switch)\b.*$|=>\s*$/.test(line)) indent += '    ';
    code.value = `${value.slice(0, s)}\n${indent}${value.slice(en)}`;
    code.selectionStart = code.selectionEnd = s + 1 + indent.length;
    code.dispatchEvent(new Event('input'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); }
  if (e.key === 'Escape' && !$('settingsModal').hidden) closeSettings();
});

for (const [i, ex] of EXAMPLES.entries()) {
  const o = document.createElement('option');
  o.value = String(i);
  o.textContent = ex.name;
  $('examples').append(o);
}
$('examples').addEventListener('change', (e) => {
  const ex = EXAMPLES[+e.target.value];
  e.target.value = '';
  if (!ex) return;
  code.value = ex.code;
  state.inputOverrides = {};
  state.propOverrides = {};
  store.set('inputs', {});
  store.set('props', {});
  store.set('code', code.value);
  refreshEditor();
  run();
});

// ----------------------------------------------------------------- data
function setSourceUI(load = true) {
  const src = $('dataSource').value;
  const ex = src === 'binance';
  const market = src === 'market';
  store.set('source', src);
  $('symbol').hidden = !(ex || market);
  $('barCount').hidden = !ex;
  $('loadData').hidden = !(ex || market);
  $('csvLabel').hidden = src !== 'csv';
  if (market && /USDT$/.test($('symbol').value)) $('symbol').value = store.get('marketSymbol', 'MNQ1!');
  if (ex && !/USDT$/.test($('symbol').value)) $('symbol').value = 'BTCUSDT';
  if (!load) return;
  if (src === 'sample') loadSample();
  if (market) loadMarket();
}
$('dataSource').addEventListener('change', setSourceUI);
function setData(d, label, symbol, specName, kind) {
  const c = guessContract(specName || symbol);
  state.spec = c ? { pointvalue: c.pointvalue, mintick: c.mintick, root: c.root } : { pointvalue: 1, mintick: null, root: '' };
  // anchor higher-timeframe bars to the market's session open, like TradingView
  const k = c ? 'futures' : kind;
  state.session = SESSIONS[k] || { tz: state.tz, start: 0 };
  state.base = d;
  state.baseLabel = label;
  state.symbol = symbol;
  applyTimeframe();
}

// ---- chart timeframe: build higher-timeframe bars from the loaded ones
const tfLabel = (secs) => (TIMEFRAMES.find((t) => t[2] === secs) || [])[1] || (secs % 86400 === 0 ? `${secs / 86400}D` : secs % 3600 === 0 ? `${secs / 3600}h` : `${Math.round(secs / 60)}m`);
function fillTimeframeOptions() {
  const sel = $('timeframe');
  const baseSecs = state.base ? barSeconds(state.base) : 0;
  sel.innerHTML = `<option value="native">${state.base ? `As loaded (${tfLabel(baseSecs)})` : 'As loaded'}</option>` +
    TIMEFRAMES.map(([v, label, secs]) => {
      const market = $('dataSource').value === 'market'; // market data is re-downloaded per timeframe
      const tooFine = !market && state.base && secs < baseSecs;
      const uneven = !market && state.base && secs % baseSecs !== 0 && secs !== 86400;
      return `<option value="${v}"${tooFine || uneven ? ' disabled' : ''}>${label}${tooFine ? ' (needs finer data)' : ''}</option>`;
    }).join('');
  sel.value = state.tfSel;
  if (sel.value !== state.tfSel || sel.selectedOptions[0]?.disabled) sel.value = 'native';
}
function applyTimeframe() {
  if (!state.base) return;
  fillTimeframeOptions();
  const sel = $('timeframe').value;
  const baseSecs = barSeconds(state.base);
  const tf = TIMEFRAMES.find((t) => t[0] === sel);
  const d = tf && tf[2] > baseSecs ? resample(state.base, tf[2], state.session) : state.base;
  const keep = state.data && state.data.time.length === d.time.length && state.data.time[0] === d.time[0];
  state.keepRange = keep && state.chart ? state.chart.timeScale().getVisibleLogicalRange() : null;
  state.data = d;
  state.dataLabel = `${state.baseLabel}${tf && tf[2] > baseSecs ? ` → ${tf[1]}` : ''}`;
  showDataInfo();
}
$('timeframe').addEventListener('change', () => {
  state.tfSel = $('timeframe').value;
  store.set('tf', state.tfSel);
  if ($('dataSource').value === 'binance' && state.tfSel !== 'native') {
    $('loadData').click(); // fetch that interval directly from the exchange
    return;
  }
  if ($('dataSource').value === 'market') {
    loadMarket();
    return;
  }
  applyTimeframe();
  run();
});
fillTimeframeOptions();
function showDataInfo() {
  const d = state.data;
  if (!d) return;
  const spec = state.spec.root ? ` · ${state.spec.root} $${state.spec.pointvalue}/pt, tick ${state.spec.mintick}` : '';
  $('dataInfo').textContent = `${state.dataLabel} · ${d.time.length.toLocaleString()} bars · ${fmtTime(d.time[0])} → ${fmtTime(d.time[d.time.length - 1])}${spec}`;
}
$('tz').value = state.tz;
if ($('tz').value !== state.tz) { state.tz = 'UTC'; $('tz').value = 'UTC'; }
$('tz').addEventListener('change', () => {
  state.tz = $('tz').value;
  store.set('tz', state.tz);
  applyTimeframe();
  run();
});
function loadSample() {
  setData(sampleData(6000, 3600000), 'Sample data', 'SAMPLE', '', 'crypto');
  run();
}
// ---- market data from the local server (Yahoo Finance history, as far back as it serves)
// Yahoo interval to download for each chart timeframe; others are built from these.
const MARKET_BASE = { 1: '1m', 3: '1m', 5: '5m', 15: '15m', 30: '30m', 45: '15m', 60: '60m', 120: '60m', 180: '60m', 240: '60m', D: '1d' };
let marketReq = 0;
async function loadMarket() {
  const sym = ($('symbol').value.trim() || 'MNQ1!').toUpperCase();
  $('symbol').value = sym;
  store.set('marketSymbol', sym);
  if (!state.server) {
    setStatus('Market data needs the local server: in a terminal, go to the pine-backtester folder and run  node serve.mjs  then open http://localhost:8080', true);
    return;
  }
  if (state.tfSel === 'native') { state.tfSel = '1'; store.set('tf', '1'); }
  const iv = MARKET_BASE[state.tfSel] || '1m';
  const id = ++marketReq;
  setStatus(`Downloading ${sym} ${iv} history…`);
  try {
    const r = await fetch(`/api/history?symbol=${encodeURIComponent(sym)}&interval=${iv}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    if (id !== marketReq) return; // a newer request replaced this one
    const kind = /=F$/.test(j.yahooSymbol) ? 'futures' : /-USD$/.test(j.yahooSymbol) ? 'crypto' : 'stocks';
    const d = { time: j.time, open: j.open, high: j.high, low: j.low, close: j.close, volume: j.volume };
    setData(d, `${sym}${j.name && j.name !== j.yahooSymbol ? ` (${j.name})` : ''} · ${iv} data`, sym, sym, kind);
    run();
  } catch (e) {
    if (id === marketReq) setStatus(`Could not download ${sym}: ${e.message}. Check the symbol (examples: MNQ1!, ES1!, NQ1!, AAPL, SPY, BTCUSD).`, true);
  }
}
$('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loadData').click(); });

$('loadData').addEventListener('click', async () => {
  if ($('dataSource').value === 'market') { loadMarket(); return; }
  const sym = $('symbol').value.trim().toUpperCase();
  // the exchange serves these intervals directly; 45m and 3h are built from 15m / 1h bars
  const sel = state.tfSel === 'native' ? '60' : state.tfSel;
  const direct = { 1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 60: '1h', 120: '2h', 240: '4h', D: '1d' };
  const iv = direct[sel] || (sel === '45' ? '15m' : '1h');
  const n = Math.max(100, Math.min(20000, +$('barCount').value || 3000));
  setStatus(`Loading ${sym} ${iv}…`);
  try {
    const d = await fetchBinance(sym, iv, n);
    setData(d, `${sym} · ${iv}`, sym, sym, 'crypto');
    run();
  } catch (e) {
    setStatus(`Could not load ${sym} from the exchange (${e.message}). If you're offline or the page blocks outside requests, export the chart data to CSV and open it with "CSV file".`, true);
  }
});
$('csvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const d = parseCSV(await f.text());
    const sym = f.name.replace(/\.[^.]+$/, '').split(',')[0].trim().toUpperCase();
    setData(d, f.name, sym || 'CSV', f.name);
    run();
  } catch (err) {
    setStatus(`Could not read ${f.name}: ${err.message}`, true);
  }
  e.target.value = '';
});

// ------------------------------------------------------------------ run
function setStatus(msg, isError = false, ok = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = `status${isError ? ' error' : ''}${ok ? ' ok' : ''}`;
}

// The backtest runs in a Web Worker so long 1-minute datasets don't freeze the page.
let worker = null;
let runId = 0;
function makeWorker() {
  if (window.__PBT_ENGINE__) {
    // single-file build: the engine source is embedded in the page
    const url = URL.createObjectURL(new Blob([window.__PBT_ENGINE__], { type: 'text/javascript' }));
    return new Worker(url);
  }
  return new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
}
function runOptions() {
  return {
    inputs: state.inputOverrides,
    properties: state.propOverrides,
    symbol: state.symbol,
    pointvalue: state.spec.pointvalue,
    mintick: state.spec.mintick || undefined,
    timezone: state.tz,
    session: state.session,
  };
}
function showError(message, line) {
  const ln = line || (/line (\d+)/.exec(message) || [])[1];
  refreshEditor(ln ? +ln : undefined);
  setStatus(message, true);
}
function runInline(source, options) {
  try {
    finishRun(runScript(source, state.data, options));
  } catch (e) {
    showError(e.message, e.line);
  }
}
function run() {
  if (!state.data) return;
  const id = ++runId;
  const source = code.value;
  const options = runOptions();
  if (worker) { worker.terminate(); worker = null; }
  try {
    worker = makeWorker();
  } catch {
    runInline(source, options);
    return;
  }
  const w = worker;
  const n = state.data.time.length;
  setStatus(`Running ${n.toLocaleString()} bars…`);
  $('runBtn').disabled = true;
  const done = () => { if (worker === w) { w.terminate(); worker = null; } $('runBtn').disabled = false; };
  w.onmessage = (e) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.type === 'progress') setStatus(`Running… ${Math.round((m.bar / m.n) * 100)}% of ${n.toLocaleString()} bars`);
    else if (m.type === 'done') { done(); finishRun(m.res); }
    else if (m.type === 'error') { done(); showError(m.message, m.line); }
  };
  w.onerror = (ev) => {
    // workers unavailable (e.g. some file:// setups): run on the page instead
    ev.preventDefault();
    done();
    if (id === runId) runInline(source, options);
  };
  w.postMessage({ id, source, data: state.data, options });
}
function finishRun(res) {
  refreshEditor();
  state.result = res;
  const s = res.strategy;
  const secs = (res.elapsedMs / 1000).toFixed(res.elapsedMs < 10000 ? 2 : 1);
  setStatus(`${res.title} · ran ${state.data.time.length.toLocaleString()} bars in ${secs} s${s ? ` · ${s.trades.length} closed trade${s.trades.length === 1 ? '' : 's'}${s.openTrades.length ? `, ${s.openTrades.length} open` : ''}` : ''}`, false, true);
  renderChart(res);
  renderTester(res);
}
$('runBtn').addEventListener('click', run);

// ---------------------------------------------------------------- chart
function chartTheme() {
  return {
    bg: css('--panel'), fg: css('--muted'), line: css('--line'), up: css('--up'), down: css('--down'),
    buy: css('--buy'), sell: css('--sell'), accent: css('--accent'), fgStrong: css('--fg'),
  };
}

function baseChartOptions(th, intraday) {
  return {
    autoSize: true,
    layout: {
      background: { type: 'solid', color: th.bg }, textColor: th.fg, fontSize: 11,
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace',
      panes: { separatorColor: th.line, separatorHoverColor: withAlpha(th.accent, 0.3), enableResize: true },
      attributionLogo: true,
    },
    grid: { vertLines: { color: withAlpha(th.line, 0.5) }, horzLines: { color: withAlpha(th.line, 0.5) } },
    rightPriceScale: { borderColor: th.line },
    timeScale: { borderColor: th.line, timeVisible: intraday, secondsVisible: false, rightOffset: 6 },
    crosshair: { mode: LW.CrosshairMode.Normal },
  };
}

const SHAPE_MAP = {
  triangleup: 'arrowUp', arrowup: 'arrowUp', labelup: 'arrowUp', triangledown: 'arrowDown', arrowdown: 'arrowDown',
  labeldown: 'arrowDown', circle: 'circle', square: 'square', diamond: 'square', cross: 'square', xcross: 'square', flag: 'square',
};

function renderChart(res) {
  const d = state.data;
  const th = chartTheme();
  const times = d.time.map(chartTime);
  const intraday = d.time.length > 1 && d.time[1] - d.time[0] < 86400000;
  const prevRange = state.keepRange || (state.chart ? state.chart.timeScale().getVisibleLogicalRange() : null);
  state.keepRange = null;
  if (state.chart) state.chart.remove();
  const chart = LW.createChart($('chart'), baseChartOptions(th, intraday));
  state.chart = chart;
  const dec = priceDecimals(res.mintick);
  const priceFormat = { type: 'price', precision: dec, minMove: res.mintick };

  // background colors (bgcolor) sit behind everything
  if (res.bgcolors && res.bgcolors.some(Boolean)) {
    const bg = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'bg', lastValueVisible: false, priceLineVisible: false, base: 0 }, 0);
    bg.priceScale().applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    bg.setData(times.map((t, i) => (res.bgcolors[i] ? { time: t, value: 1, color: cssColor(res.bgcolors[i]) } : { time: t })));
  }
  const vol = chart.addSeries(LW.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, 0);
  vol.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
  vol.setData(times.map((t, i) => ({ time: t, value: d.volume[i], color: withAlpha(d.close[i] >= d.open[i] ? th.up : th.down, 0.28) })));

  const candles = chart.addSeries(LW.CandlestickSeries, {
    upColor: th.up, downColor: th.down, wickUpColor: th.up, wickDownColor: th.down, borderVisible: false, priceFormat,
  }, 0);
  candles.setData(times.map((t, i) => {
    const bar = { time: t, open: d.open[i], high: d.high[i], low: d.low[i], close: d.close[i] };
    const bc = res.barcolors && res.barcolors[i];
    if (bc) { const c = cssColor(bc); bar.color = c; bar.wickColor = c; bar.borderColor = c; }
    return bar;
  }));
  state.candleSeries = candles;

  // plots
  const paneSeries = { 0: [candles], 1: [] };
  const plotSeries = [];
  for (const p of res.plots) {
    if (/none|data_window|status_line|price_scale/.test(String(p.display || '')) && !/display\.all|pane/.test(String(p.display))) continue;
    const pane = p.overlay ? 0 : 1;
    const color = cssColor(p.colors.find(Boolean), th.accent);
    const common = { color, lastValueVisible: true, priceLineVisible: false, title: '' };
    if (pane === 0) common.priceFormat = priceFormat;
    let s;
    const style = p.style;
    if (style === 'histogram' || style === 'columns') {
      s = chart.addSeries(LW.HistogramSeries, { ...common, base: p.histbase || 0 }, pane);
    } else if (style === 'area' || style === 'areabr') {
      s = chart.addSeries(LW.AreaSeries, { ...common, lineColor: color, topColor: withAlpha(p.colors.find(Boolean) || th.accent, 0.3), bottomColor: withAlpha(p.colors.find(Boolean) || th.accent, 0.02), lineWidth: p.linewidth }, pane);
    } else {
      const opts = { ...common, lineWidth: Math.max(1, Math.min(4, p.linewidth)) };
      if (style === 'stepline' || style === 'steplinebr' || style === 'stepline_diamond') opts.lineType = 1;
      if (style === 'circles' || style === 'cross') { opts.lineVisible = false; opts.pointMarkersVisible = true; opts.pointMarkersRadius = Math.max(2, p.linewidth + 1); }
      s = chart.addSeries(LW.LineSeries, opts, pane);
    }
    const breaks = style !== 'line' && style !== 'stepline' && style !== 'area';
    const pts = [];
    const shown = (i) => Number.isFinite(p.values[i]) && !!p.colors[i];
    for (let i = 0; i < times.length; i++) {
      const j = i + (p.offset || 0);
      if (j < 0 || j >= times.length) continue;
      if (!shown(i)) { if (breaks) pts.push({ time: times[j] }); continue; }
      const pt = { time: times[j], value: p.values[i], color: cssColor(p.colors[i]) };
      // The chart joins lines across empty points and colours each segment by its
      // starting point, so hide the segment that would bridge a gap.
      if (breaks && i + 1 < times.length && !shown(i + 1)) pt.color = 'rgba(0, 0, 0, 0)';
      pts.push(pt);
    }
    pts.sort((a, b) => a.time - b.time);
    s.setData(pts);
    paneSeries[pane].push(s);
    plotSeries.push({ p, s });
  }

  // hlines go on a series in their pane
  for (const h of res.hlines) {
    const pane = h.overlay ? 0 : 1;
    let host = paneSeries[pane][0];
    if (!host) {
      host = chart.addSeries(LW.LineSeries, { lineVisible: false, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false }, pane);
      host.setData(times.map((t) => ({ time: t, value: h.price })));
      paneSeries[pane].push(host);
    }
    host.createPriceLine({
      price: h.price, color: cssColor(h.color, th.fg), lineWidth: h.linewidth || 1,
      lineStyle: h.linestyle === 'solid' || h.linestyle === 'hline.style_solid' ? 0 : h.linestyle === 'dotted' || h.linestyle === 'hline.style_dotted' ? 1 : 2,
      axisLabelVisible: true, title: h.title || '',
    });
  }

  // markers: plotshape/plotchar + strategy fills
  const markers = [];
  const paneMarkers = [];
  for (const sh of res.shapes) {
    for (const pt of sh.points) {
      const above = sh.location === 'abovebar' || sh.location === 'top' || (sh.style === 'arrow' && !pt.up);
      const m = {
        time: times[pt.bar], position: above ? 'aboveBar' : 'belowBar', color: cssColor(pt.color, th.accent),
        shape: sh.style === 'arrow' ? (pt.up ? 'arrowUp' : 'arrowDown') : SHAPE_MAP[sh.style] || (above ? 'arrowDown' : 'arrowUp'),
        text: pt.text || '', size: sh.size === 'tiny' ? 0.5 : sh.size === 'small' ? 0.8 : sh.size === 'large' ? 1.6 : sh.size === 'huge' ? 2 : 1,
      };
      if (sh.style === 'char') { m.shape = 'circle'; m.size = 0.4; }
      (sh.overlay ? markers : paneMarkers).push(m);
    }
  }
  if (res.strategy) {
    for (const f of res.strategy.fills) {
      const buy = f.dir > 0;
      markers.push({
        time: times[f.bar], position: buy ? 'belowBar' : 'aboveBar', color: buy ? th.buy : th.sell,
        shape: buy ? 'arrowUp' : 'arrowDown', text: `${f.type === 'entry' ? f.id : f.comment || f.id} ${buy ? '+' : '−'}${fmtQty(f.qty)}`, size: 1,
      });
    }
  }
  markers.sort((a, b) => a.time - b.time);
  LW.createSeriesMarkers(candles, markers);
  if (paneMarkers.length && paneSeries[1][0]) {
    paneMarkers.sort((a, b) => a.time - b.time);
    LW.createSeriesMarkers(paneSeries[1][0], paneMarkers);
  }

  try {
    const panes = chart.panes();
    if (panes[1]) panes[1].setHeight(Math.round($('chart').clientHeight * 0.3));
  } catch { /* older library */ }

  if (prevRange) chart.timeScale().setVisibleLogicalRange(prevRange);
  else chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, times.length - 220), to: times.length + 5 });

  // legend
  const legend = $('legend');
  const showLegend = (i) => {
    if (i === undefined || i < 0 || i >= times.length) i = times.length - 1;
    const up = d.close[i] >= d.open[i];
    const cls = up ? 'up' : 'dn';
    const ov = plotSeries.filter((x) => x.p.overlay).slice(0, 6)
      .map((x) => `<span style="color:${cssColor(x.p.colors[i] || x.p.colors.find(Boolean), th.fg)}">${esc(x.p.title)} ${fmtNum(x.p.values[i], dec)}</span>`).join('');
    legend.innerHTML = `<div class="t">${esc(state.symbol)} · ${esc(res.timeframe)} · ${esc(res.title)}</div>
      <div class="row"><span>O <span class="${cls}">${fmtNum(d.open[i], dec)}</span></span><span>H <span class="${cls}">${fmtNum(d.high[i], dec)}</span></span><span>L <span class="${cls}">${fmtNum(d.low[i], dec)}</span></span><span>C <span class="${cls}">${fmtNum(d.close[i], dec)}</span></span></div>
      ${ov ? `<div class="row">${ov}</div>` : ''}`;
  };
  showLegend();
  chart.subscribeCrosshairMove((param) => {
    showLegend(param && param.logical !== undefined ? Math.round(param.logical) : undefined);
  });
}

// ---------------------------------------------------------------- tester
document.querySelectorAll('.tester .tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tester .tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  for (const t of ['overview', 'performance', 'trades', 'properties']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
  if (b.dataset.tab === 'overview' && state.result) renderEquity(state.result);
}));

function renderTester(res) {
  const s = res.strategy;
  $('testerTitle').textContent = s ? res.title : '';
  if (!s) {
    const msg = `<div class="empty">This script is an indicator. Declare it with <code>strategy()</code> and call <code>strategy.entry()</code> to see trades and performance here.</div>`;
    $('stats').innerHTML = msg;
    for (const t of ['performance', 'trades', 'properties']) $(`tab-${t}`).innerHTML = msg;
    if (state.eqChart) { state.eqChart.remove(); state.eqChart = null; }
    return;
  }
  const m = s.metrics;
  const stat = (k, v, sub, cls = '') => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
  $('stats').innerHTML = [
    stat('Net profit', fmtMoney(m.all.netProfit), fmtPct(m.netProfitPct), signCls(m.all.netProfit)),
    stat('Total closed trades', String(m.all.totalTrades), m.openTrades ? `${m.openTrades} open` : ''),
    stat('Percent profitable', fmtPct(m.all.percentProfitable), `${m.all.winningTrades}/${m.all.totalTrades}`),
    stat('Profit factor', fmtNum(m.all.profitFactor, 3)),
    stat('Max drawdown', fmtMoney(m.maxDrawdown), fmtPct(m.maxDrawdownPct), m.maxDrawdown > 0 ? 'neg' : ''),
    stat('Avg trade', fmtMoney(m.all.avgTrade), fmtPct(m.all.avgTradePct), signCls(m.all.avgTrade)),
    stat('Avg # bars in trades', fmtNum(m.all.avgBars, 0)),
  ].join('');
  if (!$('tab-overview').hidden) renderEquity(res);
  renderPerformance(m);
  renderTrades(s);
  renderProperties(s.config, res);
}

// ---- Overview chart: equity by trade (or by bar), drawdown hanging from the top,
// per-trade run-up / drawdown bars and buy & hold, in currency or percent.
const eqPrefs = {
  equity: store.get('eq.equity', true),
  drawdown: store.get('eq.drawdown', true),
  excursions: store.get('eq.excursions', false),
  buyhold: store.get('eq.buyhold', false),
  mode: store.get('eq.mode', 'abs'),
  axis: store.get('eq.axis', 'trades'),
};
function syncEqControls() {
  $('eqEquity').checked = eqPrefs.equity;
  $('eqDrawdown').checked = eqPrefs.drawdown;
  $('eqExcursions').checked = eqPrefs.excursions;
  $('eqBuyHold').checked = eqPrefs.buyhold;
  document.querySelectorAll('[data-eqmode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.eqmode === eqPrefs.mode)));
  document.querySelectorAll('[data-eqaxis]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.eqaxis === eqPrefs.axis)));
}
for (const [id, key] of [['eqEquity', 'equity'], ['eqDrawdown', 'drawdown'], ['eqExcursions', 'excursions'], ['eqBuyHold', 'buyhold']]) {
  $(id).addEventListener('change', () => {
    eqPrefs[key] = $(id).checked;
    store.set(`eq.${key}`, eqPrefs[key]);
    if (state.result) renderEquity(state.result);
  });
}
document.querySelectorAll('[data-eqmode]').forEach((b) => b.addEventListener('click', () => {
  eqPrefs.mode = b.dataset.eqmode;
  store.set('eq.mode', eqPrefs.mode);
  syncEqControls();
  if (state.result) renderEquity(state.result);
}));
document.querySelectorAll('[data-eqaxis]').forEach((b) => b.addEventListener('click', () => {
  eqPrefs.axis = b.dataset.eqaxis;
  store.set('eq.axis', eqPrefs.axis);
  syncEqControls();
  if (state.result) renderEquity(state.result);
}));
syncEqControls();

// Points of the overview chart. "trades": one point per closed trade (point 0 = start).
// "time": one point per bar.
function equityPoints(res) {
  const s = res.strategy;
  const d = state.data;
  const init = s.metrics.initialCapital;
  const p0 = d.open[0];
  const pts = [];
  if (eqPrefs.axis === 'trades') {
    pts.push({ label: 'Start', bar: 0, equity: init, trade: null });
    for (const t of s.trades) pts.push({ label: `#${t.num}`, bar: t.exitBar, equity: init + t.cumProfit, trade: t });
  } else {
    let lastTrade = 0;
    for (let i = 0; i < d.time.length; i++) {
      let trade = null;
      while (lastTrade < s.trades.length && s.trades[lastTrade].exitBar === i) trade = s.trades[lastTrade++];
      pts.push({ label: fmtTime(d.time[i]), bar: i, equity: s.equity[i], trade });
    }
  }
  let peak = -Infinity;
  for (const p of pts) {
    if (Number.isFinite(p.equity)) peak = Math.max(peak, p.equity);
    p.dd = Number.isFinite(p.equity) ? peak - p.equity : NaN;
    p.ddPct = peak > 0 ? (p.dd / peak) * 100 : NaN;
    p.bh = init * (d.close[p.bar] / p0);
  }
  return { pts, init };
}

function renderEquity(res) {
  const s = res.strategy;
  if (!s) return;
  const th = chartTheme();
  if (state.eqChart) state.eqChart.remove();
  const byTrade = eqPrefs.axis === 'trades';
  const pct = eqPrefs.mode === 'pct';
  const { pts, init } = equityPoints(res);
  const intraday = state.data.time.length > 1 && state.data.time[1] - state.data.time[0] < 86400000;
  const opts = baseChartOptions(th, intraday && !byTrade);
  opts.layout.attributionLogo = false;
  opts.handleScale = { mouseWheel: true, pinch: true, axisPressedMouseMove: true };
  // Trade axis: the chart library only knows time, so trade k sits at day k and its labels show the trade number.
  const DAY = 86400;
  const xs = byTrade ? pts.map((_, k) => (k + 1) * DAY) : state.data.time.map(chartTime);
  if (byTrade) {
    opts.timeScale.tickMarkFormatter = (t) => String(Math.round(t / DAY) - 1);
    opts.localization = { timeFormatter: (t) => { const k = Math.round(t / DAY) - 1; return k === 0 ? 'Start' : `Trade #${k}`; } };
    opts.timeScale.rightOffset = 2;
  }
  const money = (v) => `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  const pctFmt = (v) => `${v.toFixed(2)}%`;
  const fmtVal = pct ? pctFmt : money;
  opts.localization = { ...(opts.localization || {}), priceFormatter: fmtVal };
  const ch = LW.createChart($('equityChart'), opts);
  state.eqChart = ch;

  const toVal = (equity) => (pct ? (equity / init - 1) * 100 : equity);
  const showEx = eqPrefs.excursions;
  const mainMargins = { top: 0.12, bottom: showEx ? 0.3 : 0.06 };

  let eqSeries = null;
  if (eqPrefs.equity) {
    eqSeries = ch.addSeries(LW.BaselineSeries, {
      baseValue: { type: 'price', price: pct ? 0 : init },
      topLineColor: th.up, topFillColor1: withAlpha(th.up, 0.32), topFillColor2: withAlpha(th.up, 0.05),
      bottomLineColor: th.down, bottomFillColor1: withAlpha(th.down, 0.05), bottomFillColor2: withAlpha(th.down, 0.32),
      lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'Equity',
      pointMarkersVisible: byTrade && pts.length <= 60, pointMarkersRadius: 2.5,
    });
    eqSeries.priceScale().applyOptions({ scaleMargins: mainMargins });
    eqSeries.setData(pts.map((p, k) => (Number.isFinite(p.equity) ? { time: xs[k], value: toVal(p.equity) } : { time: xs[k] })));
    eqSeries.createPriceLine({ price: pct ? 0 : init, color: withAlpha(th.fg, 0.5), lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
  }
  if (eqPrefs.buyhold) {
    const bh = ch.addSeries(LW.LineSeries, {
      color: withAlpha(th.fg, 0.75), lineWidth: 1, lineStyle: 0, priceLineVisible: false, title: 'Buy & hold',
      priceScaleId: eqPrefs.equity ? 'right' : 'right',
    });
    bh.priceScale().applyOptions({ scaleMargins: mainMargins });
    bh.setData(pts.map((p, k) => ({ time: xs[k], value: toVal(p.bh) })));
  }
  if (eqPrefs.drawdown) {
    // hangs from the top of the pane on its own inverted scale
    const dd = ch.addSeries(LW.HistogramSeries, {
      priceScaleId: 'dd', color: withAlpha(th.down, 0.28), priceLineVisible: false, lastValueVisible: false, base: 0,
      priceFormat: { type: 'custom', formatter: (v) => `−${fmtVal(Math.abs(v))}` },
    });
    dd.priceScale().applyOptions({ invertScale: true, scaleMargins: { top: 0, bottom: 0.7 }, visible: false });
    dd.setData(pts.map((p, k) => ({ time: xs[k], value: (pct ? p.ddPct : p.dd) || 0 })));
  }
  if (showEx) {
    // per-trade best (run-up) and worst (drawdown) open profit, at the trade's exit
    const exOpts = { priceScaleId: 'ex', priceLineVisible: false, lastValueVisible: false, base: 0 };
    const up = ch.addSeries(LW.HistogramSeries, { ...exOpts, color: withAlpha(th.up, 0.8) });
    const dn = ch.addSeries(LW.HistogramSeries, { ...exOpts, color: withAlpha(th.down, 0.8) });
    up.priceScale().applyOptions({ scaleMargins: { top: 0.76, bottom: 0.02 }, visible: false });
    const rel = (v, t) => (pct ? (t.entryValue ? (v / t.entryValue) * 100 : NaN) : v);
    const upData = [];
    const dnData = [];
    pts.forEach((p, k) => {
      if (!p.trade) { upData.push({ time: xs[k] }); dnData.push({ time: xs[k] }); return; }
      upData.push({ time: xs[k], value: rel(p.trade.runup, p.trade) || 0 });
      dnData.push({ time: xs[k], value: -(rel(p.trade.drawdown, p.trade) || 0) });
    });
    up.setData(upData);
    dn.setData(dnData);
  }
  ch.timeScale().fitContent();

  // hover readout
  const legend = $('equityLegend');
  const show = (k) => {
    if (k === undefined || k < 0 || k >= pts.length) k = pts.length - 1;
    const p = pts[k];
    const parts = [`<b>${esc(byTrade ? (k === 0 ? 'Start' : `Trade #${k}`) : p.label)}</b>`];
    if (Number.isFinite(p.equity)) {
      const net = p.equity - init;
      parts.push(`Equity <span class="${signCls(net)}">${esc(pct ? pctFmt(toVal(p.equity)) : money(p.equity))}</span>`);
    }
    if (eqPrefs.drawdown && Number.isFinite(p.dd)) parts.push(`Drawdown <span class="${p.dd > 0 ? 'neg' : ''}">${esc(pct ? pctFmt(-p.ddPct || 0) : money(-p.dd))}</span>`);
    if (p.trade) {
      const t = p.trade;
      parts.push(`P&L <span class="${signCls(t.profit)}">${esc(pct ? pctFmt(t.profitPct) : money(t.profit))}</span>`);
      if (eqPrefs.excursions) parts.push(`Run-up ${esc(money(t.runup))} · Trade DD ${esc(money(-t.drawdown))}`);
      if (byTrade) parts.push(esc(`${t.dir > 0 ? 'Long' : 'Short'} ${fmtTime(t.exitTime)}`));
    }
    if (eqPrefs.buyhold) parts.push(`Buy & hold ${esc(pct ? pctFmt(toVal(p.bh)) : money(p.bh))}`);
    legend.innerHTML = parts.map((x) => `<span>${x}</span>`).join('');
  };
  show();
  ch.subscribeCrosshairMove((param) => show(param && param.logical !== undefined ? Math.round(param.logical) : undefined));
  if (byTrade && pts.length === 1) legend.innerHTML = '<span>No closed trades yet.</span>';
}

function renderPerformance(m) {
  const rows = [
    ['Net profit', (g) => g.netProfit, 'money', (g) => (g.netProfit / m.initialCapital) * 100],
    ['Gross profit', (g) => g.grossProfit, 'money', (g) => (g.grossProfit / m.initialCapital) * 100],
    ['Gross loss', (g) => g.grossLoss, 'money', (g) => (g.grossLoss / m.initialCapital) * 100],
    ['Commission paid', (g) => g.commission, 'money'],
    ['Profit factor', (g) => g.profitFactor, 'num3'],
    ['Total closed trades', (g) => g.totalTrades, 'int'],
    ['Number winning trades', (g) => g.winningTrades, 'int'],
    ['Number losing trades', (g) => g.losingTrades, 'int'],
    ['Percent profitable', (g) => g.percentProfitable, 'pct'],
    ['Avg trade', (g) => g.avgTrade, 'money', (g) => g.avgTradePct],
    ['Avg winning trade', (g) => g.avgWin, 'money', (g) => g.avgWinPct],
    ['Avg losing trade', (g) => g.avgLoss, 'money', (g) => g.avgLossPct],
    ['Ratio avg win / avg loss', (g) => g.ratioAvgWinLoss, 'num3'],
    ['Largest winning trade', (g) => g.largestWin, 'money', (g) => g.largestWinPct],
    ['Largest losing trade', (g) => g.largestLoss, 'money', (g) => g.largestLossPct],
    ['Avg # bars in trades', (g) => g.avgBars, 'int0'],
    ['Avg # bars in winning trades', (g) => g.avgBarsWin, 'int0'],
    ['Avg # bars in losing trades', (g) => g.avgBarsLoss, 'int0'],
  ];
  const f = (v, kind) => (kind === 'money' ? fmtMoney(v) : kind === 'pct' ? fmtPct(v) : kind === 'num3' ? fmtNum(v, 3) : kind === 'int0' ? fmtNum(v, 0) : String(v));
  const cell = (g, [, get, kind, sub]) => `<td class="mono">${f(get(g), kind)}${sub ? `<span class="sub">${fmtPct(sub(g))}</span>` : ''}</td>`;
  const top = [
    ['Initial capital', fmtMoney(m.initialCapital)],
    ['Open P&L', fmtMoney(m.openPL)],
    ['Max equity run-up', `${fmtMoney(m.maxRunup)} <span class="sub">${fmtPct(m.maxRunupPct)}</span>`],
    ['Max equity drawdown', `${fmtMoney(m.maxDrawdown)} <span class="sub">${fmtPct(m.maxDrawdownPct)}</span>`],
    ['Buy & hold return', `${fmtMoney(m.buyHoldReturn)} <span class="sub">${fmtPct(m.buyHoldReturnPct)}</span>`],
    ['Sharpe ratio', fmtNum(m.sharpe, 3)],
    ['Sortino ratio', fmtNum(m.sortino, 3)],
    ['Max contracts held', fmtQty(m.maxContracts)],
  ];
  $('tab-performance').innerHTML = `<table class="grid"><thead><tr><th>Metric</th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${r[0]}</td>${cell(m.all, r)}${cell(m.long, r)}${cell(m.short, r)}</tr>`).join('')}
    ${top.map(([k, v]) => `<tr><td>${k}</td><td class="mono">${v}</td><td></td><td></td></tr>`).join('')}
  </tbody></table>`;
}

function renderTrades(s) {
  const dec = priceDecimals(state.result.mintick);
  const rows = [];
  for (const t of [...s.openTrades].reverse()) {
    rows.push(`<tr data-a="${t.entryBar}" data-b="${state.data.time.length - 1}">
      <td class="mono">—</td><td><span class="pill ${t.dir > 0 ? 'long' : 'short'}">${t.dir > 0 ? 'Long' : 'Short'}</span> <span class="pill open">Open</span></td>
      <td>${esc(t.entryId)}<span class="sub">${fmtTime(t.entryTime)}</span></td><td class="mono">${t.entryPrice.toFixed(dec)}</td>
      <td>—</td><td class="mono">—</td>
      <td class="mono">${fmtQty(t.qty)}</td>
      <td class="mono ${signCls(t.profit)}">${fmtMoney(t.profit)}</td><td></td><td></td><td></td></tr>`);
  }
  for (const t of [...s.trades].reverse()) {
    rows.push(`<tr data-a="${t.entryBar}" data-b="${t.exitBar}">
      <td class="mono">${t.num}</td><td><span class="pill ${t.dir > 0 ? 'long' : 'short'}">${t.dir > 0 ? 'Long' : 'Short'}</span></td>
      <td>${esc(t.entryId)}<span class="sub">${fmtTime(t.entryTime)}</span></td><td class="mono">${t.entryPrice.toFixed(dec)}</td>
      <td>${esc(t.exitId)}<span class="sub">${fmtTime(t.exitTime)}</span></td><td class="mono">${t.exitPrice.toFixed(dec)}</td>
      <td class="mono">${fmtQty(t.qty)}</td>
      <td class="mono ${signCls(t.profit)}">${fmtMoney(t.profit)}<span class="sub">${fmtPct(t.profitPct)}</span></td>
      <td class="mono">${fmtMoney(t.cumProfit)}</td>
      <td class="mono">${fmtMoney(t.runup)}</td><td class="mono">${fmtMoney(t.drawdown)}</td></tr>`);
  }
  $('tab-trades').innerHTML = rows.length
    ? `<table class="grid trades"><thead><tr><th>#</th><th>Side</th><th>Entry signal</th><th>Entry price</th><th>Exit signal</th><th>Exit price</th><th>Qty</th><th>Profit</th><th>Cum. profit</th><th>Run-up</th><th>Drawdown</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : '<div class="empty">No trades yet. The strategy never placed an order that filled on this data.</div>';
  $('tab-trades').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
    const a = +tr.dataset.a, b = +tr.dataset.b;
    const pad = Math.max(15, Math.round((b - a) * 0.6));
    state.chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  }));
}

function renderProperties(cfg, res) {
  const qtyType = { fixed: 'Contracts', cash: 'Cash', percent_of_equity: '% of equity' }[cfg.default_qty_type] || cfg.default_qty_type;
  const comm = { percent: '%', cash_per_contract: 'per contract', cash_per_order: 'per order' }[cfg.commission_type] || '';
  const items = [
    ['Symbol', `${state.symbol} (${state.dataLabel})`],
    ['Timeframe', res.timeframe],
    ['Bars', state.data.time.length.toLocaleString()],
    ['Range', `${fmtTime(state.data.time[0])} → ${fmtTime(state.data.time[state.data.time.length - 1])}`],
    ['Tick size (syminfo.mintick)', String(res.mintick)],
    ['Point value (syminfo.pointvalue)', String(res.pointvalue ?? 1)],
    ['Time zone', state.tz],
    ['Initial capital', fmtMoney(cfg.initial_capital)],
    ['Order size', `${fmtQty(cfg.default_qty_value)} ${qtyType}`],
    ['Pyramiding', String(cfg.pyramiding || 0)],
    ['Commission', `${cfg.commission_value || 0} ${comm}`],
    ['Slippage', `${cfg.slippage || 0} ticks`],
    ['Fill orders', cfg.process_orders_on_close ? 'On bar close' : 'On next bar open'],
    ['Intrabar price path', 'Open → nearer of high/low → other extreme → close'],
  ];
  const inputs = res.inputs.map((i) => [i.title, String(state.inputOverrides[i.key] ?? i.defval)]);
  $('tab-properties').innerHTML = `<dl class="props">${items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
    ${inputs.length ? `<dt style="grid-column:1/-1;padding-top:8px;font-weight:600">Inputs</dt>${inputs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}` : ''}</dl>`;
}

// -------------------------------------------------------------- settings
function openSettings() {
  const res = state.result;
  const inputs = res ? res.inputs : [];
  const box = $('stab-inputs');
  if (!inputs.length) box.innerHTML = '<p class="hint">This script has no inputs. Add some with <code>input.int()</code>, <code>input.float()</code>, <code>input.bool()</code>, <code>input.source()</code>…</p>';
  else {
    let lastGroup;
    box.innerHTML = inputs.map((inp, idx) => {
      const id = `in_${idx}`;
      const cur = state.inputOverrides[inp.key] ?? inp.defval;
      let ctl;
      if (inp.type === 'bool') ctl = `<input type="checkbox" id="${id}" ${cur ? 'checked' : ''}>`;
      else if (inp.type === 'source') ctl = `<select class="field" id="${id}">${SOURCES.map((s) => `<option ${s === cur ? 'selected' : ''}>${s}</option>`).join('')}</select>`;
      else if (inp.options) ctl = `<select class="field" id="${id}">${inp.options.map((o) => `<option ${String(o) === String(cur) ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
      else if (inp.type === 'int' || inp.type === 'float' || inp.type === 'price') {
        ctl = `<input class="field" type="number" id="${id}" value="${esc(cur)}" ${inp.minval !== undefined ? `min="${inp.minval}"` : ''} ${inp.maxval !== undefined ? `max="${inp.maxval}"` : ''} step="${inp.step ?? (inp.type === 'int' ? 1 : 'any')}">`;
      } else if (inp.type === 'time') {
        const v = new Date(+cur).toISOString().slice(0, 16);
        ctl = `<input class="field" type="datetime-local" id="${id}" value="${v}">`;
      } else if (inp.type === 'color') {
        ctl = `<input class="field" type="color" id="${id}" value="${esc(String(cur).slice(0, 7))}">`;
      } else ctl = `<input class="field" type="text" id="${id}" value="${esc(cur)}">`;
      const grp = inp.group && inp.group !== lastGroup ? `<div class="grp">${esc(inp.group)}</div>` : '';
      lastGroup = inp.group;
      return `${grp}<label class="row-field" for="${id}"${inp.tooltip ? ` title="${esc(inp.tooltip)}"` : ''}><span>${esc(inp.title)}${inp.tooltip ? ' <span class="hint" aria-hidden="true">ⓘ</span>' : ''}</span>${ctl}</label>`;
    }).join('');
  }
  const cfg = res && res.strategy ? res.strategy.config : null;
  const props = $('stab-props');
  if (!cfg) props.innerHTML = '<p class="hint">Properties apply to strategies. Declare the script with <code>strategy()</code>.</p>';
  else {
    const p = (k) => state.propOverrides[k] ?? cfg[k];
    props.innerHTML = `
      <label class="row-field" for="pr_cap"><span>Initial capital</span><input class="field" type="number" id="pr_cap" value="${p('initial_capital')}" min="0" step="any"></label>
      <label class="row-field" for="pr_qty"><span>Order size</span><input class="field" type="number" id="pr_qty" value="${p('default_qty_value')}" min="0" step="any"></label>
      <label class="row-field" for="pr_qtyt"><span>Order size unit</span><select class="field" id="pr_qtyt">
        ${[['fixed', 'Contracts'], ['cash', 'Cash'], ['percent_of_equity', '% of equity']].map(([v, l]) => `<option value="${v}" ${p('default_qty_type') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row-field" for="pr_pyr"><span>Pyramiding (orders)</span><input class="field" type="number" id="pr_pyr" value="${p('pyramiding') || 0}" min="0" step="1"></label>
      <label class="row-field" for="pr_comm"><span>Commission</span><input class="field" type="number" id="pr_comm" value="${p('commission_value') || 0}" min="0" step="any"></label>
      <label class="row-field" for="pr_commt"><span>Commission unit</span><select class="field" id="pr_commt">
        ${[['percent', '%'], ['cash_per_contract', 'Cash per contract'], ['cash_per_order', 'Cash per order']].map(([v, l]) => `<option value="${v}" ${p('commission_type') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row-field" for="pr_slip"><span>Slippage (ticks)</span><input class="field" type="number" id="pr_slip" value="${p('slippage') || 0}" min="0" step="1"></label>
      <label class="row-field" for="pr_poc"><span>Fill orders on bar close</span><input type="checkbox" id="pr_poc" ${p('process_orders_on_close') ? 'checked' : ''}></label>
      <div class="grp">Symbol</div>
      <label class="row-field" for="pr_pv"><span>Point value (currency per point per contract)</span><input class="field" type="number" id="pr_pv" value="${state.spec.pointvalue}" min="0" step="any"></label>
      <label class="row-field" for="pr_tick"><span>Tick size (syminfo.mintick)</span><input class="field" type="number" id="pr_tick" value="${state.spec.mintick || res.mintick}" min="0" step="any"></label>
      <p class="hint">Futures need these to match the contract: MNQ is $2 per point with a 0.25 tick, NQ $20, MES $5, ES $50. They fill in automatically when the file or symbol name contains the contract code.</p>
      <p class="hint">These override the values in the script's <code>strategy()</code> call, like the Properties tab of a strategy's settings.</p>`;
  }
  $('settingsTitle').textContent = res ? `${res.title} settings` : 'Settings';
  $('settingsModal').hidden = false;
}
function closeSettings() { $('settingsModal').hidden = true; }
function applySettings() {
  const res = state.result;
  if (res) {
    res.inputs.forEach((inp, idx) => {
      const el = $(`in_${idx}`);
      if (!el) return;
      let v;
      if (inp.type === 'bool') v = el.checked;
      else if (inp.type === 'int') v = Math.round(+el.value);
      else if (inp.type === 'float' || inp.type === 'price') v = +el.value;
      else if (inp.type === 'time') v = Date.parse(`${el.value}:00Z`);
      else v = el.value;
      if (v === inp.defval) delete state.inputOverrides[inp.key];
      else state.inputOverrides[inp.key] = v;
    });
    if (res.strategy && $('pr_cap')) {
      const next = {
        initial_capital: +$('pr_cap').value, default_qty_value: +$('pr_qty').value, default_qty_type: $('pr_qtyt').value,
        pyramiding: Math.round(+$('pr_pyr').value), commission_value: +$('pr_comm').value, commission_type: $('pr_commt').value,
        slippage: Math.round(+$('pr_slip').value), process_orders_on_close: $('pr_poc').checked,
      };
      const pv = +$('pr_pv').value;
      const tick = +$('pr_tick').value;
      if (pv > 0) state.spec.pointvalue = pv;
      if (tick > 0 && tick !== state.result.mintick) state.spec.mintick = tick;
      showDataInfo();
      // keep only values that differ from what the script itself declares
      const declared = res.strategy.declared;
      state.propOverrides = {};
      for (const [k, v] of Object.entries(next)) if (v !== declared[k] && !(Number.isNaN(v))) state.propOverrides[k] = v;
    }
  }
  store.set('inputs', state.inputOverrides);
  store.set('props', state.propOverrides);
  closeSettings();
  run();
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', closeSettings);
$('settingsApply').addEventListener('click', applySettings);
$('settingsReset').addEventListener('click', () => {
  state.inputOverrides = {};
  state.propOverrides = {};
  store.set('inputs', {});
  store.set('props', {});
  closeSettings();
  run();
});
$('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettings(); });
document.querySelectorAll('.modal .tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.modal .tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  $('stab-inputs').hidden = b.dataset.stab !== 'inputs';
  $('stab-props').hidden = b.dataset.stab !== 'props';
}));

// re-render charts when the theme flips
const rerender = () => { if (state.result) { renderChart(state.result); if (!$('tab-overview').hidden) renderEquity(state.result); } };
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', rerender);
new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ----------------------------------------------------------------- boot
code.value = store.get('code', EXAMPLES[0].code);
refreshEditor();
// Boot: use downloaded market data when the local server is running, else the offline sample.
(async () => {
  try {
    const r = await fetch('/api/ping', { cache: 'no-store' });
    state.server = r.ok && (await r.json()).ok === true;
  } catch { state.server = false; }
  const marketOpt = document.querySelector('#dataSource option[value="market"]');
  if (marketOpt && !state.server) marketOpt.textContent = 'Market data (run node serve.mjs)';
  const saved = store.get('source', state.server ? 'market' : 'sample');
  const want = saved === 'market' && !state.server ? 'sample' : saved;
  $('dataSource').value = [...$('dataSource').options].some((o) => o.value === want) ? want : 'sample';
  if ($('dataSource').value === 'csv' || $('dataSource').value === 'binance') {
    setSourceUI(false);
    loadSample(); // nothing to show until a file is opened / Load is pressed
  } else setSourceUI();
})();

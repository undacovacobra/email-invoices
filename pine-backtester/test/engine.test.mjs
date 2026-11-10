import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parser.js';
import { runScript } from '../src/runtime.js';

// Build a dataset from [open, high, low, close] rows (daily bars).
function bars(rows) {
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  rows.forEach(([o, h, l, c, v = 100], i) => {
    d.time.push(Date.UTC(2024, 0, 1) + i * 86400000);
    d.open.push(o); d.high.push(h); d.low.push(l); d.close.push(c); d.volume.push(v);
  });
  return d;
}
function series(closes) {
  return bars(closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return [o, Math.max(o, c) + 1, Math.min(o, c) - 1, c];
  }));
}
const randomCloses = (n, seed = 7) => {
  let s = seed, p = 100;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 16807) % 2147483647;
    p = +(p * (1 + (s / 2147483647 - 0.5) * 0.05)).toFixed(2);
    out.push(p);
  }
  return out;
};
const plot = (res, title) => res.plots.find((p) => p.title === title).values;
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ------------------------------------------------------------------ parsing
test('parses wrapped lines, functions, tuples and switch', () => {
  const ast = parse(`//@version=5
indicator("t")
f(x, y = 2) =>
    s = x + y
    s * 2
[a, b] = [1,
     2]
cond = close > open and
     volume > 0
x = switch
    cond => 1
    => 0
`);
  const types = ast.body.map((s) => s.type);
  assert.deepEqual(types, ['ExprStmt', 'FuncDef', 'TupleDecl', 'VarDecl', 'VarDecl']);
});

test('reports syntax errors with a line number', () => {
  assert.throws(() => parse('indicator("x")\na = (1 +\n'), /line/);
  assert.throws(() => parse('indicator("x")\nif close >\n    1'), /line 2/);
});

// --------------------------------------------------------------- semantics
test('history operator, var, := and na handling', () => {
  const d = series([10, 11, 12, 13, 14]);
  const res = runScript(`indicator("t")
var count = 0
count := count + 1
prev = close[1]
plot(prev, "prev")
plot(count, "count")
plot(nz(close[10], -1), "nz")
plot(bar_index, "bi")
`, d);
  assert.ok(Number.isNaN(plot(res, 'prev')[0]));
  assert.equal(plot(res, 'prev')[3], 12);
  assert.deepEqual(plot(res, 'count'), [1, 2, 3, 4, 5]);
  assert.equal(plot(res, 'nz')[4], -1);
  assert.deepEqual(plot(res, 'bi'), [0, 1, 2, 3, 4]);
});

test('if / for / while / ternary / switch expressions', () => {
  const d = series([1, 2, 3, 4, 5, 6]);
  const res = runScript(`indicator("t")
total = 0.0
for i = 0 to 2
    total += close[i]
k = 0
while k < 3
    k += 1
y = if close > 3
    1
else if close > 2
    2
else
    3
z = switch
    close >= 5 => "hi"
    => "lo"
plot(total, "sum")
plot(k, "k")
plot(y, "y")
plot(z == "hi" ? 1 : 0, "z")
`, d);
  close(plot(res, 'sum')[5], 6 + 5 + 4);
  assert.equal(plot(res, 'k')[0], 3);
  assert.deepEqual(plot(res, 'y'), [3, 3, 2, 1, 1, 1]);
  assert.deepEqual(plot(res, 'z'), [0, 0, 0, 0, 1, 1]);
});

test('ta calls inside a user function keep separate state per call site', () => {
  const closes = randomCloses(50);
  const d = series(closes);
  const res = runScript(`indicator("t")
avg(src) => ta.sma(src, 5)
plot(avg(close), "a")
plot(avg(open), "b")
plot(ta.sma(close, 5), "ref")
`, d);
  assert.deepEqual(plot(res, 'a'), plot(res, 'ref'));
  assert.notDeepEqual(plot(res, 'a'), plot(res, 'b'));
});

// ----------------------------------------------------------- indicators
test('sma / ema / rma / rsi / atr match the Pine reference formulas', () => {
  const closes = randomCloses(120);
  const d = series(closes);
  const res = runScript(`indicator("t")
plot(ta.sma(close, 14), "sma")
plot(ta.ema(close, 14), "ema")
plot(ta.rsi(close, 14), "rsi")
plot(ta.atr(14), "atr")
[m, s, h] = ta.macd(close, 12, 26, 9)
plot(h, "hist")
`, d);
  // reference implementations written straight from the Pine manual
  const sma = (a, i, n) => (i < n - 1 ? NaN : a.slice(i - n + 1, i + 1).reduce((x, y) => x + y, 0) / n);
  const smooth = (src, n, alpha) => {
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const prev = out[i - 1];
      if (prev === undefined || Number.isNaN(prev)) {
        const w = src.slice(Math.max(0, i - n + 1), i + 1);
        out.push(i >= n - 1 && w.every((v) => !Number.isNaN(v)) ? w.reduce((x, y) => x + y, 0) / n : NaN);
      } else out.push(alpha * src[i] + (1 - alpha) * prev);
    }
    return out;
  };
  const ema = smooth(closes, 14, 2 / 15);
  const up = closes.map((c, i) => (i ? Math.max(c - closes[i - 1], 0) : NaN));
  const dn = closes.map((c, i) => (i ? Math.max(closes[i - 1] - c, 0) : NaN));
  const ru = smooth(up, 14, 1 / 14), rd = smooth(dn, 14, 1 / 14);
  const rsi = ru.map((u, i) => 100 - 100 / (1 + u / rd[i]));
  const tr = d.close.map((_, i) => (i ? Math.max(d.high[i] - d.low[i], Math.abs(d.high[i] - d.close[i - 1]), Math.abs(d.low[i] - d.close[i - 1])) : d.high[0] - d.low[0]));
  const atr = smooth(tr, 14, 1 / 14);
  for (let i = 0; i < closes.length; i++) {
    const check = (name, ref) => {
      const v = plot(res, name)[i];
      if (Number.isNaN(ref)) assert.ok(Number.isNaN(v), `${name}[${i}] should be na, got ${v}`);
      else close(v, ref, 1e-7);
    };
    check('sma', sma(closes, i, 14));
    check('ema', ema[i]);
    check('rsi', rsi[i]);
    check('atr', atr[i]);
  }
  assert.ok(Number.isNaN(plot(res, 'rsi')[13]));
  assert.ok(!Number.isNaN(plot(res, 'rsi')[14]));
  assert.ok(!Number.isNaN(plot(res, 'hist')[33]));
});

test('crossover / crossunder / highest / lowest / barssince / valuewhen', () => {
  const d = series([1, 2, 3, 2, 1, 2, 3, 4]);
  const res = runScript(`indicator("t")
plot(ta.crossover(close, 2.5) ? 1 : 0, "xo")
plot(ta.crossunder(close, 1.5) ? 1 : 0, "xu")
plot(ta.highest(close, 3), "hh")
plot(ta.lowest(close, 3), "ll")
plot(ta.barssince(close == 1), "bs")
plot(ta.valuewhen(close == 3, bar_index, 0), "vw")
`, d);
  assert.deepEqual(plot(res, 'xo'), [0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual(plot(res, 'xu'), [0, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(plot(res, 'hh').slice(2), [3, 3, 3, 2, 3, 4]);
  assert.deepEqual(plot(res, 'll').slice(2), [1, 2, 1, 1, 1, 2]);
  assert.deepEqual(plot(res, 'bs'), [0, 1, 2, 3, 0, 1, 2, 3]);
  assert.deepEqual(plot(res, 'vw').slice(2), [2, 2, 2, 2, 6, 6]);
});

// -------------------------------------------------------- broker emulator
test('market entry fills at the next bar open; percent_of_equity sizes off the signal bar close', () => {
  const d = bars([
    [10, 11, 9, 10], [10, 12, 9, 11], [12, 13, 11, 12], [13, 14, 12, 13], [14, 15, 13, 14],
  ]);
  const res = runScript(`strategy("t", initial_capital=1000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 3
    strategy.close("L")
`, d);
  const [t] = res.strategy.trades;
  assert.equal(res.strategy.trades.length, 1);
  assert.equal(t.entryBar, 2);
  assert.equal(t.entryPrice, 12); // open of bar 2
  close(t.qty, 1000 / 11); // equity / close of bar 1
  assert.equal(t.exitBar, 4);
  assert.equal(t.exitPrice, 14);
  close(t.profit, (14 - 12) * (1000 / 11));
  assert.equal(t.exitId, 'Close entry(s) order L');
});

test('process_orders_on_close fills at the signal bar close', () => {
  const d = bars([[10, 11, 9, 10], [10, 12, 9, 11], [12, 13, 11, 12], [13, 14, 12, 13]]);
  const res = runScript(`strategy("t", process_orders_on_close=true)
if bar_index == 1
    strategy.entry("L", strategy.long)
if bar_index == 2
    strategy.close("L")
`, d);
  const [t] = res.strategy.trades;
  assert.equal(t.entryBar, 1);
  assert.equal(t.entryPrice, 11);
  assert.equal(t.exitPrice, 12);
  assert.equal(t.qty, 1); // default: 1 contract
});

test('opposite entry reverses the position; pyramiding limits same-direction entries', () => {
  const d = bars(Array.from({ length: 8 }, (_, i) => [10 + i, 11 + i, 9 + i, 10 + i]));
  const res = runScript(`strategy("t")
if bar_index < 3
    strategy.entry("L" + str.tostring(bar_index), strategy.long)
if bar_index == 4
    strategy.entry("S", strategy.short, qty=2)
`, d);
  const tr = res.strategy.trades;
  // pyramiding=0 -> only the first long is accepted
  assert.equal(tr.length, 1);
  assert.equal(tr[0].entryId, 'L0');
  assert.equal(tr[0].exitId, 'S');
  assert.equal(tr[0].exitBar, 5);
  assert.equal(res.strategy.openTrades.length, 1);
  assert.equal(res.strategy.openTrades[0].dir, -1);
  assert.equal(res.strategy.openTrades[0].qty, 2);

  const res2 = runScript(`strategy("t", pyramiding=3)
if bar_index < 5
    strategy.entry("L" + str.tostring(bar_index), strategy.long)
`, d);
  assert.equal(res2.strategy.openTrades.length, 3);
});

test('strategy.exit take-profit / stop-loss in ticks, with the intrabar path deciding which hits first', () => {
  // bar 2: open 100, high 103 (closer to open) then low 97 -> TP at 102 hits before SL at 98
  const d = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 103, 97, 100], [100, 100, 100, 100]]);
  const script = `strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", profit=200, loss=200)
`;
  const res = runScript(script, d, { mintick: 0.01 });
  assert.equal(res.strategy.trades[0].exitPrice, 102);
  assert.equal(res.strategy.trades[0].exitId, 'X');
  // now the low is nearer the open -> path goes to the low first -> stop hits
  const d2 = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100, 105, 98.5, 100], [100, 100, 100, 100]]);
  const res2 = runScript(script.replace('loss=200', 'loss=100'), d2, { mintick: 0.01 });
  assert.equal(res2.strategy.trades[0].exitPrice, 99);
});

test('stop and limit orders fill at the open when the bar gaps through the level', () => {
  const d = bars([[100, 101, 99, 100], [100, 101, 99, 100], [110, 112, 109, 111], [111, 112, 100, 101], [90, 91, 80, 85]]);
  const res = runScript(`strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long, stop=105)
if strategy.position_size > 0
    strategy.exit("SL", "L", stop=95)
`, d);
  const [t] = res.strategy.trades;
  assert.equal(t.entryPrice, 110); // gapped above the 105 buy stop
  assert.equal(t.exitBar, 4);
  assert.equal(t.exitPrice, 90); // gapped below the 95 stop
});

test('trailing stop follows the high once activated', () => {
  const d = bars([
    [100, 100, 100, 100], [100, 100, 100, 100],
    [100, 110, 100, 110], // up to 110: activates (>=101) and trails at 110 - 2 = 108
    [110, 110, 105, 106], // falls through 108
  ]);
  const res = runScript(`strategy("t")
if bar_index == 1
    strategy.entry("L", strategy.long)
    strategy.exit("T", "L", trail_points=100, trail_offset=200)
`, d, { mintick: 0.01 });
  const [t] = res.strategy.trades;
  assert.equal(t.exitBar, 3);
  close(t.exitPrice, 108);
});

test('commission and the performance summary', () => {
  const d = bars([[10, 10, 10, 10], [10, 10, 10, 10], [10, 12, 10, 12], [12, 12, 12, 12], [12, 12, 8, 8], [8, 8, 8, 8], [8, 8, 8, 8]]);
  const res = runScript(`strategy("t", initial_capital=1000, commission_type=strategy.commission.percent, commission_value=0.1)
if bar_index == 0 or bar_index == 3
    strategy.entry("L", strategy.long, qty=10)
if bar_index == 2 or bar_index == 5
    strategy.close("L")
`, d);
  const m = res.strategy.metrics;
  const [a, b] = res.strategy.trades;
  close(a.profit, (12 - 10) * 10 - 0.1 - 0.12); // bought 10@10, sold 10@12
  close(b.profit, (8 - 12) * 10 - 0.12 - 0.08);
  assert.equal(m.all.totalTrades, 2);
  assert.equal(m.all.winningTrades, 1);
  close(m.all.netProfit, a.profit + b.profit);
  close(m.all.profitFactor, a.profit / -b.profit);
  close(m.commissionPaid, 0.1 + 0.12 + 0.12 + 0.08);
  assert.ok(m.maxDrawdown > 0);
});

test('inputs can be overridden from the settings panel', () => {
  const d = series(randomCloses(60));
  const src = `indicator("t")
len = input.int(5, "Length", minval=1)
src = input.source(close, "Source")
plot(ta.sma(src, len), "ma")
`;
  const a = runScript(src, d);
  assert.deepEqual(a.inputs.map((i) => [i.key, i.type, i.defval]), [['Length', 'int', 5], ['Source', 'source', 'close']]);
  const b = runScript(src, d, { inputs: { Length: 10, Source: 'open' } });
  assert.ok(Number.isNaN(plot(b, 'ma')[8]));
  assert.ok(!Number.isNaN(plot(a, 'ma')[8]));
});

test('arrays and method-call syntax', () => {
  const d = series([1, 2, 3, 4]);
  const res = runScript(`indicator("t")
var a = array.new_float()
a.push(close)
if a.size() > 2
    a.shift()
plot(array.sum(a), "s")
plot(a.size(), "n")
`, d);
  assert.deepEqual(plot(res, 's'), [1, 3, 5, 7]);
  assert.deepEqual(plot(res, 'n'), [1, 2, 2, 2]);
});

test('runtime errors point at the offending line', () => {
  const d = series([1, 2, 3]);
  assert.throws(() => runScript('indicator("t")\nplot(foo)', d), /line 2: Undeclared identifier 'foo'/);
  assert.throws(() => runScript('indicator("t")\nx = 1\nx := nope(1)', d), /line 3/);
});

// ------------------------------------------------- user types, security, futures
test('user-defined types: new, field read/write, na objects, int fields', () => {
  const d = series([1, 2, 3, 4]);
  const res = runScript(`indicator("t")
type Box
    int   count
    float level = 5.5
var Box b = na
if na(b)
    b := Box.new(0)
b.count := b.count + 1
b.level += 1
x = b.count / 2
plot(b.count, "count")
plot(b.level, "level")
plot(not na(b) ? 1 : 0, "set")
`, d);
  assert.deepEqual(plot(res, 'count'), [1, 2, 3, 4]);
  assert.deepEqual(plot(res, 'level'), [6.5, 7.5, 8.5, 9.5]);
  assert.deepEqual(plot(res, 'set'), [1, 1, 1, 1]);
});

test('int-declared variables truncate like Pine integer division', () => {
  const res = runScript('indicator("t")\nint a = 7 / 2\nfloat b = 7 / 2\nplot(a, "a")\nplot(b, "b")', series([1]));
  assert.equal(plot(res, 'a')[0], 3);
  assert.equal(plot(res, 'b')[0], 3.5);
});

test('request.security builds higher-timeframe bars from the chart data', () => {
  // 12 one-hour bars -> 3 four-hour bars
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  for (let i = 0; i < 12; i++) {
    d.time.push(Date.UTC(2024, 0, 1, i)); d.open.push(i); d.high.push(i + 0.5); d.low.push(i - 0.5); d.close.push(i + 0.25); d.volume.push(1);
  }
  const res = runScript(`indicator("t")
on = request.security(syminfo.tickerid, "240", close, lookahead=barmerge.lookahead_on)
off = request.security(syminfo.tickerid, "240", close)
prevHigh = request.security(syminfo.tickerid, "240", high[1], lookahead=barmerge.lookahead_on)
plot(on, "on")
plot(off, "off")
plot(prevHigh, "ph")
`, d);
  // lookahead on: every bar sees its own 4h bar's final close
  assert.deepEqual(plot(res, 'on'), [3.25, 3.25, 3.25, 3.25, 7.25, 7.25, 7.25, 7.25, 11.25, 11.25, 11.25, 11.25]);
  // lookahead off: the 4h value appears when that 4h bar has closed
  const off = plot(res, 'off');
  assert.ok(off.slice(0, 3).every(Number.isNaN));
  assert.deepEqual(off.slice(3), [3.25, 3.25, 3.25, 3.25, 7.25, 7.25, 7.25, 7.25, 11.25]);
  // the usual non-repainting pattern: previous completed 4h bar
  assert.ok(plot(res, 'ph').slice(0, 4).every(Number.isNaN));
  assert.deepEqual(plot(res, 'ph').slice(4), [3.5, 3.5, 3.5, 3.5, 7.5, 7.5, 7.5, 7.5]);
});

test('futures point value scales P&L; tick size is detected from the prices', async () => {
  const { guessContract } = await import('../src/data.js');
  assert.deepEqual(guessContract('CME_MINI_MNQ1!, 1.csv'), { root: 'MNQ', pointvalue: 2, mintick: 0.25 });
  assert.equal(guessContract('MESZ2026.csv').root, 'MES');
  assert.equal(guessContract('BTCUSDT_1h.csv'), null);
  const d = bars([[100, 100, 100, 100], [100, 100, 100, 100], [100.25, 110.5, 100, 110.75], [110.75, 111, 110, 110.5]]);
  const res = runScript(`strategy("t")
if bar_index == 0
    strategy.entry("L", strategy.long, qty=3)
if bar_index == 2
    strategy.close("L")
`, d, { pointvalue: 2 });
  assert.equal(res.mintick, 0.25);
  assert.equal(res.strategy.trades[0].profit, (110.75 - 100) * 3 * 2); // closed at the next bar's open
});

test('display.data_window plots are kept out of the chart list but still computed', () => {
  const res = runScript('indicator("t", overlay=true)\nplot(close, "c", display=display.data_window)', series([1, 2]));
  assert.equal(res.plots[0].display, 'display.data_window');
  assert.deepEqual(res.plots[0].values, [1, 2]);
});

test('futures higher-timeframe bars start at the 18:00 New York session open', async () => {
  const { resample, SESSIONS } = await import('../src/data.js');
  const { timeParts } = await import('../src/runtime.js');
  // 1-minute bars from Sunday 18:00 New York (22:00 UTC in November) for 30 hours
  const d = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  const t0 = Date.UTC(2026, 10, 8, 23, 0); // 18:00 EST
  for (let i = 0; i < 30 * 60; i++) {
    d.time.push(t0 + i * 60000); d.open.push(100); d.high.push(101); d.low.push(99); d.close.push(100); d.volume.push(1);
  }
  const hhmm = (t) => { const p = timeParts(t, 'America/New_York'); return `${p.h}:${String(p.mi).padStart(2, '0')}`; };
  assert.deepEqual(resample(d, 14400, SESSIONS.futures).time.map(hhmm), ['18:00', '22:00', '2:00', '6:00', '10:00', '14:00', '18:00', '22:00']);
  assert.deepEqual(resample(d, 86400, SESSIONS.futures).time.map(hhmm), ['18:00', '18:00']);
  // the same data with request.security(..., "D") inside a script
  const res = runScript('indicator("t")\nplot(request.security(syminfo.tickerid, "D", bar_index, lookahead=barmerge.lookahead_on), "d")', d, { session: SESSIONS.futures });
  const v = plot(res, 'd');
  assert.equal(v[0], 0);
  assert.equal(v[24 * 60 - 1], 0); // 17:59 next day still in the first session
  assert.equal(v[24 * 60], 1); // 18:00 starts the next trading day
});

test('date range: orders only inside the range, indicators warmed up before it', () => {
  const closes = randomCloses(60);
  const d = series(closes);
  const src = `strategy("t")
ma = ta.sma(close, 20)
if bar_index % 4 == 0
    strategy.entry("L", strategy.long)
if bar_index % 4 == 2
    strategy.close("L")
plot(ma, "ma")
`;
  const all = runScript(src, d);
  const from = d.time[30], to = d.time[45];
  const part = runScript(src, d, { range: { from, to } });
  // the moving average is identical: the script ran on every bar
  assert.deepEqual(plot(part, 'ma'), plot(all, 'ma'));
  for (const t of part.strategy.trades) {
    assert.ok(t.entryTime >= from && t.exitTime <= to, `trade outside range: ${t.entryBar}-${t.exitBar}`);
  }
  assert.ok(part.strategy.trades.length > 0 && part.strategy.trades.length < all.strategy.trades.length);
  assert.equal(part.strategy.metrics.firstBar, 30);
  assert.equal(part.strategy.metrics.lastBar, 45);
  // buy & hold is measured over the range only
  close(part.strategy.metrics.buyHoldReturnPct, ((d.close[45] - d.open[30]) / d.open[30]) * 100);
  assert.ok(part.strategy.equity.slice(0, 30).every((v) => v === undefined));
});

// Example strategies shown in the editor's "Examples" menu.
export const EXAMPLES = [
  {
    name: 'Moving average crossover',
    code: `//@version=6
strategy("MA Crossover", overlay=true, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100,
     commission_type=strategy.commission.percent, commission_value=0.05)

fastLen = input.int(20, "Fast length", minval=1)
slowLen = input.int(50, "Slow length", minval=1)
useEma  = input.bool(true, "Use EMA")

fast = useEma ? ta.ema(close, fastLen) : ta.sma(close, fastLen)
slow = useEma ? ta.ema(close, slowLen) : ta.sma(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)

plot(fast, "Fast", color=color.orange, linewidth=2)
plot(slow, "Slow", color=color.blue, linewidth=2)
`,
  },
  {
    name: 'RSI mean reversion with TP / SL',
    code: `//@version=6
strategy("RSI Reversion", overlay=false, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=50)

len      = input.int(14, "RSI length")
oversold = input.float(30, "Oversold")
tpPct    = input.float(3.0, "Take profit %", step=0.5) / 100
slPct    = input.float(1.5, "Stop loss %", step=0.5) / 100

r = ta.rsi(close, len)

if ta.crossover(r, oversold) and strategy.position_size == 0
    strategy.entry("Long", strategy.long)

if strategy.position_size > 0
    entry = strategy.position_avg_price
    strategy.exit("TP/SL", "Long", limit=entry * (1 + tpPct), stop=entry * (1 - slPct))

plot(r, "RSI", color=color.purple)
hline(70, "Overbought", color=color.red)
hline(oversold, "Oversold", color=color.green)
`,
  },
  {
    name: 'Supertrend with trailing stop',
    code: `//@version=6
strategy("Supertrend", overlay=true, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)

atrLen = input.int(10, "ATR length")
factor = input.float(3.0, "Factor", step=0.1)
trailTicks = input.int(0, "Trailing offset (ticks, 0 = off)")

[st, dir] = ta.supertrend(factor, atrLen)

if ta.change(dir) < 0
    strategy.entry("Long", strategy.long)
if ta.change(dir) > 0
    strategy.close("Long")

if trailTicks > 0
    strategy.exit("Trail", "Long", trail_points=trailTicks, trail_offset=trailTicks)

plot(dir < 0 ? st : na, "Up trend", color=color.green, style=plot.style_linebr, linewidth=2)
plot(dir > 0 ? st : na, "Down trend", color=color.red, style=plot.style_linebr, linewidth=2)
`,
  },
  {
    name: 'Bollinger breakout (stop orders)',
    code: `//@version=6
strategy("BB Breakout", overlay=true, initial_capital=10000,
     default_qty_type=strategy.percent_of_equity, default_qty_value=100)

length = input.int(20, "Length")
mult   = input.float(2.0, "StdDev")
src    = input.source(close, "Source")

[basis, upper, lower] = ta.bb(src, length, mult)

// enter on a break of the upper band, exit on a cross back under the basis
if close < upper and strategy.position_size == 0
    strategy.entry("BBLong", strategy.long, stop=upper)
else
    strategy.cancel("BBLong")
if ta.crossunder(close, basis)
    strategy.close("BBLong", comment="Basis")

plot(basis, "Basis", color=color.orange)
p1 = plot(upper, "Upper", color=color.blue)
p2 = plot(lower, "Lower", color=color.blue)
fill(p1, p2, color=color.new(color.blue, 90))
`,
  },
  {
    name: 'MACD + session filter + pyramiding',
    code: `//@version=6
strategy("MACD Pyramid", overlay=false, pyramiding=3, initial_capital=10000,
     default_qty_type=strategy.cash, default_qty_value=2000)

[macdLine, signal, hist] = ta.macd(close, 12, 26, 9)
startDate = input.time(timestamp("2024-01-01"), "Start date")
inWindow  = time >= startDate

var int adds = 0
if inWindow and ta.crossover(macdLine, signal)
    adds += 1
    strategy.entry("L" + str.tostring(adds), strategy.long)
if ta.crossunder(macdLine, 0)
    strategy.close_all(comment="MACD < 0")

plot(hist, "Histogram", style=plot.style_columns, color=hist >= 0 ? color.new(color.teal, 30) : color.new(color.red, 30))
plot(macdLine, "MACD", color=color.blue)
plot(signal, "Signal", color=color.orange)
hline(0)
`,
  },
];

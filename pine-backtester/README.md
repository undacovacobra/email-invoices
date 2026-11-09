# Pine Backtester

A chart and strategy tester that runs **Pine Script** strategies (v5/v6 syntax) on
your own OHLCV data and reports the same things TradingView's Strategy Tester does:
trade markers on the chart, the equity curve, the performance summary (All / Long /
Short) and the list of trades.

It is an independent implementation written from TradingView's **public** Pine
Script documentation (language reference, `ta.*` formulas, and the documented broker
emulator rules). It does not contain or call any TradingView code or services. The
candlestick chart uses TradingView's open-source
[Lightweight Charts](https://github.com/tradingview/lightweight-charts) library
(Apache-2.0), which is why charts carry its small attribution logo.

## Run it

No install needed. Any one of these:

* **Double-click `dist/pine-backtester.html`.** Everything is in that one file (it loads
  the chart library and fonts from a CDN, so it needs internet the first time).
* **Local server** (Node 18+), works fully offline:
  ```bash
  cd pine-backtester
  ```
  ```bash
  node serve.mjs
  ```
  (Run them as two separate commands; Windows PowerShell 5.1 doesn't accept `&&`.)
  then open http://localhost:8080/
* **Command line**, no browser:
  ```bash
  node cli.mjs examples/moving_average_crossover.pine my_data.csv --trades
  ```
  Override inputs with `--input "Fast length=10"`, get JSON with `--json`.

`Ctrl/⌘ + Enter` runs the script in the editor.

## Getting your data in

* **CSV file** – any file with `time/date, open, high, low, close[, volume]` columns
  (comma, semicolon or tab separated; unix seconds/ms or `YYYY-MM-DD[ HH:MM]` times).
  TradingView's own **Export chart data…** CSV works as-is, so you can backtest on
  exactly the bars you see there.
* **Crypto exchange** – any spot pair (BTCUSDT, ETHUSDT, …) at 1m–1w, up to 20,000
  bars, from a public market-data feed. Local / standalone copy only.
* **Sample** – a built-in random-walk series so the app works offline.

## How fills are simulated

The broker emulator follows the rules TradingView documents for its Strategy Tester:

| Situation | What happens |
|---|---|
| Script runs | once per bar, at the bar's close |
| Market order (`strategy.entry` without limit/stop, `strategy.close`, …) | fills at the **next bar's open** |
| `process_orders_on_close=true`, or `immediately=true` on `strategy.close*` | fills at the **current bar's close** |
| Limit / stop orders | fill where the intrabar path first touches them; if the bar opens beyond the level, at the open |
| Intrabar path | open → high → low → close when the high is nearer the open, otherwise open → low → high → close |
| `strategy.entry` in the opposite direction | closes the open position and reverses |
| `pyramiding` | caps same-direction entries (default 0 = one entry) |
| `strategy.exit` | profit/limit, loss/stop and trailing (`trail_points`/`trail_price` + `trail_offset`) brackets per entry, one-cancels-the-other; can fill on the entry bar |
| Order size | `strategy.fixed` / `strategy.cash` / `strategy.percent_of_equity`, sized from the signal bar's close |
| Costs | commission (percent, per contract, per order) and slippage in ticks |

Performance summary: net/gross profit, profit factor, max equity drawdown and
run-up (intrabar), buy & hold, Sharpe and Sortino (monthly returns, 2% risk-free),
win rate, average/largest trades, bars in trade, commission, open P&L.

## Supported Pine Script

* Syntax: `var`/`varip`, typed declarations, `:=` and `+= -= *= /= %=`, `if / else if /
  else`, `for … to … by`, `for … in`, `while`, `switch`, `break`/`continue`, ternaries,
  user functions (single- and multi-line, default params), tuples `[a, b] = f()`,
  history references `x[n]` on anything, line wrapping, method syntax `arr.push(x)`.
* Series semantics: each `ta.*` call site keeps its own state, including inside user
  functions, exactly like Pine.
* `ta.*`: sma, ema, rma, wma, vwma, hma, alma, swma, rsi, atr, tr, stdev, variance, dev,
  macd, bb, bbw, kc, stoch, cci, mfi, wpr, dmi, supertrend, sar, vwap, obv, linreg,
  highest/lowest(+bars), crossover/crossunder/cross, change, mom, roc, rising, falling,
  cum, barssince, valuewhen, pivothigh/pivotlow, median, percentrank, correlation.
* `strategy.*`: entry, order, exit, close, close_all, cancel, cancel_all, position_size,
  position_avg_price, equity, netprofit, openprofit, opentrades/closedtrades (and their
  `.entry_price()`, `.profit()`, … accessors).
* `input.*` (int, float, bool, string with options, source, time, color, …) – editable in
  **Settings → Inputs**; strategy properties are editable in **Settings → Properties**.
* `plot` (line, linebr, stepline, histogram, columns, area, circles), `plotshape`,
  `plotchar`, `plotarrow`, `hline`, `bgcolor`, `barcolor`, `color.*`, `math.*`, `str.*`,
  `array.*`, `time`/session filters, `timestamp`, `year/month/…`, `barstate.*`,
  `syminfo.*`, `timeframe.*`, `nz`, `na`, `fixnan`.

### Not supported (yet)

* `request.security()` / other symbols or timeframes, `import` of libraries, user-defined
  `type`s, `map`/`matrix`.
* Drawings (`label.*`, `line.*`, `box.*`, `table.*`) and `fill()` are accepted but not drawn.
* Margin calls, bar magnifier, `calc_on_every_tick`/realtime bars, `strategy.risk.*` rules.
* Times are in UTC unless you pass a timezone (CLI `--tz`); TradingView uses the
  exchange's timezone, which matters for session filters and daily resets.

## Development

```bash
npm test            # engine tests (parser, indicators vs. Pine reference formulas, fill rules)
npm run build       # regenerate dist/pine-backtester.html after changing src/ or app/
```

```
src/lexer.js     tokenizer (indentation + line wrapping)
src/parser.js    Pine → AST
src/runtime.js   bar-by-bar interpreter and built-ins
src/ta.js        ta.* indicators
src/broker.js    order matching / fills / trades
src/metrics.js   performance summary
src/data.js      CSV parsing, exchange feed, sample data
app/             browser UI (chart, editor, strategy tester)
cli.mjs          command-line backtests
```

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

* **In the cloud, free** – put it on Vercel once (about 5 minutes, steps in
  [DEPLOY.md](DEPLOY.md)) and use it from any browser, with market data, nothing running
  on your computer.

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

* **Market data** (when running `node serve.mjs`) – type a symbol and the history
  downloads by itself, as far back as the free Yahoo Finance feed goes and up to the
  latest minute: futures as `MNQ1!`, `ES1!`, `NQ1!`, `GC1!`…, stocks as `AAPL`, `SPY`,
  crypto as `BTCUSD`. How far back depends on the timeframe: 1m ≈ 30 days, 5m/15m/30m
  ≈ 60 days, 1h ≈ 2 years, 1D decades. Yahoo's continuous futures contract can roll on
  a different day than TradingView's `MNQ1!`, so prices near a roll can differ slightly.
  For a full year of 1-minute bars you'd need a paid data vendor; export it to CSV and
  open it here.
* **CSV file** – any file with `time/date, open, high, low, close[, volume]` columns
  (comma, semicolon or tab separated; unix seconds/ms or `YYYY-MM-DD[ HH:MM]` times).
  TradingView's own **Export chart data…** CSV works as-is, so you can backtest on
  exactly the bars you see there.
* **Crypto exchange** – any spot pair (BTCUSDT, ETHUSDT, …) at 1m–1w, up to 20,000
  bars, from a public market-data feed. Local / standalone copy only.
* **Sample** – a built-in random-walk series so the app works offline.

### Futures (MNQ, NQ, MES, ES, …)

P&L, `syminfo.pointvalue` and `syminfo.mintick` must match the contract or dollar
targets and profits come out wrong. When the file or symbol name contains a contract
code (for example TradingView's export name `CME_MINI_MNQ1!, 1.csv`) the point value
and tick size are filled in automatically: MNQ $2/pt and 0.25 tick, NQ $20, MES $5,
ES $50, M2K/RTY, MYM/YM, MGC/GC, MCL/CL and more. Check or change them in
**Settings → Properties → Symbol** (CLI: `--pointvalue 2 --mintick 0.25`).

**Timeframe** (top bar) switches the chart from 1 minute to 1 day. With market data the
right history is downloaded; with a CSV, higher timeframes are built from the file's bars.
Bars are anchored to the market's session open like TradingView builds them: CME futures
days run 18:00 → 17:00 New York (4h bars start 18:00, 22:00, 02:00…), US stocks start at
09:30, crypto at 00:00 UTC. The same anchoring is used for `request.security()` and the
daily reset of `ta.vwap`.

Pick the **Time** zone your TradingView chart uses (for CME futures that's usually New
York or Chicago) so trade times line up with TradingView's List of Trades. The script's
own `hour(time, "America/New_York")`-style calls always use the zone they name.

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

**Settings** dock on the right and the backtest re-runs as you change any input or
property; there's no Apply step. **From / To** on the Strategy Tester bar limits the
backtest to those dates (whole days in the chosen time zone). The script still runs on
the earlier bars, so indicators are warmed up when the range starts; orders are only
placed and filled inside the range, and every statistic, the equity curve and buy & hold
cover the range only. CLI: `--from 2026-10-01 --to 2026-10-31`.

**Overview chart**: equity trade by trade (or bar by bar), drawdown hanging from the
top, optional per-trade run-up / drawdown bars and buy & hold, in currency or percent;
hover for each trade's numbers.

Performance summary: net/gross profit, profit factor, max equity drawdown and
run-up (intrabar), buy & hold, Sharpe and Sortino (monthly returns, 2% risk-free),
win rate, average/largest trades, bars in trade, commission, open P&L.

## Supported Pine Script

* Syntax: `var`/`varip`, typed declarations, user-defined `type`s (`.new()`, `.copy()`,
  reading and assigning fields), `:=` and `+= -= *= /= %=`, `if / else if /
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
* `request.security()` on the chart's own symbol at a higher timeframe (bars are built
  from the chart's data; `lookahead_on` and `lookahead_off` behave as on TradingView's
  historical bars), `runtime.error()`.
* `plot` (line, linebr, stepline, histogram, columns, area, circles), `plotshape`,
  `plotchar`, `plotarrow`, `hline`, `bgcolor`, `barcolor`, `color.*`, `math.*`, `str.*`,
  `array.*`, `time`/session filters, `timestamp`, `year/month/…`, `barstate.*`,
  `syminfo.*`, `timeframe.*`, `nz`, `na`, `fixnan`.

### Not supported (yet)

* `request.security()` for other symbols or lower timeframes, `import` of libraries,
  `map`/`matrix`, methods on user-defined types.
* Session anchoring covers CME-style futures, US stocks and crypto. Other markets (and
  CSV files with no recognised contract code) use midnight in the selected time zone.
* Drawings (`label.*`, `line.*`, `box.*`, `table.*`) and `fill()` are accepted but not drawn.
* Margin calls, bar magnifier, `calc_on_every_tick`/realtime bars, `strategy.risk.*` rules.
* Speed: roughly 5–7 seconds per 30,000 bars for a large script (about 1,000 lines). Runs
  happen in the background with a progress readout, so the page stays usable.

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

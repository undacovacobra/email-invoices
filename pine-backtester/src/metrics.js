// Strategy Tester performance summary, split into All / Long / Short like
// TradingView's "Performance Summary" tab.

function group(trades) {
  const wins = trades.filter((t) => t.profit > 0);
  const losses = trades.filter((t) => t.profit <= 0);
  const sum = (a, f) => a.reduce((s, t) => s + f(t), 0);
  const grossProfit = sum(wins, (t) => t.profit);
  const grossLoss = -sum(losses, (t) => t.profit) + 0; // + 0 turns -0 into 0
  const bars = (a) => (a.length ? sum(a, (t) => t.exitBar - t.entryBar) / a.length : NaN);
  const avgWin = wins.length ? grossProfit / wins.length : NaN;
  const avgLoss = losses.length ? grossLoss / losses.length : NaN;
  return {
    netProfit: grossProfit - grossLoss,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : NaN,
    commission: sum(trades, (t) => t.commission),
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    percentProfitable: trades.length ? (wins.length / trades.length) * 100 : NaN,
    avgTrade: trades.length ? sum(trades, (t) => t.profit) / trades.length : NaN,
    avgTradePct: trades.length ? sum(trades, (t) => t.profitPct) / trades.length : NaN,
    avgWin,
    avgWinPct: wins.length ? sum(wins, (t) => t.profitPct) / wins.length : NaN,
    avgLoss,
    avgLossPct: losses.length ? sum(losses, (t) => -t.profitPct) / losses.length : NaN,
    ratioAvgWinLoss: avgLoss > 0 ? avgWin / avgLoss : NaN,
    largestWin: wins.length ? Math.max(...wins.map((t) => t.profit)) : NaN,
    largestWinPct: wins.length ? Math.max(...wins.map((t) => t.profitPct)) : NaN,
    largestLoss: losses.length ? -Math.min(...losses.map((t) => t.profit)) : NaN,
    largestLossPct: losses.length ? -Math.min(...losses.map((t) => t.profitPct)) : NaN,
    avgBars: bars(trades),
    avgBarsWin: bars(wins),
    avgBarsLoss: bars(losses),
  };
}

// Sharpe / Sortino the way TradingView describes them: monthly returns of the
// strategy's equity, 2% annual risk-free rate.
function ratios(equity, time, initial) {
  const months = [];
  let lastKey = null;
  let start = initial;
  let prev = -1; // last bar with an equity value (bars outside the date range have none)
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] === undefined) continue;
    const d = new Date(time[i]);
    const key = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (lastKey !== null && key !== lastKey) {
      months.push((equity[prev] - start) / start);
      start = equity[prev];
    }
    lastKey = key;
    prev = i;
  }
  if (prev >= 0) months.push((equity[prev] - start) / start);
  if (months.length < 2) return { sharpe: NaN, sortino: NaN };
  const rf = 0.02 / 12;
  const mean = months.reduce((a, b) => a + b, 0) / months.length;
  const sd = Math.sqrt(months.reduce((a, b) => a + (b - mean) ** 2, 0) / months.length);
  const downside = Math.sqrt(months.reduce((a, b) => a + Math.min(0, b - rf) ** 2, 0) / months.length);
  return {
    sharpe: sd > 0 ? (mean - rf) / sd : NaN,
    sortino: downside > 0 ? (mean - rf) / downside : NaN,
  };
}

export function computeMetrics(broker, data) {
  const trades = broker.closed;
  const initial = broker.cfg.initial_capital;
  const n = data.close.length;
  // only the bars inside the backtest date range count
  const first = broker.firstBar ?? 0;
  const lastBar = broker.lastBar ?? n - 1;
  const lastClose = data.close[lastBar];
  const all = group(trades);
  const long = group(trades.filter((t) => t.dir > 0));
  const short = group(trades.filter((t) => t.dir < 0));
  const openPL = broker.openProfit(lastClose);
  const { sharpe, sortino } = ratios(broker.equity, data.time, initial);
  const firstPrice = data.open[first];
  return {
    initialCapital: initial,
    all, long, short,
    netProfitPct: (all.netProfit / initial) * 100,
    openPL,
    maxDrawdown: broker.maxDD,
    maxDrawdownPct: broker.maxDDPct,
    maxRunup: broker.maxRunup,
    maxRunupPct: (broker.maxRunup / initial) * 100,
    buyHoldReturn: ((lastClose - firstPrice) / firstPrice) * initial,
    buyHoldReturnPct: ((lastClose - firstPrice) / firstPrice) * 100,
    sharpe, sortino,
    maxContracts: broker.maxContracts,
    commissionPaid: broker.commissionPaid,
    openTrades: broker.open.length,
    finalEquity: broker.equity[lastBar] ?? initial,
    firstBar: first,
    lastBar,
  };
}

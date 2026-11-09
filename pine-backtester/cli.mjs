#!/usr/bin/env node
// Command-line backtest:  node cli.mjs my_strategy.pine data.csv [--input "Fast length=10"] [--json]
import { readFileSync } from 'node:fs';
import { runScript } from './src/runtime.js';
import { parseCSV, sampleData, guessContract } from './src/data.js';

const args = process.argv.slice(2);
const flags = { inputs: {}, json: false, trades: false, tz: 'UTC', pointvalue: undefined, mintick: undefined };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') flags.json = true;
  else if (a === '--trades') flags.trades = true;
  else if (a === '--tz') flags.tz = args[++i];
  else if (a === '--pointvalue') flags.pointvalue = +args[++i];
  else if (a === '--mintick') flags.mintick = +args[++i];
  else if (a === '--input') {
    const [k, ...v] = args[++i].split('=');
    const val = v.join('=');
    flags.inputs[k] = val === 'true' ? true : val === 'false' ? false : Number.isNaN(+val) ? val : +val;
  } else if (a === '-h' || a === '--help') {
    console.log('usage: node cli.mjs <script.pine> [data.csv] [--input "Title=value"]... [--trades] [--json] [--tz America/New_York] [--pointvalue 2] [--mintick 0.25]');
    process.exit(0);
  } else pos.push(a);
}
if (!pos[0]) {
  console.error('usage: node cli.mjs <script.pine> [data.csv] [--input "Title=value"] [--trades] [--json]');
  process.exit(2);
}

const source = readFileSync(pos[0], 'utf8');
const data = pos[1] ? parseCSV(readFileSync(pos[1], 'utf8')) : sampleData();
const contract = pos[1] ? guessContract(pos[1].split(/[\\/]/).pop()) : null;
const pointvalue = flags.pointvalue ?? contract?.pointvalue;
const mintick = flags.mintick ?? contract?.mintick;
if (contract && (flags.pointvalue === undefined || flags.mintick === undefined)) {
  console.log(`contract: ${contract.root} (point value ${pointvalue}, tick ${mintick}) — override with --pointvalue / --mintick`);
}
let res;
try {
  res = runScript(source, data, { inputs: flags.inputs, timezone: flags.tz, pointvalue, mintick });
} catch (e) {
  console.error(String(e.message || e));
  process.exit(1);
}

if (flags.json) {
  const { strategy } = res;
  console.log(JSON.stringify({ title: res.title, inputs: res.inputs, metrics: strategy?.metrics, trades: strategy?.trades }, null, 2));
  process.exit(0);
}

const money = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : v === Infinity ? '∞' : '—');
const pct = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}%` : '—');
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
console.log(`${res.title}  —  ${data.close.length} bars ${iso(data.time[0])} → ${iso(data.time.at(-1))}  (${res.elapsedMs} ms)`);
const changed = Object.keys(flags.inputs);
if (res.inputs.length) console.log(`inputs: ${res.inputs.length}${changed.length ? ` (changed: ${changed.map((k) => `${k}=${flags.inputs[k]}`).join(', ')})` : ', all at their defaults'}`);
if (!res.strategy) {
  console.log('(indicator script: no trades)');
  process.exit(0);
}
const m = res.strategy.metrics;
const rows = [
  ['Net profit', money(m.all.netProfit), pct(m.netProfitPct)],
  ['Gross profit', money(m.all.grossProfit), ''],
  ['Gross loss', money(m.all.grossLoss), ''],
  ['Max drawdown', money(m.maxDrawdown), pct(m.maxDrawdownPct)],
  ['Buy & hold return', money(m.buyHoldReturn), pct(m.buyHoldReturnPct)],
  ['Sharpe ratio', Number.isFinite(m.sharpe) ? m.sharpe.toFixed(3) : '—', ''],
  ['Sortino ratio', Number.isFinite(m.sortino) ? m.sortino.toFixed(3) : '—', ''],
  ['Profit factor', Number.isFinite(m.all.profitFactor) ? m.all.profitFactor.toFixed(3) : '—', ''],
  ['Total closed trades', String(m.all.totalTrades), ''],
  ['Percent profitable', pct(m.all.percentProfitable), ''],
  ['Avg trade', money(m.all.avgTrade), pct(m.all.avgTradePct)],
  ['Avg # bars in trades', Number.isFinite(m.all.avgBars) ? m.all.avgBars.toFixed(0) : '—', ''],
  ['Commission paid', money(m.commissionPaid), ''],
  ['Open P&L', money(m.openPL), ''],
];
for (const [k, a, b] of rows) console.log(`  ${k.padEnd(22)} ${a.padStart(16)} ${b.padStart(9)}`);
if (flags.trades) {
  console.log('\n  #  Type   Entry time         Entry px    Exit time          Exit px     Qty        Profit');
  for (const t of res.strategy.trades) {
    console.log(`  ${String(t.num).padStart(2)} ${(t.dir > 0 ? 'Long' : 'Short').padEnd(6)} ${iso(t.entryTime)}  ${String(t.entryPrice).padStart(10)}  ${iso(t.exitTime)}  ${String(t.exitPrice).padStart(10)}  ${t.qty.toFixed(4).padStart(9)}  ${money(t.profit).padStart(12)}`);
  }
}

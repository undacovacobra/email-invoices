// Strategy broker emulator.
//
// Follows the rules TradingView documents for its Strategy Tester:
//  * The script runs once at the close of each bar. Orders it places are filled
//    starting on the NEXT bar (market orders at that bar's open), unless
//    process_orders_on_close=true (or immediately=true on strategy.close*),
//    in which case market orders fill at the close of the current bar.
//  * Inside a bar, price is assumed to travel open -> high -> low -> close when
//    the high is nearer the open than the low, otherwise open -> low -> high ->
//    close. Limit / stop orders fill where that path first touches them; if the
//    bar gaps past the level the order fills at the open.
//  * strategy.entry reverses an opposite position, respects `pyramiding`, and
//    replaces a pending order with the same id.
//  * strategy.exit brackets (profit/limit, loss/stop, trailing) are attached to
//    each open entry and are one-cancels-all per entry.

const DEFAULTS = {
  initial_capital: 1000000,
  default_qty_type: 'fixed',
  default_qty_value: 1,
  pyramiding: 0,
  commission_type: 'percent',
  commission_value: 0,
  slippage: 0,
  process_orders_on_close: false,
  currency: '',
};

let tradeSeq = 0;

export class Broker {
  constructor(data, mintick, overrides = {}, pointvalue = 1) {
    this.data = data;
    this.mintick = mintick;
    this.pv = pointvalue; // currency per 1.0 of price per contract (e.g. MNQ = 2)
    this.overrides = overrides;
    this.cfg = { ...DEFAULTS, ...overrides };
    this.orders = []; // pending entry/order (limit/stop) & market orders
    this.exitRules = new Map();
    this.open = []; // open trades
    this.closed = []; // closed trades
    this.realized = 0;
    this.commissionPaid = 0;
    this.seq = 0;
    this.fills = []; // for chart markers
    this.equity = [];
    this.maxDD = 0;
    this.maxDDPct = 0;
    this.maxRunup = 0;
    this.peak = null;
    this.trough = null;
    this.maxContracts = 0;
    this.bar = 0;
  }

  configure(cfg) {
    this.declared = { ...DEFAULTS };
    for (const [k, v] of Object.entries(cfg)) {
      if (v === undefined) continue;
      this.declared[k] = v;
      if (!(k in this.overrides)) this.cfg[k] = v;
    }
  }

  // ---------------------------------------------------------------- state
  get positionSize() {
    return this.open.reduce((s, t) => s + t.dir * t.qty, 0);
  }
  get positionAvgPrice() {
    const q = this.open.reduce((s, t) => s + t.qty, 0);
    if (!q) return NaN;
    return this.open.reduce((s, t) => s + t.qty * t.entryPrice, 0) / q;
  }
  openProfit(price) {
    return this.open.reduce((s, t) => s + t.dir * (price - t.entryPrice) * t.qty * this.pv, 0);
  }
  equityAt(price) {
    return this.cfg.initial_capital + this.realized + this.openProfit(price);
  }

  // --------------------------------------------------------- script calls
  calcQty(qty, price) {
    if (qty !== undefined && qty !== null && !Number.isNaN(qty)) return +qty;
    const v = this.cfg.default_qty_value;
    switch (this.cfg.default_qty_type) {
      case 'cash': return v / (price * this.pv);
      case 'percent_of_equity': return (this.equityAt(price) * v) / 100 / (price * this.pv);
      default: return v;
    }
  }

  placeOrder(kind, o) {
    const bar = this.bar;
    const price = this.data.close[bar];
    const order = {
      kind, // 'entry' | 'order'
      id: String(o.id),
      dir: o.dir,
      qty: this.calcQty(o.qty, price),
      limit: valid(o.limit) ? o.limit : null,
      stop: valid(o.stop) ? o.stop : null,
      comment: o.comment,
      createdBar: bar,
      seq: this.seq++,
      ocaName: o.ocaName,
      ocaType: o.ocaType,
    };
    if (!(order.qty > 0)) return;
    // same id replaces a pending order
    this.orders = this.orders.filter((x) => !((x.kind === 'entry' || x.kind === 'order') && x.id === order.id));
    this.orders.push(order);
  }

  entry(o) { this.placeOrder('entry', o); }
  order(o) { this.placeOrder('order', o); }

  close(o) {
    const id = String(o.id);
    if (!this.open.some((t) => t.entryId === id)) return;
    this.orders = this.orders.filter((x) => !(x.kind === 'close' && x.id === id));
    this.orders.push({
      kind: 'close', id, qty: o.qty, qtyPercent: o.qtyPercent, comment: o.comment,
      createdBar: this.bar, seq: this.seq++, immediately: !!o.immediately,
    });
  }

  closeAll(o) {
    if (!this.open.length) return;
    this.orders = this.orders.filter((x) => x.kind !== 'closeAll');
    this.orders.push({ kind: 'closeAll', id: 'Close all', comment: o.comment, createdBar: this.bar, seq: this.seq++, immediately: !!o.immediately });
  }

  exit(o) {
    const fromEntry = o.fromEntry ? String(o.fromEntry) : '';
    const key = `${o.id}|${fromEntry}`;
    const rule = {
      id: String(o.id), fromEntry, key,
      qty: valid(o.qty) ? o.qty : null,
      qtyPercent: valid(o.qtyPercent) ? o.qtyPercent : 100,
      profit: valid(o.profit) ? o.profit : null,
      limit: valid(o.limit) ? o.limit : null,
      loss: valid(o.loss) ? o.loss : null,
      stop: valid(o.stop) ? o.stop : null,
      trailPrice: valid(o.trailPrice) ? o.trailPrice : null,
      trailPoints: valid(o.trailPoints) ? o.trailPoints : null,
      trailOffset: valid(o.trailOffset) ? o.trailOffset : null,
      comment: o.comment, commentProfit: o.commentProfit, commentLoss: o.commentLoss, commentTrailing: o.commentTrailing,
      createdBar: (this.exitRules.get(key) || {}).createdBar ?? this.bar,
      updatedBar: this.bar,
      seq: this.seq++,
    };
    const hasLevel = [rule.profit, rule.limit, rule.loss, rule.stop, rule.trailPrice, rule.trailPoints].some((v) => v !== null);
    if (!hasLevel) return;
    this.exitRules.set(key, rule);
  }

  cancel(id) {
    id = String(id);
    this.orders = this.orders.filter((x) => !((x.kind === 'entry' || x.kind === 'order') && x.id === id));
    for (const [k, r] of this.exitRules) if (r.id === id) this.exitRules.delete(k);
  }

  cancelAll() {
    this.orders = this.orders.filter((x) => x.kind === 'close' || x.kind === 'closeAll');
    this.exitRules.clear();
  }

  // --------------------------------------------------------- accounting
  commission(qty, price) {
    const v = this.cfg.commission_value || 0;
    switch (this.cfg.commission_type) {
      case 'cash_per_contract': return qty * v;
      case 'cash_per_order': return v;
      default: return (qty * price * this.pv * v) / 100;
    }
  }

  slip(price, dir) {
    return price + dir * (this.cfg.slippage || 0) * this.mintick;
  }

  openTrade(entryId, dir, qty, price, bar, comment) {
    const comm = this.commission(qty, price);
    this.commissionPaid += comm;
    const t = {
      uid: ++tradeSeq, entryId, dir, qty, origQty: qty, entryPrice: price, entryBar: bar,
      entryTime: this.data.time[bar], entryComment: comment, entryCommission: comm,
      maxFav: 0, maxAdv: 0, exitsDone: new Set(), trail: {},
    };
    this.open.push(t);
    this.fills.push({ bar, price, dir, qty, id: entryId, comment, type: 'entry' });
    const abs = Math.abs(this.positionSize);
    if (abs > this.maxContracts) this.maxContracts = abs;
    return t;
  }

  closeTrade(t, qty, price, bar, exitId, comment) {
    qty = Math.min(qty, t.qty);
    if (!(qty > 0)) return;
    const exitComm = this.commission(qty, price);
    this.commissionPaid += exitComm;
    const share = qty / t.qty;
    const entryComm = t.entryCommission * share;
    const gross = t.dir * (price - t.entryPrice) * qty * this.pv;
    const profit = gross - entryComm - exitComm;
    this.realized += gross - exitComm - entryComm;
    this.closed.push({
      num: this.closed.length + 1,
      entryId: t.entryId, exitId, dir: t.dir, qty,
      entryPrice: t.entryPrice, exitPrice: price,
      entryBar: t.entryBar, exitBar: bar,
      entryTime: t.entryTime, exitTime: this.data.time[bar],
      entryComment: t.entryComment, exitComment: comment,
      profit, profitPct: (profit / (t.entryPrice * qty * this.pv)) * 100,
      commission: entryComm + exitComm,
      runup: t.maxFav * share, drawdown: t.maxAdv * share,
      cumProfit: this.realized,
    });
    this.fills.push({ bar, price, dir: -t.dir, qty, id: exitId, comment, type: 'exit' });
    t.entryCommission -= entryComm;
    t.qty -= qty;
    if (t.qty <= 1e-12) this.open = this.open.filter((x) => x !== t);
  }

  // Close matching trades FIFO for a total quantity.
  closeQty(trades, qty, price, bar, exitId, comment) {
    let left = qty;
    for (const t of [...trades]) {
      if (left <= 1e-12) break;
      const q = Math.min(left, t.qty);
      this.closeTrade(t, q, price, bar, exitId, comment);
      left -= q;
    }
    return qty - left;
  }

  // ------------------------------------------------------------- filling
  fillMarket(o, price, bar) {
    const open = this.open;
    if (o.kind === 'close') {
      const trades = open.filter((t) => t.entryId === o.id);
      if (!trades.length) return;
      const total = trades.reduce((s, t) => s + t.qty, 0);
      let q = total;
      if (valid(o.qty)) q = Math.min(o.qty, total);
      else if (valid(o.qtyPercent)) q = (total * o.qtyPercent) / 100;
      const dir = -trades[0].dir;
      this.closeQty(trades, q, this.slip(price, dir), bar, o.comment || `Close entry(s) order ${o.id}`, o.comment);
      return;
    }
    if (o.kind === 'closeAll') {
      if (!open.length) return;
      const dir = -open[0].dir;
      this.closeQty(open, Infinity, this.slip(price, dir), bar, o.comment || 'Close entry(s) order', o.comment);
      return;
    }
    this.fillEntryOrder(o, this.slip(price, o.dir), bar);
  }

  fillEntryOrder(o, price, bar) {
    const pos = this.positionSize;
    if (o.kind === 'entry') {
      if (pos !== 0 && Math.sign(pos) !== o.dir) {
        this.closeQty(this.open, Infinity, price, bar, o.id, o.comment);
      } else if (pos !== 0 && this.open.length >= Math.max(1, this.cfg.pyramiding)) {
        return false; // pyramiding limit: order rejected
      }
      this.openTrade(o.id, o.dir, o.qty, price, bar, o.comment);
      return true;
    }
    // strategy.order: net against an opposite position first
    let qty = o.qty;
    if (pos !== 0 && Math.sign(pos) !== o.dir) {
      qty -= this.closeQty(this.open, qty, price, bar, o.id, o.comment);
    }
    if (qty > 1e-12) this.openTrade(o.id, o.dir, qty, price, bar, o.comment);
    return true;
  }

  // Exit children for current open trades.
  exitChildren() {
    const out = [];
    const rules = [...this.exitRules.values()].sort((a, b) => a.seq - b.seq);
    for (const r of rules) {
      for (const t of this.open) {
        if (r.fromEntry && t.entryId !== r.fromEntry) continue;
        if (t.exitsDone.has(r.key)) continue;
        const e = t.entryPrice, d = t.dir, tick = this.mintick;
        const limit = r.limit ?? (r.profit !== null ? e + d * r.profit * tick : null);
        const stop = r.stop ?? (r.loss !== null ? e - d * r.loss * tick : null);
        let trailStop = null;
        const act = r.trailPrice ?? (r.trailPoints !== null ? e + d * r.trailPoints * tick : null);
        if (act !== null && r.trailOffset !== null) {
          const tr = t.trail[r.key] || (t.trail[r.key] = { active: false, extreme: null, act });
          tr.act = act;
          if (tr.active) trailStop = tr.extreme - d * r.trailOffset * tick;
        }
        out.push({ rule: r, trade: t, limit, stop, trailStop });
      }
    }
    return out;
  }

  // distance from cur along segment cur->end to trigger, or null
  static trigger(kind, side, level, cur, end) {
    // side: +1 buy, -1 sell. kind: 'limit' | 'stop'
    const buy = side > 0;
    if (kind === 'limit') {
      if (buy ? cur <= level : cur >= level) return { dist: 0, price: cur };
      if (buy ? end <= level : end >= level) return { dist: Math.abs(cur - level), price: level };
    } else {
      if (buy ? cur >= level : cur <= level) return { dist: 0, price: cur };
      if (buy ? end >= level : end <= level) return { dist: Math.abs(cur - level), price: level };
    }
    return null;
  }

  candidates(cur, end) {
    const list = [];
    for (const o of this.orders) {
      if ((o.kind !== 'entry' && o.kind !== 'order') || o.createdBar >= this.bar) continue;
      if (o.limit === null && o.stop === null) continue;
      if (o.stop !== null && !o.stopHit) {
        const tg = Broker.trigger('stop', o.dir, o.stop, cur, end);
        if (tg) list.push({ ...tg, seq: o.seq, run: () => this.triggerStop(o, tg.price) });
      } else {
        const tg = Broker.trigger('limit', o.dir, o.limit, cur, end);
        if (tg) list.push({ ...tg, seq: o.seq, run: () => this.fillPending(o, tg.price, 'limit') });
      }
    }
    for (const c of this.exitChildren()) {
      const side = -c.trade.dir;
      const levels = [];
      if (c.limit !== null) levels.push(['limit', c.limit, c.rule.commentProfit]);
      if (c.stop !== null) levels.push(['stop', c.stop, c.rule.commentLoss]);
      if (c.trailStop !== null) levels.push(['stop', c.trailStop, c.rule.commentTrailing]);
      for (const [kind, level, cmt] of levels) {
        const tg = Broker.trigger(kind, side, level, cur, end);
        if (tg) {
          const px = kind === 'stop' ? this.slip(tg.price, side) : tg.price;
          list.push({ ...tg, seq: c.rule.seq, run: () => this.fillExit(c, px, cmt) });
        }
      }
    }
    list.sort((a, b) => a.dist - b.dist || a.seq - b.seq);
    return list;
  }

  triggerStop(o, price) {
    if (o.limit === null) return this.fillPending(o, price, 'stop');
    o.stopHit = true; // stop-limit: now behaves as a limit order
    return true;
  }

  fillPending(o, price, how) {
    this.orders = this.orders.filter((x) => x !== o);
    const px = how === 'stop' ? this.slip(price, o.dir) : price;
    this.fillEntryOrder(o, px, this.bar);
    if (o.ocaName && o.ocaType === 'cancel') {
      this.orders = this.orders.filter((x) => x.ocaName !== o.ocaName);
    }
    return true;
  }

  fillExit(c, price, specificComment) {
    const { rule: r, trade: t } = c;
    if (!this.open.includes(t)) return false;
    const q = r.qty !== null ? Math.min(r.qty, t.qty) : Math.min(t.qty, (t.origQty * r.qtyPercent) / 100);
    t.exitsDone.add(r.key);
    const cmt = specificComment || r.comment;
    this.closeTrade(t, q, price, this.bar, cmt || r.id, cmt);
    return true;
  }

  pathFor(bar) {
    const d = this.data;
    const o = d.open[bar], h = d.high[bar], l = d.low[bar], c = d.close[bar];
    return Math.abs(h - o) <= Math.abs(o - l) ? [o, h, l, c] : [o, l, h, c];
  }

  updateTrails(price) {
    for (const t of this.open) {
      for (const [key, tr] of Object.entries(t.trail)) {
        const r = this.exitRules.get(key);
        if (!r) continue;
        const better = t.dir > 0 ? price >= tr.act : price <= tr.act;
        if (!tr.active && better) { tr.active = true; tr.extreme = price; }
        else if (tr.active) tr.extreme = t.dir > 0 ? Math.max(tr.extreme, price) : Math.min(tr.extreme, price);
      }
    }
  }

  // Called before the script runs on `bar`.
  processBar(bar) {
    this.bar = bar;
    const path = this.pathFor(bar);
    // 1) market orders at the open
    const market = this.orders
      .filter((o) => o.createdBar < bar && (o.kind === 'close' || o.kind === 'closeAll' || (o.limit === null && o.stop === null)))
      .sort((a, b) => a.seq - b.seq);
    this.orders = this.orders.filter((o) => !market.includes(o));
    for (const o of market) this.fillMarket(o, path[0], bar);
    // ensure trail state objects exist for trades so activation is tracked
    this.exitChildren();
    // 2) walk the intrabar path
    let cur = path[0];
    for (let s = 1; s < path.length; s++) {
      const end = path[s];
      for (let guard = 0; guard < 1000; guard++) {
        const cands = this.candidates(cur, end);
        if (!cands.length) break;
        const c = cands[0];
        c.run();
        cur = c.price;
        this.exitChildren();
      }
      cur = end;
      this.updateTrails(end);
    }
    this.trackExcursions(bar);
    this.cleanupRules(bar);
  }

  // Called after the script ran on `bar`.
  processOnClose(bar) {
    const price = this.data.close[bar];
    const market = this.orders
      .filter((o) => o.createdBar === bar && (this.cfg.process_orders_on_close || o.immediately) &&
        (o.kind === 'close' || o.kind === 'closeAll' || (o.limit === null && o.stop === null)))
      .sort((a, b) => a.seq - b.seq);
    this.orders = this.orders.filter((o) => !market.includes(o));
    for (const o of market) this.fillMarket(o, price, bar);
  }

  trackExcursions(bar) {
    const h = this.data.high[bar], l = this.data.low[bar];
    for (const t of this.open) {
      const fav = (t.dir > 0 ? h - t.entryPrice : t.entryPrice - l) * t.qty * this.pv;
      const adv = (t.dir > 0 ? t.entryPrice - l : h - t.entryPrice) * t.qty * this.pv;
      if (fav > t.maxFav) t.maxFav = fav;
      if (adv > t.maxAdv) t.maxAdv = adv;
    }
  }

  cleanupRules(bar) {
    for (const [k, r] of this.exitRules) {
      if (r.createdBar >= bar) continue;
      const hasTrade = this.open.some((t) => (!r.fromEntry || t.entryId === r.fromEntry) && !t.exitsDone.has(k));
      const hasPending = this.orders.some((o) => o.kind === 'entry' && (!r.fromEntry || o.id === r.fromEntry));
      if (!hasTrade && !hasPending) this.exitRules.delete(k);
    }
  }

  // Equity bookkeeping at the end of the bar.
  endBar(bar) {
    this.trackExcursions(bar);
    const path = this.pathFor(bar);
    for (const p of path.slice(1)) {
      const eq = this.equityAt(p);
      if (this.peak === null || eq > this.peak) this.peak = eq;
      if (this.trough === null || eq < this.trough) this.trough = eq;
      this.maxDD = Math.max(this.maxDD, this.peak - eq);
      if (this.peak > 0) this.maxDDPct = Math.max(this.maxDDPct, ((this.peak - eq) / this.peak) * 100);
      this.maxRunup = Math.max(this.maxRunup, eq - this.trough);
    }
    this.equity[bar] = this.equityAt(this.data.close[bar]);
  }
}

function valid(v) {
  return v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v));
}

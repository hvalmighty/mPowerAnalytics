// Rebalancing to the benchmark. Each benchmark name's target is its benchmark weight x current NAV:
// names above target are sold, names below target are bought, and holdings outside the benchmark are sold in full.
// Buys and sells are shown separately and the net cash is reported, not assumed.
// overrides: { TICKER: signed units } for priced names (+ buy, - sell); { TICKER: signed USD } for names without a price.
export function buildRebalance(model, overrides = {}) {
  const bm = model.benchmark || [];
  if (!bm.length) return null;
  const fx = model.fxRates || {};
  const base = model.baseCurrency || 'PHP';
  const hold = new Map();
  for (const h of model.holdings) {
    if (h.ticker === 'CASH') continue;
    const cur = hold.get(h.ticker) || { ticker: h.ticker, name: h.name, sector: h.sector, currency: h.currency || base, mv: 0, qty: 0 };
    cur.mv += h.mv; cur.qty += h.qty; hold.set(h.ticker, cur);
  }
  const nav = [...hold.values()].reduce((s, h) => s + h.mv, 0);
  const bmBy = new Map(bm.map((b) => [b.ticker, b]));
  const tickers = [...new Set([...hold.keys(), ...bm.map((b) => b.ticker)])];
  const rows = tickers.map((t) => {
    const h = hold.get(t), b = bmBy.get(t);
    const mv = h ? h.mv : 0;
    const qty = h ? h.qty : 0;
    const ccy = h ? h.currency : b.currency;
    // USD price at valuation: the statement price for held names; for names without a price, the
    // simulated approximate level (flagged) so the order can be sized.
    const heldPx = h && h.qty ? mv / h.qty : null;
    const simPx = heldPx == null && b && b.anchorLocal ? b.anchorLocal * (fx[ccy] ?? 1) : null;
    const usdPx = heldPx ?? simPx;
    const isSim = heldPx == null && simPx != null;
    const localPx = usdPx != null ? usdPx / (fx[ccy] ?? 1) : null;
    const bw = b ? b.weight : 0;
    const sysAmt = bw * nav - mv;                               // +buy / -sell toward the benchmark weight
    let units = null, amount;
    if (usdPx != null) {
      // A sell can never exceed the quantity held.
      const sysUnits = sysAmt >= 0
        ? Math.floor(sysAmt / usdPx + 1e-9)
        : -Math.min(qty, Math.floor(-sysAmt / usdPx + 1e-9));
      units = t in overrides ? Math.round(Number(overrides[t]) || 0) : sysUnits;
      if (units < 0) units = -Math.min(-units, qty);
      amount = units * usdPx;
    } else {
      amount = t in overrides ? Number(overrides[t]) || 0 : sysAmt;
      amount = Math.max(-mv, amount);
    }
    const action = amount >= 1 ? 'Buy' : amount <= -1 ? 'Sell' : 'Hold';
    if (action === 'Hold') amount = 0;
    return { ticker: t, name: h ? h.name : b.name, currency: ccy, sector: h ? h.sector : b.sector,
      country: b ? b.country : 'Not in benchmark', wb: bw, mv, wp: nav ? mv / nav : 0,
      priced: usdPx != null, isSim, localPx, units, amount, action };
  });
  const buys = rows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
  const sells = rows.reduce((s, r) => s + (r.amount < 0 ? -r.amount : 0), 0);
  const net = buys - sells;                                    // cash required (negative = cash released)
  const newNav = nav + net;
  for (const r of rows) {
    r.newMv = r.mv + r.amount;
    r.newW = newNav ? r.newMv / newNav : 0;
    r.active = r.newW - r.wb;
    r.activeBefore = r.wp - r.wb;
  }
  const mismatchBefore = rows.reduce((s, r) => s + Math.abs(r.activeBefore), 0) / 2;
  const mismatchAfter = rows.reduce((s, r) => s + Math.abs(r.active), 0) / 2;
  rows.sort((a, b) => (b.amount - a.amount) || (b.mv - a.mv) || a.ticker.localeCompare(b.ticker));
  return {
    base, nav, newNav, rows,
    totals: { cashRequired: net, buys, sells, net, turnover: nav ? (buys + sells) / 2 / nav : 0,
      orders: rows.filter((r) => r.action !== 'Hold').length, mismatchBefore, mismatchAfter },
    asOf: model.config.valuationDate || model.priceRange?.max,
    overrides: { ...overrides },
  };
}

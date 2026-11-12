// Rebalancing: buy-only alignment to the benchmark. Nothing is sold to raise cash.
// Each benchmark name is lifted to its benchmark weight of the current NAV; names above their weight,
// and holdings outside the benchmark, are kept. The cash required is the total of the buys.
// overrides: { TICKER: units } for priced names, { TICKER: USD amount } for names without a price.
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
    const ccy = h ? h.currency : b.currency;
    // USD price at valuation: the statement price for held names; for names without a price, the
    // simulated approximate level (flagged) so the order can be sized.
    const heldPx = h && h.qty ? mv / h.qty : null;
    const simPx = heldPx == null && b && b.anchorLocal ? b.anchorLocal * (fx[ccy] ?? 1) : null;
    const usdPx = heldPx ?? simPx;
    const isSim = heldPx == null && simPx != null;
    const localPx = usdPx != null ? usdPx / (fx[ccy] ?? 1) : null;
    const bw = b ? b.weight : 0;
    const sysBuy = Math.max(0, bw * nav - mv);                  // buy-only: lift to benchmark weight, never sell
    let units = null, amount;
    if (usdPx != null) {
      units = Math.floor(sysBuy / usdPx);
      if (t in overrides) units = Math.max(0, Math.round(Number(overrides[t]) || 0));
      amount = units * usdPx;
    } else {
      amount = t in overrides ? Math.max(0, Number(overrides[t]) || 0) : sysBuy;
    }
    const action = amount >= 1 ? 'Buy' : 'Hold';
    const note = !b ? 'Not in benchmark: kept, not sold.'
      : isSim ? 'Simulated price (approximate level, not market data): size and confirm before trading.'
      : (mv > bw * nav && action === 'Hold' ? 'Above benchmark weight: kept, not sold.' : '');
    return { ticker: t, name: h ? h.name : b.name, currency: ccy, sector: h ? h.sector : b.sector,
      country: b ? b.country : 'Not in benchmark', wb: bw, mv, wp: nav ? mv / nav : 0,
      priced: usdPx != null, isSim, localPx, units, amount, action, note };
  });
  const cashRequired = rows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
  const newNav = nav + cashRequired;
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
    totals: { cashRequired, buys: cashRequired, sells: 0, net: cashRequired, turnover: nav ? cashRequired / nav : 0,
      orders: rows.filter((r) => r.action === 'Buy').length, mismatchBefore, mismatchAfter },
    asOf: model.config.valuationDate || model.priceRange?.max,
    overrides: { ...overrides },
  };
}

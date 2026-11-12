// Rebalancing orders: align the portfolio to the benchmark's constituent weights.
// Target value of each name = benchmark weight x current NAV. Names not in the benchmark go to zero.
// Units are sized only where a real price exists (held names: the statement price at the valuation date).
// Names with no price data get an amount only. Trading costs, lot sizes and FX moves are not modelled.
export function buildRebalance(model) {
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
    const usdPx = h && h.qty ? mv / h.qty : null;          // USD price at valuation (statement price)
    const ccy = h ? h.currency : b.currency;
    const localPx = usdPx != null ? usdPx / (fx[ccy] ?? 1) : null;
    const bw = b ? b.weight : 0;
    const target = bw * nav;
    const amount = target - mv;
    const action = Math.abs(amount) < 1 ? 'Hold' : amount > 0 ? 'Buy' : 'Sell';
    const units = usdPx != null && action !== 'Hold' ? Math.round(amount / usdPx) : (usdPx != null ? 0 : null);
    return {
      ticker: t, name: h ? h.name : b.name, currency: ccy, sector: h ? h.sector : b.sector,
      country: b ? b.country : 'Not in benchmark', wp: mv / nav, wb: bw, active: mv / nav - bw,
      mv, target, amount, action, localPx, units,
      note: !h ? 'Not held: no price data, so units cannot be sized. Enter a price to size this order.'
          : !b ? 'Not in benchmark: sell all.'
          : action === 'Hold' ? 'Within USD 1 of target.' : '',
    };
  }).sort((a, b) => (Math.abs(b.amount) - Math.abs(a.amount)) || a.ticker.localeCompare(b.ticker));
  const buys = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
  const sells = rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
  return {
    base, nav, rows,
    totals: { buys, sells, net: buys + sells, turnover: nav ? buys / nav : 0, orders: rows.filter((r) => r.action !== 'Hold').length },
    asOf: model.config.valuationDate || model.priceRange?.max,
  };
}

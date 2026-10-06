// Price fetching, calendar alignment, data-quality checks and the daily "book"
// (positions, cash, market values, P&L) that every report is built from.

const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const MAX_FFILL = 5; // trading days a missing price may be carried forward

export async function fetchPrices(model, onProgress) {
  const { config, holdings, transactions, benchmark, scenarios } = model;
  const symbols = new Set([config.benchmarkSymbol]);
  const yahooOf = {};
  for (const h of holdings) if (h.ticker !== 'CASH' && h.yahoo) { symbols.add(h.yahoo); yahooOf[h.ticker] = h.yahoo; }
  for (const b of benchmark) { symbols.add(b.yahoo); yahooOf[b.ticker] = yahooOf[b.ticker] || b.yahoo; }
  for (const t of transactions) if (t.ticker !== 'CASH' && !yahooOf[t.ticker]) { yahooOf[t.ticker] = `${t.ticker}.PS`; symbols.add(yahooOf[t.ticker]); }

  // enough history for lookback + backtest (≈245 PSE trading days a year)
  const need = config.lookback + config.backtestDays + 15;
  let from = addDays(config.valuationDate, -Math.ceil(need * 365 / 240));
  if (config.periodStart < from) from = addDays(config.periodStart, -10);
  for (const s of scenarios) if (s.type === 'HISTORICAL' && s.start < from) from = addDays(s.start, -10);
  const to = config.periodEnd > config.valuationDate ? config.periodEnd : config.valuationDate;

  const list = [...symbols];
  const data = {}, errors = {}; let mode = 'live';
  const BATCH = 6; // small requests stay inside serverless time limits (Vercel, Netlify)
  if (typeof window !== 'undefined' && window.PSE_PRICE_PROVIDER) { // browser-only build
    onProgress && onProgress(`Generating demo prices for ${list.length} symbols…`);
    const j = await window.PSE_PRICE_PROVIDER(list, from, to);
    return { data: j.data, errors: j.errors, mode: j.mode, from, to, yahooOf };
  }
  for (let i = 0; i < list.length; i += BATCH) {
    const chunk = list.slice(i, i + BATCH);
    onProgress && onProgress(`Fetching prices ${i + 1}–${Math.min(i + BATCH, list.length)} of ${list.length} from Yahoo Finance…`);
    const res = await fetch('/api/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols: chunk, from, to }) });
    if (!res.ok) {
      if (res.status === 504 || res.status === 408) throw new Error('The price server timed out. Click Generate reports again: prices already fetched are cached, so the next try is faster.');
      if (res.status === 404) throw new Error('Price server not found (/api/history). The site is serving the files without the Node.js server, so prices cannot be fetched.');
      const t = (await res.text()).slice(0, 300);
      throw new Error(`Price server error ${res.status}: ${t}`);
    }
    const j = await res.json();
    Object.assign(data, j.data); Object.assign(errors, j.errors); mode = j.mode;
  }
  return { data, errors, mode, from, to, yahooOf };
}

// Align every symbol on the benchmark's trading calendar with limited forward-fill.
export function buildPanel(model, fetched) {
  const { config, overrides } = model;
  const warnings = [];
  const bm = fetched.data[config.benchmarkSymbol];
  let calendar;
  if (bm && bm.dates.length > 50) calendar = bm.dates.slice();
  else {
    warnings.push(`Benchmark ${config.benchmarkSymbol} has no data; using the union of security trading dates as the calendar.`);
    const s = new Set(); Object.values(fetched.data).forEach((d) => d.dates.forEach((x) => s.add(x)));
    calendar = [...s].sort();
  }
  const pos = new Map(calendar.map((d, i) => [d, i]));
  const series = {};
  for (const [sym, d] of Object.entries(fetched.data)) {
    const close = new Array(calendar.length).fill(null), adj = new Array(calendar.length).fill(null), raw = new Array(calendar.length).fill(false);
    for (let k = 0; k < d.dates.length; k++) {
      const i = pos.get(d.dates[k]);
      if (i != null) { close[i] = d.close[k]; adj[i] = d.adjclose[k]; raw[i] = true; }
    }
    series[sym] = { close, adj, raw, dividends: d.dividends || [], splits: d.splits || [], name: d.name, firstDate: d.dates[0], lastDate: d.dates[d.dates.length - 1] };
  }
  // manual overrides (PSE-suspended or illiquid names)
  for (const o of overrides) {
    const sym = fetched.yahooOf[o.ticker] || `${o.ticker}.PS`;
    let i = pos.get(o.date);
    if (i == null) { i = calendar.findIndex((d) => d >= o.date); if (i < 0) continue; }
    if (!series[sym]) series[sym] = { close: new Array(calendar.length).fill(null), adj: new Array(calendar.length).fill(null), raw: new Array(calendar.length).fill(false), dividends: [], splits: [], name: o.ticker };
    const s = series[sym];
    const ratio = s.close[i] && s.adj[i] ? s.adj[i] / s.close[i] : 1;
    s.close[i] = o.price; s.adj[i] = o.price * ratio; s.raw[i] = true; s.override = true;
  }
  // forward-fill short gaps; record stale counts
  for (const s of Object.values(series)) {
    let last = -1; s.stale = 0;
    for (let i = 0; i < calendar.length; i++) {
      if (s.raw[i]) { last = i; continue; }
      if (last >= 0 && i - last <= MAX_FFILL) { s.close[i] = s.close[last]; s.adj[i] = s.adj[last]; s.stale++; }
    }
  }
  return { calendar, pos, series, warnings };
}

// Index of the last calendar date <= d
export function idxOnOrBefore(calendar, d) {
  let lo = 0, hi = calendar.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (calendar[m] <= d) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
const idxOnOrAfter = (calendar, d) => { const i = idxOnOrBefore(calendar, d); return calendar[i] === d ? i : i + 1; };

// ---------- The book: daily positions, cash and P&L over the reporting period ----------
export function buildBook(model, panel, fetched) {
  const { config, holdings, transactions, cashFlows } = model;
  const { calendar, series } = panel;
  const warnings = [], errors = [];
  const i0 = idxOnOrBefore(calendar, config.periodStart);
  const iN = idxOnOrBefore(calendar, config.periodEnd);
  if (i0 < 0) { errors.push(`No price data on or before Period_Start ${config.periodStart}.`); return { errors, warnings }; }
  const dates = calendar.slice(i0, iN + 1);
  const T = dates.length;
  const mapIdx = (d) => Math.min(Math.max(idxOnOrAfter(calendar, d) - i0, 1), T - 1); // events land on next trading day

  // Security master
  const meta = {};
  for (const h of holdings) if (h.ticker !== 'CASH') meta[h.ticker] = { ticker: h.ticker, name: h.name, sector: h.sector, isin: h.isin, yahoo: h.yahoo };
  for (const t of transactions) if (t.ticker !== 'CASH' && !meta[t.ticker]) {
    const b = model.benchmark.find((x) => x.ticker === t.ticker);
    meta[t.ticker] = { ticker: t.ticker, name: b ? b.name : t.ticker, sector: b ? b.sector : 'Unclassified', yahoo: fetched.yahooOf[t.ticker] };
    warnings.push(`${t.ticker} is traded in Transactions but not in Holdings; sector taken as "${meta[t.ticker].sector}".`);
  }
  const tickers = Object.keys(meta);
  const priceOf = (tk, k) => { const s = series[meta[tk].yahoo]; return s ? s.close[i0 + k] : null; };

  // PMS fallback price when Yahoo has nothing
  const pmsPrice = {};
  for (const h of holdings) if (h.price > 0) pmsPrice[h.ticker] = h.price;
  const fallbackUsed = new Set();
  const px = (tk, k) => {
    const p = priceOf(tk, k);
    if (p != null) return p;
    if (pmsPrice[tk]) { fallbackUsed.add(tk); return pmsPrice[tk]; }
    return null;
  };

  // --- quantity deltas from transactions
  const dQty = {}; tickers.forEach((t) => (dQty[t] = new Array(T).fill(0)));
  const tradeCash = {}; tickers.forEach((t) => (tradeCash[t] = new Array(T).fill(0)));
  const cashOnly = new Array(T).fill(0); // fees, interest not tied to a security
  const manualDiv = new Set(transactions.filter((t) => t.type === 'DIVIDEND').map((t) => t.ticker));
  const txLog = [];
  for (const t of transactions) {
    const k = mapIdx(t.date);
    if (t.type === 'BUY' || t.type === 'SELL') {
      const p = t.price ?? px(t.ticker, k);
      if (p == null) { errors.push(`Transactions row ${t._row}: no price given and no market price for ${t.ticker} on ${t.date}.`); continue; }
      const gross = t.qty * p;
      const cash = t.net != null ? Math.abs(t.net) * (t.type === 'BUY' ? -1 : 1) : (t.type === 'BUY' ? -(gross + t.fees) : gross - t.fees);
      dQty[t.ticker][k] += t.type === 'BUY' ? t.qty : -t.qty;
      tradeCash[t.ticker][k] += cash;
      txLog.push({ ...t, priceUsed: p, priceSource: t.price != null ? 'PMS' : 'Close', cash });
    } else if (t.type === 'STOCK_DIVIDEND') {
      dQty[t.ticker][k] += t.qty;
    } else if (t.type === 'DIVIDEND') {
      if (meta[t.ticker]) tradeCash[t.ticker][k] += Math.abs(t.net); else cashOnly[k] += Math.abs(t.net);
    } else if (t.type === 'FEE') cashOnly[k] -= Math.abs(t.net);
    else if (t.type === 'INTEREST') cashOnly[k] += t.net;
  }
  const flow = new Array(T).fill(0);
  for (const f of cashFlows) flow[mapIdx(f.date)] += f.amount;

  // --- opening positions: snapshot on/before period start, else roll back from the latest snapshot
  const snaps = [...new Set(holdings.map((h) => h.date))].sort();
  const openSnap = snaps.filter((d) => d <= config.periodStart).pop();
  const closeSnap = snaps.filter((d) => d > config.periodStart).pop();
  const qty = {}; tickers.forEach((t) => (qty[t] = new Array(T).fill(0)));
  const snapQty = (d) => { const m = {}; let cash = 0; for (const h of holdings) if (h.date === d) { if (h.ticker === 'CASH') cash += h.qty; else m[h.ticker] = (m[h.ticker] || 0) + h.qty; } return { m, cash }; };
  let openingMode, openingCash = null, closingCashTarget = null;
  if (openSnap) {
    openingMode = `Opening positions from the ${openSnap} snapshot, rolled forward with transactions.`;
    const s = snapQty(openSnap);
    for (const t of tickers) { let q = s.m[t] || 0; for (let k = 0; k < T; k++) { if (k > 0) q += dQty[t][k]; qty[t][k] = q; } }
    openingCash = s.cash;
  } else if (closeSnap) {
    openingMode = `No snapshot on/before Period_Start: opening positions derived from the ${closeSnap} snapshot minus transactions.`;
    const s = snapQty(closeSnap);
    const kc = Math.min(idxOnOrBefore(calendar, closeSnap) - i0, T - 1);
    for (const t of tickers) {
      let q = (s.m[t] || 0);
      for (let k = 1; k <= kc; k++) q -= dQty[t][k];
      for (let k = 0; k < T; k++) { if (k > 0) q += dQty[t][k]; qty[t][k] = q; }
    }
    closingCashTarget = { k: kc, cash: s.cash }; // opening cash solved after dividends are known
  } else { errors.push('Holdings has no usable snapshot date.'); return { errors, warnings }; }

  // --- automatic dividends from Yahoo (credited on ex-date to the holder of record the day before)
  const autoDivs = [];
  if (config.autoDividends) {
    for (const t of tickers) {
      if (manualDiv.has(t)) continue;
      const s = series[meta[t].yahoo]; if (!s) continue;
      for (const dv of s.dividends) {
        if (dv.date <= dates[0] || dv.date > dates[T - 1]) continue;
        const k = mapIdx(dv.date); const q = qty[t][k - 1];
        if (q > 0) { tradeCash[t][k] += q * dv.amount; autoDivs.push({ date: dates[k], ticker: t, dps: dv.amount, qty: q, amount: q * dv.amount }); }
      }
    }
  }
  // stock splits inside the period make PMS quantities and Yahoo's split-adjusted prices disagree
  for (const t of tickers) {
    const s = series[meta[t].yahoo];
    for (const sp of (s && s.splits) || []) if (sp.date > dates[0] && sp.date <= dates[T - 1] && qty[t].some((q) => q)) warnings.push(`${t}: Yahoo reports a ${sp.ratio} split/stock dividend on ${sp.date}. Yahoo back-adjusts prices, so record the share change as STOCK_DIVIDEND and check pre-split quantities.`);
  }

  // --- cash path
  const netCash = new Array(T).fill(0);
  for (let k = 1; k < T; k++) { netCash[k] = cashOnly[k] + flow[k]; for (const t of tickers) netCash[k] += tradeCash[t][k]; }
  if (openingCash == null) { let c = closingCashTarget.cash; for (let k = 1; k <= closingCashTarget.k; k++) c -= netCash[k]; openingCash = c; }
  const cash = new Array(T); cash[0] = openingCash;
  for (let k = 1; k < T; k++) cash[k] = cash[k - 1] + netCash[k];
  if (Math.min(...cash) < -1) warnings.push(`Cash goes negative (min ${Math.min(...cash).toLocaleString(undefined, { maximumFractionDigits: 0 })}). Check opening cash, trade amounts and cash flows.`);

  // --- valuations & P&L
  const mv = {}; const pnl = {};
  const missingPx = new Set();
  for (const t of tickers) {
    mv[t] = new Array(T).fill(0); pnl[t] = new Array(T).fill(0);
    let lastP = null;
    for (let k = 0; k < T; k++) {
      let p = px(t, k);
      if (p == null) { p = lastP; if (qty[t][k] && p == null) missingPx.add(t); }
      lastP = p ?? lastP;
      mv[t][k] = qty[t][k] * (p || 0);
      if (k > 0) pnl[t][k] = mv[t][k] - mv[t][k - 1] + tradeCash[t][k];
    }
  }
  for (const t of missingPx) errors.push(`${t}: no Yahoo price and no PMS price on some held dates — valued at zero. Add a Price_Override.`);
  for (const t of fallbackUsed) warnings.push(`${t}: Yahoo price missing on some dates; PMS price from Holdings used instead.`);

  const V = new Array(T).fill(0); const ret = new Array(T).fill(0);
  for (let k = 0; k < T; k++) { V[k] = cash[k]; for (const t of tickers) V[k] += mv[t][k]; }
  for (let k = 1; k < T; k++) ret[k] = V[k - 1] > 0 ? (V[k] - V[k - 1] - flow[k]) / V[k - 1] : 0;
  const cashPnl = cashOnly.slice();

  // --- reconciliation against a closing snapshot (when the opening one was used)
  const recon = [];
  if (openSnap && closeSnap) {
    const s = snapQty(closeSnap); const kc = Math.min(idxOnOrBefore(calendar, closeSnap) - i0, T - 1);
    const all = new Set([...Object.keys(s.m), ...tickers]);
    for (const t of all) {
      const book = qty[t] ? qty[t][kc] : 0, pms = s.m[t] || 0;
      if (Math.abs(book - pms) > 1e-6) recon.push({ ticker: t, book, pms, diff: book - pms });
    }
    const hasCash = holdings.some((h) => h.date === closeSnap && h.ticker === 'CASH');
    if (hasCash && Math.abs(cash[kc] - s.cash) > 1) recon.push({ ticker: 'CASH', book: cash[kc], pms: s.cash, diff: cash[kc] - s.cash });
    if (recon.length) warnings.push(`Rolled-forward positions differ from the ${closeSnap} PMS snapshot for ${recon.length} line(s); see Data Quality.`);
  }

  // --- PMS price / market value cross-check on the latest snapshot
  const priceCheck = [];
  const lastSnap = snaps[snaps.length - 1];
  const kl = Math.min(Math.max(idxOnOrBefore(calendar, lastSnap) - i0, 0), T - 1);
  for (const h of holdings.filter((x) => x.date === lastSnap && x.ticker !== 'CASH')) {
    const yp = priceOf(h.ticker, kl);
    const pp = h.price ?? (h.mv && h.qty ? h.mv / h.qty : null);
    if (yp && pp) { const d = pp / yp - 1; if (Math.abs(d) > 0.01) priceCheck.push({ ticker: h.ticker, pms: pp, yahoo: yp, diff: d }); }
  }
  if (priceCheck.length) warnings.push(`${priceCheck.length} PMS price(s) differ from Yahoo close by more than 1% on ${lastSnap}.`);

  return { dates, i0, T, tickers, meta, qty, mv, pnl, cash, cashPnl, flow, V, ret, tradeCash, txLog, autoDivs, openingMode, recon, priceCheck, errors, warnings };
}

// Data-quality table per security (coverage within the VaR window)
export function dataQuality(model, panel, fetched, book) {
  const { config } = model;
  const iv = idxOnOrBefore(panel.calendar, config.valuationDate);
  const winStart = Math.max(0, iv - config.lookback);
  const rows = [];
  const seen = new Set();
  const add = (ticker, yahoo, role) => {
    if (seen.has(yahoo)) { rows.find((r) => r.yahoo === yahoo).role += ', ' + role; return; }
    seen.add(yahoo);
    const s = panel.series[yahoo];
    if (!s) { rows.push({ ticker, yahoo, role, status: 'NO DATA', note: fetched.errors[yahoo] || 'Not returned', obs: 0 }); return; }
    let obs = 0; for (let i = winStart; i <= iv; i++) if (s.raw[i]) obs++;
    const window = iv - winStart + 1;
    const lastPx = s.close[iv];
    let status = 'OK', note = '';
    if (lastPx == null) { status = 'STALE'; note = `No price within ${MAX_FFILL} days of valuation date (last ${s.lastDate || 'n/a'})`; }
    else if (obs < window * 0.6) { status = 'SHORT'; note = `Only ${obs} of ${window} days — VaR uses the benchmark as proxy for missing days`; }
    else if (obs < window * 0.95) { status = 'GAPS'; note = `${window - obs} missing days forward-filled or proxied`; }
    if (s.override) note += (note ? '; ' : '') + 'manual price override applied';
    rows.push({ ticker, yahoo, role, status, note, obs, window, first: s.firstDate, last: s.lastDate, lastPx });
  };
  const held = book && book.tickers ? book.tickers : [];
  for (const t of held) add(t, book.meta[t].yahoo, 'Portfolio');
  for (const b of model.benchmark) add(b.ticker, b.yahoo, 'Benchmark');
  add('Index', config.benchmarkSymbol, 'Benchmark index');
  return rows;
}

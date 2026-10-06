// Performance engine: daily TWR (flows at end of day), XIRR, risk-adjusted
// statistics vs. benchmark, and Carino-linked contribution by security/sector.
import { mean, std, covariance, xirr } from './math.js';

const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 864e5;
export const carinoK = (r) => (Math.abs(r) < 1e-12 ? 1 : Math.log(1 + r) / r);

export function computePerformance(model, panel, book) {
  const { config } = model;
  const { dates, T, ret, V, flow } = book;
  const bmS = panel.series[config.benchmarkSymbol];
  const bmPx = bmS ? (config.benchmarkReturnType === 'TOTAL' ? bmS.adj : bmS.close) : null;
  const rb = new Array(T).fill(0);
  if (bmPx) for (let k = 1; k < T; k++) { const a = bmPx[book.i0 + k - 1], b = bmPx[book.i0 + k]; rb[k] = a && b ? b / a - 1 : 0; }
  const rf = config.riskFreeRate, rfD = Math.pow(1 + rf, 1 / 252) - 1;

  // gross-of-fee returns (add back fee transactions)
  const fees = book.cashPnl.map((x) => Math.min(0, x)); // negative numbers
  const totalFees = -fees.reduce((s, x) => s + x, 0);
  const retGross = ret.map((r, k) => (k && V[k - 1] > 0 ? r - fees[k] / V[k - 1] : 0));

  const growth = (rs) => { const g = [100]; for (let k = 1; k < rs.length; k++) g.push(g[k - 1] * (1 + rs[k])); return g; };
  const gP = growth(ret), gB = growth(rb), gG = growth(retGross);
  const R = gP[T - 1] / 100 - 1, RB = gB[T - 1] / 100 - 1, RG = gG[T - 1] / 100 - 1;
  const nDays = daysBetween(dates[0], dates[T - 1]);
  const ann = (x) => (nDays >= 365 ? Math.pow(1 + x, 365 / nDays) - 1 : null);

  // ---- trailing periods
  const end = dates[T - 1];
  const anchorIdx = (anchorDate) => { let a = -1; for (let k = 0; k < T; k++) if (dates[k] <= anchorDate) a = k; return a; };
  const y = +end.slice(0, 4), m = +end.slice(5, 7);
  const lastDayPrev = (yy, mm) => new Date(Date.UTC(yy, mm - 1, 0)).toISOString().slice(0, 10);
  const shift = (months) => { const d = new Date(end + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
  const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const periodsDef = [
    ['MTD', lastDayPrev(y, m)], ['QTD', lastDayPrev(y, qStartMonth)], ['YTD', `${y - 1}-12-31`],
    ['1 Month', shift(1)], ['3 Months', shift(3)], ['6 Months', shift(6)], ['1 Year', shift(12)],
  ];
  const periods = [];
  for (const [label, anchor] of periodsDef) {
    if (anchor < dates[0]) continue;
    const a = anchorIdx(anchor); if (a < 0 || a >= T - 1) continue;
    const p = gP[T - 1] / gP[a] - 1, b = gB[T - 1] / gB[a] - 1;
    periods.push({ label, from: dates[a], port: p, bench: b, active: p - b });
  }
  periods.push({ label: 'Since period start', from: dates[0], port: R, bench: RB, active: R - RB, annPort: ann(R), annBench: ann(RB) });

  // ---- statistics on daily returns
  const rp = ret.slice(1), rbb = rb.slice(1);
  const n = rp.length;
  // calendar-day annualisation (same as the headline); periods under a year are not annualised
  const annRet = (x) => (nDays >= 365 ? Math.pow(1 + x, 365 / nDays) - 1 : x);
  const volP = std(rp) * Math.sqrt(252), volB = std(rbb) * Math.sqrt(252);
  const annP = annRet(R), annB = annRet(RB);
  const downside = (rs) => Math.sqrt(mean(rs.map((r) => Math.min(0, r - rfD) ** 2))) * Math.sqrt(252);
  const varB = std(rbb) ** 2;
  const beta = varB ? covariance(rp, rbb) / varB : NaN;
  const alpha = (mean(rp) - rfD - beta * (mean(rbb) - rfD)) * 252;
  const active = rp.map((r, i) => r - rbb[i]);
  const te = std(active) * Math.sqrt(252);
  const dd = (g) => {
    let peak = g[0], pk = 0, maxDD = 0, ddPk = 0, ddTr = 0; const s = [];
    for (let k = 0; k < g.length; k++) {
      if (g[k] > peak) { peak = g[k]; pk = k; }
      const d = g[k] / peak - 1; s.push(d);
      if (d < maxDD) { maxDD = d; ddPk = pk; ddTr = k; }
    }
    let rec = null; for (let k = ddTr; k < g.length; k++) if (g[k] >= g[ddPk]) { rec = k; break; }
    return { series: s, maxDD, peak: dates[ddPk], trough: dates[ddTr], recovery: rec != null ? dates[rec] : null, tradingDaysToRecover: rec != null ? rec - ddTr : null };
  };
  const ddP = dd(gP), ddB = dd(gB);
  const capture = (up) => {
    const idx = rbb.map((r, i) => ((up ? r > 0 : r < 0) ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return NaN;
    const gm = (arr) => Math.pow(idx.reduce((p, i) => p * (1 + arr[i]), 1), 1 / idx.length) - 1;
    return gm(rp) / gm(rbb);
  };

  // ---- monthly table
  const months = []; let cur = null;
  for (let k = 1; k < T; k++) {
    const key = dates[k].slice(0, 7);
    if (!cur || cur.key !== key) { cur = { key, port: 1, bench: 1 }; months.push(cur); }
    cur.port *= 1 + ret[k]; cur.bench *= 1 + rb[k];
  }
  months.forEach((x) => { x.port -= 1; x.bench -= 1; x.active = x.port - x.bench; });
  const hitRate = months.length ? months.filter((x) => x.active > 0).length / months.length : NaN;

  // ---- rolling 63-day annualised volatility
  const W = 63, rolling = [];
  for (let k = W; k < T; k++) rolling.push({ date: dates[k], port: std(ret.slice(k - W + 1, k + 1)) * Math.sqrt(252), bench: std(rb.slice(k - W + 1, k + 1)) * Math.sqrt(252) });

  // ---- money-weighted return
  const irrFlows = [{ date: dates[0], amount: -V[0] }];
  for (let k = 1; k < T; k++) if (flow[k]) irrFlows.push({ date: dates[k], amount: -flow[k] });
  irrFlows.push({ date: dates[T - 1], amount: V[T - 1] });
  const irr = xirr(irrFlows);
  const mwrPeriod = isFinite(irr) ? Math.pow(1 + irr, nDays / 365) - 1 : NaN;

  // ---- Carino-linked contribution
  const K = carinoK(R);
  const kt = ret.map((r) => carinoK(r));
  const contrib = book.tickers.map((t) => {
    let c = 0, w = 0, nw = 0, g = 1, pnlSum = 0;
    for (let k = 1; k < T; k++) {
      const v0 = V[k - 1]; if (v0 <= 0) continue;
      c += (book.pnl[t][k] / v0) * kt[k];
      pnlSum += book.pnl[t][k];
      const m0 = book.mv[t][k - 1];
      w += m0 / v0; nw++;
      if (m0 > 0) g *= 1 + book.pnl[t][k] / m0;
    }
    return { ticker: t, name: book.meta[t].name, sector: book.meta[t].sector, avgWeight: w / nw, endWeight: book.mv[t][T - 1] / V[T - 1], ret: g - 1, pnl: pnlSum, contribution: c / K };
  });
  let cashC = 0, cashPnl = 0, cashW = 0;
  for (let k = 1; k < T; k++) { if (V[k - 1] > 0) { cashC += (book.cashPnl[k] / V[k - 1]) * kt[k]; cashW += book.cash[k - 1] / V[k - 1]; } cashPnl += book.cashPnl[k]; }
  contrib.push({ ticker: 'CASH', name: 'Cash, fees & interest', sector: 'Cash', avgWeight: cashW / (T - 1), endWeight: book.cash[T - 1] / V[T - 1], ret: null, pnl: cashPnl, contribution: cashC / K });
  contrib.sort((a, b) => b.contribution - a.contribution);
  const bySector = {};
  for (const c of contrib) { const s = (bySector[c.sector] ||= { sector: c.sector, avgWeight: 0, pnl: 0, contribution: 0 }); s.avgWeight += c.avgWeight; s.pnl += c.pnl; s.contribution += c.contribution; }

  const totalFlows = flow.reduce((s, x) => s + x, 0);
  const divs = book.autoDivs.reduce((s, d) => s + d.amount, 0) + model.transactions.filter((t) => t.type === 'DIVIDEND').reduce((s, t) => s + Math.abs(t.net), 0);

  return {
    start: dates[0], end, nDays, startValue: V[0], endValue: V[T - 1], netFlows: totalFlows, gain: V[T - 1] - V[0] - totalFlows,
    dividends: divs, fees: totalFees,
    twr: R, twrGross: RG, bench: RB, active: R - RB, annTwr: ann(R), annBench: ann(RB), irr, mwrPeriod,
    periods,
    stats: {
      volP, volB, annP, annB, sharpeP: (annP - rf) / volP, sharpeB: (annB - rf) / volB,
      sortinoP: (annP - rf) / downside(rp), sortinoB: (annB - rf) / downside(rbb),
      maxDDP: ddP.maxDD, maxDDB: ddB.maxDD, calmarP: annP / Math.abs(ddP.maxDD), calmarB: annB / Math.abs(ddB.maxDD),
      beta, alpha, te, ir: (annP - annB) / te, upCapture: capture(true), downCapture: capture(false), hitRate,
      bestDay: Math.max(...rp), worstDay: Math.min(...rp), ddDetail: ddP,
    },
    chart: { dates, gP, gB, ddP: ddP.series, ddB: ddB.series, rolling },
    months, contrib, bySector: Object.values(bySector).sort((a, b) => b.contribution - a.contribution),
    rb, benchmarkLabel: `${config.benchmarkName} (${config.benchmarkReturnType === 'TOTAL' ? 'total return' : 'price return'})`,
  };
}

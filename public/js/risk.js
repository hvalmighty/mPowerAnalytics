// Value-at-Risk engine: historical, parametric (delta-normal) and Monte Carlo,
// with ES, component / marginal / incremental VaR, stress tests and backtesting.
import { mean, quantile, covMatrix, ewmaCov, matVec, dot, cholesky, normInv, normPdf, makeRng, chi2sf1 } from './math.js';
import { idxOnOrBefore } from './data.js';

function binomCdf(x, n, p) {
  let s = 0, term = Math.pow(1 - p, n);
  for (let k = 0; k <= x; k++) { s += term; term *= ((n - k) / (k + 1)) * (p / (1 - p)); }
  return Math.min(1, s);
}

export function computeRisk(model, panel, book) {
  const { config, holdings } = model;
  const { calendar, series } = panel;
  const warnings = [];
  const iv = idxOnOrBefore(calendar, config.valuationDate);
  const bmS = series[config.benchmarkSymbol];

  // ---- positions on the valuation date
  let positions = [];
  let cashAtVal = 0;
  if (book && book.dates && iv >= book.i0 && iv - book.i0 < book.T) {
    const k = iv - book.i0;
    for (const t of book.tickers) if (Math.abs(book.qty[t][k]) > 1e-9) positions.push({ ...book.meta[t], qty: book.qty[t][k], mv: book.mv[t][k] });
    cashAtVal = book.cash[k];
  } else {
    const snap = [...new Set(holdings.map((h) => h.date))].filter((d) => d <= config.valuationDate).sort().pop();
    for (const h of holdings.filter((x) => x.date === snap)) {
      if (h.ticker === 'CASH') { cashAtVal += h.qty; continue; }
      const s = series[h.yahoo]; const p = (s && s.close[iv]) || h.price;
      positions.push({ ticker: h.ticker, name: h.name, sector: h.sector, yahoo: h.yahoo, qty: h.qty, mv: h.qty * (p || 0) });
    }
  }
  positions = positions.filter((p) => p.mv !== 0);
  const N = positions.length;
  const MV = positions.map((p) => p.mv);
  const grossMV = MV.reduce((s, x) => s + Math.abs(x), 0);
  const netMV = MV.reduce((s, x) => s + x, 0);
  const totalNAV = netMV + cashAtVal;
  if (!N) return { error: 'No security positions on the valuation date.' };

  // ---- log-return matrix (rows = dates, oldest first); benchmark proxies gaps
  const L = config.lookback;
  let B = config.backtestDays;
  const firstIdx = Math.max(1, iv - L - B + 1);
  if (iv - firstIdx + 1 < L + B) { B = Math.max(0, iv - firstIdx + 1 - L); warnings.push(`Only ${iv} days of history available: backtest shortened to ${B} days.`); }
  const lookbackUsed = Math.min(L, iv - firstIdx + 1);
  const idxRet = (i) => (bmS && bmS.adj[i] && bmS.adj[i - 1] ? Math.log(bmS.adj[i] / bmS.adj[i - 1]) : 0);
  const proxied = new Array(N).fill(0);
  const rows = []; // all days firstIdx..iv
  for (let i = firstIdx; i <= iv; i++) {
    const r = new Array(N);
    for (let j = 0; j < N; j++) {
      const s = series[positions[j].yahoo];
      if (s && s.adj[i] != null && s.adj[i - 1] != null) r[j] = Math.log(s.adj[i] / s.adj[i - 1]);
      else { r[j] = idxRet(i); if (i > iv - lookbackUsed) proxied[j]++; }
    }
    rows.push(r);
  }
  positions.forEach((p, j) => { p.proxiedDays = proxied[j]; });
  const win = rows.slice(rows.length - lookbackUsed);
  const pnlOf = (r) => { let s = 0; for (let j = 0; j < N; j++) s += MV[j] * (Math.exp(r[j]) - 1); return s; };
  const pnlAll = rows.map(pnlOf);
  const histPnl = pnlAll.slice(pnlAll.length - lookbackUsed);

  // ---- covariance
  const Sigma = config.covMethod === 'EWMA' ? ewmaCov(win, config.ewmaLambda) : covMatrix(win);
  const SM = matVec(Sigma, MV);
  const sigmaP = Math.sqrt(Math.max(dot(MV, SM), 0));
  const vol = Sigma.map((r, i) => Math.sqrt(r[i]));
  const corr = Sigma.map((r, i) => r.map((c, j) => (vol[i] && vol[j] ? c / (vol[i] * vol[j]) : 0)));

  // ---- Monte Carlo simulation (1-day, seeded)
  const Lc = cholesky(Sigma);
  const rng = makeRng(20240601);
  const mcPnl = new Float64Array(config.mcSims);
  const z = new Array(N), r = new Array(N);
  for (let s = 0; s < config.mcSims; s++) {
    for (let j = 0; j < N; j++) z[j] = rng.norm();
    for (let i = 0; i < N; i++) { let x = 0; for (let j = 0; j <= i; j++) x += Lc[i][j] * z[j]; r[i] = x; }
    mcPnl[s] = pnlOf(r);
  }

  const tailStats = (pnl, a) => {
    const v = -quantile(pnl, 1 - a);
    const tail = []; for (const x of pnl) if (x <= -v) tail.push(x);
    return { var: v, es: tail.length ? -mean(tail) : v };
  };

  // ---- headline table
  const table = [];
  for (const a of config.confidence) {
    const zA = normInv(a);
    const h = tailStats(histPnl, a);
    const m = tailStats(mcPnl, a);
    const p = { var: zA * sigmaP, es: (sigmaP * normPdf(zA)) / (1 - a) };
    for (const hd of config.horizons) {
      const sc = Math.sqrt(hd);
      table.push({ conf: a, horizon: hd, histVar: h.var * sc, histEs: h.es * sc, paraVar: p.var * sc, paraEs: p.es * sc, mcVar: m.var * sc, mcEs: m.es * sc });
    }
  }

  // ---- decomposition at the highest confidence, 1-day
  const aMax = Math.max(...config.confidence);
  const zMax = normInv(aMax);
  const hMax = tailStats(histPnl, aMax);
  const tailIdx = histPnl.map((x, s) => (x <= -hMax.var ? s : -1)).filter((s) => s >= 0);
  const varWithout = (j) => {
    const p = win.map((row) => { let s = 0; for (let k = 0; k < N; k++) if (k !== j) s += MV[k] * (Math.exp(row[k]) - 1); return s; });
    return -quantile(p, 1 - aMax);
  };
  const contrib = positions.map((pos, j) => {
    const comp = sigmaP ? (zMax * MV[j] * SM[j]) / sigmaP : 0;
    const standalone = zMax * Math.abs(MV[j]) * vol[j];
    const esContrib = tailIdx.length ? -mean(tailIdx.map((s) => MV[j] * (Math.exp(win[s][j]) - 1))) : 0;
    return {
      ticker: pos.ticker, name: pos.name, sector: pos.sector, mv: MV[j], weight: MV[j] / totalNAV,
      annVol: vol[j] * Math.sqrt(252), standalone, marginal: sigmaP ? (zMax * SM[j]) / sigmaP : 0,
      component: comp, componentPct: comp / (zMax * sigmaP), incremental: hMax.var - varWithout(j), histEsContrib: esContrib,
      proxiedDays: pos.proxiedDays,
    };
  }).sort((a, b) => b.component - a.component);

  const bySector = {};
  for (const c of contrib) {
    const s = (bySector[c.sector] ||= { sector: c.sector, mv: 0, component: 0, standalone: 0, histEsContrib: 0 });
    s.mv += c.mv; s.component += c.component; s.standalone += c.standalone; s.histEsContrib += c.histEsContrib;
  }
  // sector standalone VaR (diversified within sector)
  for (const s of Object.values(bySector)) {
    const w = positions.map((p, j) => (p.sector === s.sector ? MV[j] : 0));
    s.sectorVar = zMax * Math.sqrt(Math.max(dot(w, matVec(Sigma, w)), 0));
    s.weight = s.mv / totalNAV; s.componentPct = s.component / (zMax * sigmaP);
  }
  const sumStandalone = contrib.reduce((s, c) => s + c.standalone, 0);

  // ---- backtest (hypothetical P&L of today's positions vs. rolling historical VaR)
  const backtest = { days: B, series: [], byConf: [] };
  if (B >= 20) {
    for (const a of config.confidence) {
      let x = 0;
      for (let t = pnlAll.length - B; t < pnlAll.length; t++) {
        const v = -quantile(pnlAll.slice(t - lookbackUsed, t), 1 - a);
        if (a === aMax) backtest.series.push({ date: calendar[firstIdx + t], pnl: pnlAll[t], var: -v });
        if (pnlAll[t] < -v) x++;
      }
      const p = 1 - a, n = B, ph = x / n;
      const ll0 = (n - x) * Math.log(1 - p) + x * Math.log(p);
      const ll1 = (x === 0 ? 0 : x * Math.log(ph)) + (x === n ? 0 : (n - x) * Math.log(1 - ph));
      const lr = -2 * (ll0 - ll1);
      const cdf = binomCdf(x, n, p);
      backtest.byConf.push({ conf: a, exceptions: x, expected: n * p, lr, pValue: chi2sf1(lr), zone: cdf < 0.95 ? 'Green' : cdf < 0.9999 ? 'Yellow' : 'Red' });
    }
  } else warnings.push('Not enough history for a VaR backtest (need lookback + 20 days).');

  // ---- stress tests
  const stress = [];
  const histWorst = (h) => {
    let worst = Infinity, at = null;
    for (let t = h - 1; t < pnlAll.length; t++) {
      let s = 0; for (let k = t - h + 1; k <= t; k++) s += pnlAll[k];
      if (s < worst) { worst = s; at = calendar[firstIdx + t]; }
    }
    return { worst, at };
  };
  for (const [h, label] of [[1, 'Worst 1-day loss in history window'], [5, 'Worst 5-day loss in history window'], [20, 'Worst 20-day loss in history window']]) {
    const w = histWorst(h);
    if (w.at) stress.push({ name: label, type: 'Historical (window)', detail: `ending ${w.at}`, pnl: w.worst, pct: w.worst / totalNAV });
  }
  for (const sc of model.scenarios) {
    if (sc.type === 'SHOCK') {
      const tgt = sc.target.toUpperCase();
      let pnl = 0, hit = 0;
      positions.forEach((p, j) => {
        if (tgt === 'ALL' || p.sector.toUpperCase() === tgt || p.ticker === tgt) { pnl += MV[j] * sc.shock; hit++; }
      });
      stress.push({ name: sc.name, type: 'Hypothetical shock', detail: `${(sc.shock * 100).toFixed(1)}% on ${sc.target} (${hit} positions)`, pnl, pct: pnl / totalNAV });
    } else {
      const a = idxOnOrBefore(calendar, sc.start), b = idxOnOrBefore(calendar, sc.end);
      if (a < 0 || b <= a) { stress.push({ name: sc.name, type: 'Historical replay', detail: 'No price data for this window', pnl: null, pct: null }); continue; }
      const bmMove = bmS && bmS.adj[a] && bmS.adj[b] ? bmS.adj[b] / bmS.adj[a] - 1 : null;
      let pnl = 0, prox = 0;
      positions.forEach((p, j) => {
        const s = series[p.yahoo];
        let mv = s && s.adj[a] && s.adj[b] ? s.adj[b] / s.adj[a] - 1 : null;
        if (mv == null) { mv = bmMove ?? 0; prox++; }
        pnl += MV[j] * mv;
      });
      stress.push({ name: sc.name, type: 'Historical replay', detail: `${calendar[a]} → ${calendar[b]}; index ${bmMove != null ? (bmMove * 100).toFixed(1) + '%' : 'n/a'}${prox ? `; ${prox} position(s) proxied by index (not listed then)` : ''}`, pnl, pct: pnl / totalNAV });
    }
  }

  // ---- P&L histogram (historical, 1-day)
  const lo = Math.min(...histPnl), hi = Math.max(...histPnl);
  const bins = 40, bw = (hi - lo) / bins || 1;
  const hist = Array.from({ length: bins }, (_, i) => ({ x0: lo + i * bw, x1: lo + (i + 1) * bw, n: 0 }));
  for (const x of histPnl) hist[Math.min(bins - 1, Math.floor((x - lo) / bw))].n++;

  const shortHist = positions.filter((p) => p.proxiedDays > 0).map((p) => `${p.ticker} (${p.proxiedDays}d)`);
  if (shortHist.length) warnings.push(`Benchmark returns used as proxy for missing days: ${shortHist.join(', ')}.`);

  return {
    valuationDate: calendar[iv], lookbackUsed, positions, totalNAV, netMV, grossMV, cash: cashAtVal, sigmaP, aMax,
    table, contrib, bySector: Object.values(bySector).sort((a, b) => b.component - a.component),
    diversification: { sumStandalone, portfolioVar: zMax * sigmaP, benefit: sumStandalone - zMax * sigmaP },
    corr: { tickers: positions.map((p) => p.ticker), m: corr }, hist, histVarLine: -hMax.var,
    backtest, stress, warnings, covMethod: config.covMethod === 'EWMA' ? `EWMA (λ = ${config.ewmaLambda})` : 'Equal-weighted sample',
  };
}

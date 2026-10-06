// Brinson-Fachler sector attribution, computed daily and linked over the
// period with Carino's logarithmic method so effects add up exactly to the
// active return versus the constituent-built benchmark.

const key = (s) => String(s).trim().toLowerCase();

function carinoLink(dailyEffects, rp, rb) {
  // dailyEffects: array over days of numbers; rp/rb: daily total returns (same length)
  const k = (a, b) => (Math.abs(a - b) < 1e-12 ? 1 / (1 + a) : (Math.log(1 + a) - Math.log(1 + b)) / (a - b));
  const RP = rp.reduce((p, r) => p * (1 + r), 1) - 1, RB = rb.reduce((p, r) => p * (1 + r), 1) - 1;
  const K = k(RP, RB);
  const kt = rp.map((r, i) => k(r, rb[i]));
  return { link: (eff) => eff.reduce((s, e, i) => s + e * kt[i], 0) / K, RP, RB };
}

export function computeAttribution(model, panel, book) {
  const { config, benchmark } = model;
  if (!benchmark.length) return { skipped: 'No Benchmark_Constituents sheet supplied.' };
  const { series } = panel;
  const { T, i0, V, dates } = book;
  const warnings = [];
  const priceArr = (s) => (config.benchmarkReturnType === 'TOTAL' ? s.adj : s.close);

  // ---- benchmark: buy-and-hold from period start weights
  const names = {};
  const cons = [];
  let wsum = 0;
  for (const b of benchmark) {
    const s = series[b.yahoo];
    const p0 = s && priceArr(s)[i0];
    if (!p0) { warnings.push(`Benchmark constituent ${b.ticker} has no price on ${dates[0]}; excluded and weights renormalised.`); continue; }
    cons.push({ ...b, units: b.weight / p0, px: priceArr(s) }); wsum += b.weight;
    names[key(b.sector)] ||= b.sector;
  }
  cons.forEach((c) => (c.units /= wsum));
  for (const t of book.tickers) names[key(book.meta[t].sector)] ||= book.meta[t].sector;
  names.cash ||= 'Cash';
  const segs = Object.keys(names);

  const bVal = (c, k) => { let p = c.px[i0 + k]; let j = k; while (p == null && j > 0) p = c.px[i0 + --j]; return c.units * (p || 0); };
  const BV = segs.map(() => new Array(T).fill(0));
  for (const c of cons) { const si = segs.indexOf(key(c.sector)); for (let k = 0; k < T; k++) BV[si][k] += bVal(c, k); }
  const BVtot = new Array(T).fill(0); for (let k = 0; k < T; k++) for (let s = 0; s < segs.length; s++) BVtot[k] += BV[s][k];

  // ---- portfolio segments
  const PMV = segs.map(() => new Array(T).fill(0)), PPNL = segs.map(() => new Array(T).fill(0));
  for (const t of book.tickers) {
    const si = segs.indexOf(key(book.meta[t].sector));
    for (let k = 0; k < T; k++) { PMV[si][k] += book.mv[t][k]; PPNL[si][k] += book.pnl[t][k]; }
  }
  const ci = segs.indexOf('cash');
  for (let k = 0; k < T; k++) { PMV[ci][k] += book.cash[k]; PPNL[ci][k] += book.cashPnl[k]; }

  // ---- daily effects
  const S = segs.length;
  const eff = { alloc: segs.map(() => []), sel: segs.map(() => []), inter: segs.map(() => []) };
  const rpT = [], rbT = [];
  const wp = segs.map(() => 0), wb = segs.map(() => 0);
  const gP = segs.map(() => 1), gB = segs.map(() => 1);
  for (let k = 1; k < T; k++) {
    const v0 = V[k - 1];
    let Rp = 0, Rb = BVtot[k] / BVtot[k - 1] - 1;
    const rbs = [], wps = [], wbs = [], cps = [];
    for (let s = 0; s < S; s++) {
      wps[s] = v0 > 0 ? PMV[s][k - 1] / v0 : 0;
      cps[s] = v0 > 0 ? PPNL[s][k] / v0 : 0;
      wbs[s] = BVtot[k - 1] ? BV[s][k - 1] / BVtot[k - 1] : 0;
      rbs[s] = BV[s][k - 1] ? BV[s][k] / BV[s][k - 1] - 1 : 0;
      Rp += cps[s];
      wp[s] += wps[s]; wb[s] += wbs[s];
      if (PMV[s][k - 1] > 0) gP[s] *= 1 + PPNL[s][k] / PMV[s][k - 1];
      if (BV[s][k - 1]) gB[s] *= 1 + rbs[s];
    }
    for (let s = 0; s < S; s++) {
      // Segments absent from the benchmark have no benchmark return of their own:
      // cash is benchmarked at 0% (so cash drag/cushion shows as allocation), other
      // off-benchmark sectors at the total benchmark return. Their whole non-allocation
      // effect is reported as selection (interaction is 0).
      const inBench = wbs[s] > 0;
      const rbS = inBench ? rbs[s] : segs[s] === 'cash' ? 0 : Rb;
      const a = (wps[s] - wbs[s]) * (rbS - Rb);
      const rpS = wps[s] > 0 ? cps[s] / wps[s] : rbS;
      const inter = wps[s] > 0 && inBench ? (wps[s] - wbs[s]) * (rpS - rbS) : 0;
      const sel = cps[s] - wps[s] * rbS - inter; // = wb·(rp − rb) when held; trading P&L otherwise
      eff.alloc[s].push(a); eff.sel[s].push(sel); eff.inter[s].push(inter);
    }
    rpT.push(Rp); rbT.push(Rb);
  }

  const { link, RP, RB } = carinoLink(null, rpT, rbT);
  const rows = segs.map((sk, s) => ({
    sector: names[sk],
    wp: wp[s] / (T - 1), wb: wb[s] / (T - 1),
    rp: PMV[s].some((x) => x > 0) ? gP[s] - 1 : null,
    rb: BV[s].some((x) => x > 0) ? gB[s] - 1 : null,
    alloc: link(eff.alloc[s]), sel: link(eff.sel[s]), inter: link(eff.inter[s]),
  }));
  rows.forEach((r) => (r.total = r.alloc + r.sel + r.inter));
  rows.sort((a, b) => b.total - a.total);
  const tot = rows.reduce((o, r) => ({ alloc: o.alloc + r.alloc, sel: o.sel + r.sel, inter: o.inter + r.inter }), { alloc: 0, sel: 0, inter: 0 });

  // ---- monthly decomposition (each month linked on its own)
  const monthly = [];
  let start = 0;
  for (let d = 1; d <= rpT.length; d++) {
    const m0 = dates[start + 1].slice(0, 7);
    if (d === rpT.length || dates[d + 1].slice(0, 7) !== m0) {
      const rp = rpT.slice(start, d), rb = rbT.slice(start, d);
      const L = carinoLink(null, rp, rb);
      const sumSegs = (e) => e.reduce((acc, arr) => acc + L.link(arr.slice(start, d)), 0);
      monthly.push({ month: m0, port: L.RP, bench: L.RB, alloc: sumSegs(eff.alloc), sel: sumSegs(eff.sel), inter: sumSegs(eff.inter) });
      start = d;
    }
  }

  const bmS = series[config.benchmarkSymbol];
  const bmPx = bmS ? priceArr(bmS) : null;
  const officialB = bmPx && bmPx[i0] && bmPx[i0 + T - 1] ? bmPx[i0 + T - 1] / bmPx[i0] - 1 : null;

  return {
    rows, totals: tot, portReturn: RP, benchReturn: RB, active: RP - RB,
    residual: RP - RB - (tot.alloc + tot.sel + tot.inter), officialBench: officialB,
    monthly, warnings, nConstituents: cons.length,
  };
}

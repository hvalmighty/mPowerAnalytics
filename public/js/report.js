// Renders the four report tabs (plus data quality) with tables and Chart.js charts.

const charts = [];
export function destroyCharts() { while (charts.length) charts.pop().destroy(); }

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const fmt = {
  php: (x, dp = 0) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−₱' : '₱') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })),
  pct: (x, dp = 2) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(dp) + '%'),
  bp: (x) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−' : '') + Math.abs(x * 1e4).toFixed(0) + ' bp'),
  num: (x, dp = 2) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−' : '') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })),
  qty: (x) => (x == null ? '–' : x.toLocaleString('en-US', { maximumFractionDigits: 2 })),
};
const sign = (x) => (x > 1e-12 ? 'pos' : x < -1e-12 ? 'neg' : '');

function table(cols, rows, totalRow) {
  const th = cols.map((c) => `<th class="${c.l ? 'l' : ''}">${c.h}</th>`).join('');
  const tr = (r, cls = '') => `<tr class="${cls}">${cols.map((c) => { const v = c.v ? c.v(r) : null; return `<td class="${c.l ? 'l ' : ''}${c.wrap ? 'wrap ' : ''}${c.signed && v != null ? sign(v) : ''}">${c.f(r)}</td>`; }).join('')}</tr>`;
  return `<div class="tbl-wrap"><table><thead><tr>${th}</tr></thead><tbody>${rows.map((r) => tr(r)).join('')}${totalRow ? tr(totalRow, 'total') : ''}</tbody></table></div>`;
}
const panel = (title, body, desc = '') => `<div class="panel"><h3>${title}</h3>${desc ? `<p class="desc">${desc}</p>` : ''}${body}</div>`;
const kpi = (label, value, note = '') => `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
const chartBox = (id, tall) => `<div class="chart-box${tall ? ' tall' : ''}"><canvas id="${id}"></canvas></div>`;
const legend = (items) => `<div class="legend">${items.map(([c, l, box]) => `<span><i class="${box ? 'box' : ''}" style="background:${c}"></i>${l}</span>`).join('')}</div>`;

function baseOpts(extra = {}) {
  const grid = css('--border'), ink = css('--text-2');
  return {
    responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: css('--surface'), titleColor: css('--text'), bodyColor: css('--text-2'), borderColor: grid, borderWidth: 1, padding: 10 } },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink, maxTicksLimit: 8, maxRotation: 0 }, border: { color: grid } },
      y: { grid: { color: grid }, ticks: { color: ink }, border: { display: false } },
    },
    elements: { point: { radius: 0, hoverRadius: 4 }, line: { borderWidth: 2, tension: 0 }, bar: { borderRadius: 3 } },
    ...extra,
  };
}
function mk(id, config) {
  const el = document.getElementById(id);
  if (!el) return;
  charts.push(new Chart(el, config));
}
const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k]) merge(a[k], b[k]); else a[k] = b[k]; } return a; };

// ===================================================================== SUMMARY
export function renderSummary(el, ctx) {
  const { risk, perf, attr, model } = ctx;
  const h99 = risk && !risk.error ? risk.table.find((r) => r.conf === risk.aMax && r.horizon === 1) : null;
  let html = '<div class="kpis">';
  if (risk && !risk.error) html += kpi('Net asset value', fmt.php(risk.totalNAV), `as of ${risk.valuationDate}`);
  if (h99) html += kpi(`1-day VaR ${(risk.aMax * 100).toFixed(0)}% (historical)`, fmt.php(h99.histVar), `${fmt.pct(h99.histVar / risk.totalNAV)} of NAV · ES ${fmt.php(h99.histEs)}`);
  if (perf) {
    html += kpi('Time-weighted return', fmt.pct(perf.twr), `${perf.start} → ${perf.end}`);
    html += kpi('Benchmark return', fmt.pct(perf.bench), esc(model.config.benchmarkName));
    html += kpi('Active return', `<span class="${sign(perf.active) === 'neg' ? 'neg' : ''}">${fmt.pct(perf.active)}</span>`, `IR ${fmt.num(perf.stats.ir)} · TE ${fmt.pct(perf.stats.te)}`);
    html += kpi('Money-weighted (XIRR)', fmt.pct(perf.irr), 'annualised');
  }
  html += '</div>';
  html += '<div class="grid2">';
  if (perf) html += panel('Growth of ₱100', legend([[css('--series-1'), 'Portfolio'], [css('--series-2'), 'Benchmark']]) + chartBox('cSumGrowth'));
  if (risk && !risk.error) html += panel(`Where the risk sits — component VaR by sector (${(risk.aMax * 100).toFixed(0)}%, 1-day)`, chartBox('cSumSector'), 'Parametric Euler decomposition; components add up to total VaR.');
  html += '</div>';
  if (attr && !attr.skipped) {
    html += '<div class="grid1">' + panel('Active return explained (Brinson-Fachler, Carino-linked)',
      `<div class="kpis">${kpi('Allocation', fmt.pct(attr.totals.alloc))}${kpi('Selection', fmt.pct(attr.totals.sel))}${kpi('Interaction', fmt.pct(attr.totals.inter))}${kpi('Active vs constituent benchmark', fmt.pct(attr.active))}</div>`) + '</div>';
  }
  el.innerHTML = html;

  if (perf) mk('cSumGrowth', growthChart(perf));
  if (risk && !risk.error) {
    const s = risk.bySector;
    mk('cSumSector', { type: 'bar', data: { labels: s.map((x) => x.sector), datasets: [{ data: s.map((x) => x.component), backgroundColor: css('--series-1'), barPercentage: 0.7 }] },
      options: merge(baseOpts({ indexAxis: 'y' }), { interaction: { mode: 'nearest', intersect: true, axis: 'y' }, plugins: { tooltip: { callbacks: { label: (c) => `${fmt.php(c.raw)} (${fmt.pct(s[c.dataIndex].componentPct, 1)} of VaR)` } } }, scales: { x: { grid: { display: true, color: css('--border') }, ticks: { callback: (v) => fmt.php(v) } }, y: { grid: { display: false } } } }) });
  }
}

function growthChart(perf) {
  const d = perf.chart;
  return { type: 'line', data: { labels: d.dates, datasets: [
    { label: 'Portfolio', data: d.gP, borderColor: css('--series-1') },
    { label: 'Benchmark', data: d.gB, borderColor: css('--series-2') },
  ] }, options: merge(baseOpts(), { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.raw.toFixed(2)}` } } } }) };
}

// ===================================================================== RISK
export function renderRisk(el, ctx) {
  const r = ctx.risk; const cfg = ctx.model.config;
  if (!r || r.error) { el.innerHTML = `<div class="msg err">${esc(r ? r.error : 'Risk not computed')}</div>`; return; }
  const a = r.aMax, conf = (x) => (x * 100).toFixed(x * 100 % 1 ? 1 : 0) + '%';
  const one = (c) => r.table.find((x) => x.conf === c && x.horizon === 1);
  let html = '<div class="kpis">';
  html += kpi('Securities value', fmt.php(r.netMV), `${r.positions.length} positions · cash ${fmt.php(r.cash)}`);
  for (const c of cfg.confidence) { const t = one(c); html += kpi(`1-day VaR ${conf(c)}`, fmt.php(t.histVar), `historical · ${fmt.pct(t.histVar / r.totalNAV)} of NAV`); }
  html += kpi(`1-day ES ${conf(a)}`, fmt.php(one(a).histEs), 'average loss beyond VaR');
  html += kpi('Diversification benefit', fmt.php(r.diversification.benefit), `${fmt.pct(r.diversification.benefit / r.diversification.sumStandalone, 1)} of undiversified VaR`);
  html += '</div>';

  html += '<div class="grid1">' + panel('VaR and Expected Shortfall by method',
    table([
      { h: 'Confidence', l: true, f: (x) => conf(x.conf) }, { h: 'Horizon', l: true, f: (x) => `${x.horizon}-day` },
      { h: 'Historical VaR', f: (x) => fmt.php(x.histVar) }, { h: 'Historical ES', f: (x) => fmt.php(x.histEs) },
      { h: 'Parametric VaR', f: (x) => fmt.php(x.paraVar) }, { h: 'Parametric ES', f: (x) => fmt.php(x.paraEs) },
      { h: 'Monte Carlo VaR', f: (x) => fmt.php(x.mcVar) }, { h: 'Monte Carlo ES', f: (x) => fmt.php(x.mcEs) },
      { h: 'Hist. VaR % NAV', f: (x) => fmt.pct(x.histVar / r.totalNAV) },
    ], r.table),
    `Lookback ${r.lookbackUsed} trading days to ${r.valuationDate}. Covariance: ${r.covMethod}. Monte Carlo: ${cfg.mcSims.toLocaleString()} correlated normal draws (seeded). Multi-day figures use √T scaling of 1-day VaR.`) + '</div>';

  html += '<div class="grid2">';
  html += panel('Distribution of 1-day P&L (historical scenarios)', legend([[css('--series-1'), 'Scenario P&L', true], [css('--neg-fill'), `Beyond ${conf(a)} VaR`, true]]) + chartBox('cHist'),
    `Today's positions revalued with each of the last ${r.lookbackUsed} days' returns.`);
  if (r.backtest.series.length) {
    html += panel(`Backtest — ${conf(a)} VaR vs hypothetical P&L`, legend([[css('--series-1'), 'Daily P&L', true], [css('--neg-fill'), `−VaR ${conf(a)}`]]) + chartBox('cBack') +
      table([
        { h: 'Confidence', l: true, f: (x) => conf(x.conf) }, { h: 'Exceptions', f: (x) => x.exceptions }, { h: 'Expected', f: (x) => x.expected.toFixed(1) },
        { h: 'Kupiec LR', f: (x) => x.lr.toFixed(2) }, { h: 'p-value', f: (x) => x.pValue.toFixed(3) }, { h: 'Zone', f: (x) => `<span class="status ${x.zone}">${x.zone}</span>` },
      ], r.backtest.byConf), `${r.backtest.days} days; today's positions held constant (hypothetical P&L). p-value < 0.05 means the exception count is inconsistent with the confidence level.`);
  } else html += panel('Backtest', '<p class="muted">Not enough history for a backtest.</p>');
  html += '</div>';

  html += '<div class="grid2">';
  html += panel(`Component VaR by sector (${conf(a)}, 1-day)`, chartBox('cSector') + table([
    { h: 'Sector', l: true, f: (x) => esc(x.sector) }, { h: 'Weight', f: (x) => fmt.pct(x.weight, 1) },
    { h: 'Sector VaR', f: (x) => fmt.php(x.sectorVar) }, { h: 'Component VaR', f: (x) => fmt.php(x.component) }, { h: '% of VaR', f: (x) => fmt.pct(x.componentPct, 1) },
  ], r.bySector));
  html += panel('Stress tests', table([
    { h: 'Scenario', l: true, wrap: true, f: (x) => `<b>${esc(x.name)}</b><br><span class="muted">${esc(x.type)} · ${esc(x.detail)}</span>` },
    { h: 'P&L', f: (x) => fmt.php(x.pnl), v: (x) => x.pnl, signed: true }, { h: '% NAV', f: (x) => fmt.pct(x.pct), v: (x) => x.pct, signed: true },
  ], r.stress), 'Historical replays apply each stock\'s actual return over the window; stocks not yet listed then use the index move.');
  html += '</div>';

  html += '<div class="grid1">' + panel(`Risk contribution by position (${conf(a)}, 1-day)`, table([
    { h: 'Ticker', l: true, f: (x) => `<b>${esc(x.ticker)}</b>` }, { h: 'Name', l: true, wrap: true, f: (x) => esc(x.name) }, { h: 'Sector', l: true, f: (x) => esc(x.sector) },
    { h: 'Market value', f: (x) => fmt.php(x.mv) }, { h: 'Weight', f: (x) => fmt.pct(x.weight, 1) }, { h: 'Ann. vol', f: (x) => fmt.pct(x.annVol, 1) },
    { h: 'Standalone VaR', f: (x) => fmt.php(x.standalone) }, { h: 'Marginal VaR', f: (x) => fmt.num(x.marginal, 4), },
    { h: 'Component VaR', f: (x) => fmt.php(x.component) }, { h: '% of VaR', f: (x) => fmt.pct(x.componentPct, 1) },
    { h: 'Incremental VaR (hist.)', f: (x) => fmt.php(x.incremental) }, { h: 'ES contribution (hist.)', f: (x) => fmt.php(x.histEsContrib) },
  ], r.contrib, { ticker: 'Total', name: '', sector: '', mv: r.netMV, weight: r.netMV / r.totalNAV, annVol: null, standalone: r.diversification.sumStandalone, marginal: null, component: r.diversification.portfolioVar, componentPct: 1, incremental: null, histEsContrib: r.contrib.reduce((s, x) => s + x.histEsContrib, 0) }),
  'Marginal VaR = change in VaR per ₱1 added. Component VaR = marginal × position (sums to parametric VaR). Incremental VaR = historical VaR with the position minus VaR without it.') + '</div>';

  html += '<div class="grid1">' + panel('Correlation matrix (daily log returns)', heatmap(r.corr), `${r.covMethod} correlations over the lookback window.`) + '</div>';
  html += '<div class="grid1">' + panel('Methodology', `<ul class="notes">
    <li><b>Historical simulation</b>: P&L = Σ MVᵢ·(e^{rᵢ,ₛ} − 1) for each past day s, using dividend-adjusted Yahoo closes; VaR is the loss at the (1 − confidence) percentile, ES the average loss beyond it.</li>
    <li><b>Parametric</b>: VaR = z·√(MVᵀΣMV); ES = σ·φ(z)/(1 − α). Mean return assumed zero.</li>
    <li><b>Monte Carlo</b>: Cholesky factor of Σ applied to independent normals; positions fully revalued.</li>
    <li>Missing returns (recent listings, suspensions) are filled with the benchmark index return; affected positions are flagged in Data Quality.</li>
    <li>Cash is treated as riskless. PHP base currency; no FX risk is modelled.</li></ul>`) + '</div>';
  el.innerHTML = html;

  // histogram
  const neg = css('--neg-fill'), s1 = css('--series-1');
  mk('cHist', { type: 'bar', data: { labels: r.hist.map((b) => fmt.php((b.x0 + b.x1) / 2)), datasets: [{ data: r.hist.map((b) => b.n), backgroundColor: r.hist.map((b) => (b.x1 <= r.histVarLine ? neg : s1)), barPercentage: 1, categoryPercentage: 0.92 }] },
    options: merge(baseOpts(), { interaction: { mode: 'nearest', intersect: true, axis: 'x' }, plugins: { tooltip: { callbacks: { title: (c) => `${fmt.php(r.hist[c[0].dataIndex].x0)} to ${fmt.php(r.hist[c[0].dataIndex].x1)}`, label: (c) => `${c.raw} days` } } }, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { title: { display: true, text: 'days', color: css('--muted') } } } }) });
  if (r.backtest.series.length) {
    const b = r.backtest.series;
    mk('cBack', { data: { labels: b.map((x) => x.date), datasets: [
      { type: 'line', label: `−VaR`, data: b.map((x) => x.var), borderColor: neg, borderWidth: 2, order: 0 },
      { type: 'bar', label: 'P&L', data: b.map((x) => x.pnl), backgroundColor: b.map((x) => (x.pnl < x.var ? neg : s1)), barPercentage: 1, categoryPercentage: 0.9, order: 1 },
    ] }, options: merge(baseOpts(), { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt.php(c.raw)}` } } }, scales: { y: { ticks: { callback: (v) => fmt.php(v) } } } }) });
  }
  mk('cSector', { type: 'bar', data: { labels: r.bySector.map((x) => x.sector), datasets: [
    { label: 'Component VaR', data: r.bySector.map((x) => x.component), backgroundColor: s1 },
  ] }, options: merge(baseOpts({ indexAxis: 'y' }), { interaction: { mode: 'nearest', intersect: true, axis: 'y' }, plugins: { tooltip: { callbacks: { label: (c) => fmt.php(c.raw) } } }, scales: { x: { grid: { display: true, color: css('--border') }, ticks: { callback: (v) => fmt.php(v) } }, y: { grid: { display: false } } } }) });
}

function heatmap({ tickers, m }) {
  // diverging blue (+1) – neutral – red (−1)
  const pos = [0xcd, 0xe2, 0xfb, 0x1c, 0x5c, 0xab], negc = [0xfb, 0xd5, 0xd4, 0xb0, 0x26, 0x26];
  const mid = [0xf0, 0xef, 0xec];
  const col = (v) => {
    const t = Math.min(1, Math.abs(v)); const c = v >= 0 ? pos : negc;
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    const [r, g, b] = t < 0.15 ? mid : [lerp(c[0], c[3]), lerp(c[1], c[4]), lerp(c[2], c[5])];
    const ink = t > 0.55 ? '#fff' : '#0b0b0b';
    return `background:rgb(${r},${g},${b});color:${ink}`;
  };
  let h = '<div class="tbl-wrap"><table class="heat"><thead><tr><th></th>' + tickers.map((t) => `<th>${esc(t)}</th>`).join('') + '</tr></thead><tbody>';
  m.forEach((row, i) => { h += `<tr><th>${esc(tickers[i])}</th>` + row.map((v, j) => `<td style="${col(v)}" title="${esc(tickers[i])} / ${esc(tickers[j])}: ${v.toFixed(3)}">${i === j ? '1' : v.toFixed(2)}</td>`).join('') + '</tr>'; });
  return h + '</tbody></table></div>';
}

// ===================================================================== PERFORMANCE
export function renderPerformance(el, ctx) {
  const p = ctx.perf; if (!p) { el.innerHTML = '<div class="msg err">Performance not computed.</div>'; return; }
  const s = p.stats;
  let html = '<div class="kpis">';
  html += kpi('Time-weighted return (net)', fmt.pct(p.twr), p.annTwr != null ? `annualised ${fmt.pct(p.annTwr)}` : `${p.start} → ${p.end}`);
  if (p.fees > 0) html += kpi('TWR gross of fees', fmt.pct(p.twrGross), `fees ${fmt.php(p.fees)}`);
  html += kpi('Benchmark', fmt.pct(p.bench), esc(p.benchmarkLabel));
  html += kpi('Active return', fmt.pct(p.active), `${fmt.bp(p.active)}`);
  html += kpi('Money-weighted (XIRR)', fmt.pct(p.irr), `annualised · period ${fmt.pct(p.mwrPeriod)}`);
  html += kpi('Investment gain', fmt.php(p.gain), `NAV ${fmt.php(p.startValue)} → ${fmt.php(p.endValue)}`);
  html += '</div>';

  html += '<div class="grid2">';
  html += panel('Growth of ₱100', legend([[css('--series-1'), 'Portfolio'], [css('--series-2'), 'Benchmark']]) + chartBox('cGrowth'));
  html += panel('Drawdown from peak', legend([[css('--series-1'), 'Portfolio'], [css('--series-2'), 'Benchmark']]) + chartBox('cDD'));
  html += '</div><div class="grid2">';
  html += panel('Returns by period', table([
    { h: 'Period', l: true, f: (x) => x.label }, { h: 'From', l: true, f: (x) => x.from },
    { h: 'Portfolio', f: (x) => fmt.pct(x.port), v: (x) => x.port, signed: true }, { h: 'Benchmark', f: (x) => fmt.pct(x.bench), v: (x) => x.bench, signed: true },
    { h: 'Active', f: (x) => fmt.pct(x.active), v: (x) => x.active, signed: true },
  ], p.periods), 'Cumulative (not annualised) time-weighted returns ending ' + p.end + '.');
  const st = [
    [p.nDays >= 365 ? 'Annualised return' : 'Return (not annualised)', fmt.pct(s.annP), fmt.pct(s.annB)], ['Annualised volatility', fmt.pct(s.volP), fmt.pct(s.volB)],
    ['Sharpe ratio', fmt.num(s.sharpeP), fmt.num(s.sharpeB)], ['Sortino ratio', fmt.num(s.sortinoP), fmt.num(s.sortinoB)],
    ['Maximum drawdown', fmt.pct(s.maxDDP), fmt.pct(s.maxDDB)], ['Calmar ratio', fmt.num(s.calmarP), fmt.num(s.calmarB)],
    ['Beta', fmt.num(s.beta), '1.00'], ["Jensen's alpha (ann.)", fmt.pct(s.alpha), '–'],
    ['Tracking error', fmt.pct(s.te), '–'], ['Information ratio', fmt.num(s.ir), '–'],
    ['Up-capture', fmt.pct(s.upCapture, 0), '–'], ['Down-capture', fmt.pct(s.downCapture, 0), '–'],
    ['Monthly hit rate', fmt.pct(s.hitRate, 0), '–'], ['Best / worst day', `${fmt.pct(s.bestDay)} / ${fmt.pct(s.worstDay)}`, '–'],
  ];
  html += panel('Risk-adjusted statistics', table([{ h: 'Measure', l: true, f: (x) => x[0] }, { h: 'Portfolio', f: (x) => x[1] }, { h: 'Benchmark', f: (x) => x[2] }], st),
    `Risk-free rate ${fmt.pct(ctx.model.config.riskFreeRate)} p.a. Max drawdown ${s.ddDetail.peak} → ${s.ddDetail.trough}${s.ddDetail.recovery ? `, recovered ${s.ddDetail.recovery}` : ', not yet recovered'}.`);
  html += '</div>';

  html += '<div class="grid2">';
  html += panel('Monthly returns', table([
    { h: 'Month', l: true, f: (x) => x.key }, { h: 'Portfolio', f: (x) => fmt.pct(x.port), v: (x) => x.port, signed: true },
    { h: 'Benchmark', f: (x) => fmt.pct(x.bench), v: (x) => x.bench, signed: true }, { h: 'Active', f: (x) => fmt.pct(x.active), v: (x) => x.active, signed: true },
  ], p.months));
  html += panel('Rolling 3-month volatility (annualised)', legend([[css('--series-1'), 'Portfolio'], [css('--series-2'), 'Benchmark']]) + chartBox('cRoll'));
  html += '</div>';

  const top = p.contrib.filter((c) => c.ticker !== 'CASH');
  const tb = [...top.slice(0, 10), ...top.slice(-10)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b.contribution - a.contribution);
  html += '<div class="grid2">';
  html += panel('Top and bottom contributors', chartBox('cContrib', true), 'Contribution to total return, Carino-linked so all contributions sum to the TWR.');
  html += panel('Contribution by sector', table([
    { h: 'Sector', l: true, f: (x) => esc(x.sector) }, { h: 'Avg weight', f: (x) => fmt.pct(x.avgWeight, 1) },
    { h: 'P&L', f: (x) => fmt.php(x.pnl), v: (x) => x.pnl, signed: true }, { h: 'Contribution', f: (x) => fmt.pct(x.contribution), v: (x) => x.contribution, signed: true },
  ], p.bySector, { sector: 'Total', avgWeight: p.bySector.reduce((a, x) => a + x.avgWeight, 0), pnl: p.gain, contribution: p.bySector.reduce((a, x) => a + x.contribution, 0) }),
  `Dividends received ${fmt.php(p.dividends)} · fees ${fmt.php(p.fees)} · net client flows ${fmt.php(p.netFlows)}.`);
  html += '</div>';
  html += '<div class="grid1">' + panel('Contribution by security', table([
    { h: 'Ticker', l: true, f: (x) => `<b>${esc(x.ticker)}</b>` }, { h: 'Name', l: true, wrap: true, f: (x) => esc(x.name) }, { h: 'Sector', l: true, f: (x) => esc(x.sector) },
    { h: 'Avg weight', f: (x) => fmt.pct(x.avgWeight, 1) }, { h: 'End weight', f: (x) => fmt.pct(x.endWeight, 1) },
    { h: 'Holding return', f: (x) => fmt.pct(x.ret), v: (x) => x.ret, signed: true }, { h: 'P&L', f: (x) => fmt.php(x.pnl), v: (x) => x.pnl, signed: true },
    { h: 'Contribution', f: (x) => fmt.pct(x.contribution), v: (x) => x.contribution, signed: true },
  ], p.contrib, { ticker: 'Total', name: '', sector: '', avgWeight: 1, endWeight: 1, ret: p.twr, pnl: p.gain, contribution: p.contrib.reduce((a, x) => a + x.contribution, 0) }),
  'Holding return is time-weighted over the days the stock was held, including dividends and trading at prices different from the close.') + '</div>';
  html += '<div class="grid1">' + panel('Methodology', `<ul class="notes">
    <li>Daily valuation: quantity × Yahoo close (unadjusted for dividends) + cash. Dividends are credited as cash on the ex-date${ctx.model.config.autoDividends ? ' (taken from Yahoo when the PMS file has no DIVIDEND rows for that stock)' : ''}.</li>
    <li>TWR: r<sub>t</sub> = (V<sub>t</sub> − V<sub>t−1</sub> − CF<sub>t</sub>) / V<sub>t−1</sub>, client flows assumed at end of day, chain-linked daily.</li>
    <li>Money-weighted return: XIRR of opening NAV, client flows and closing NAV.</li>
    <li>Benchmark: ${esc(p.benchmarkLabel)} from Yahoo (${esc(ctx.model.config.benchmarkSymbol)}). The PSEi is a price index, so a dividend-receiving portfolio has a small structural edge over it.</li></ul>`) + '</div>';
  el.innerHTML = html;

  mk('cGrowth', growthChart(p));
  const d = p.chart;
  mk('cDD', { type: 'line', data: { labels: d.dates, datasets: [
    { label: 'Portfolio', data: d.ddP, borderColor: css('--series-1') }, { label: 'Benchmark', data: d.ddB, borderColor: css('--series-2') },
  ] }, options: merge(baseOpts(), { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt.pct(c.raw)}` } } }, scales: { y: { ticks: { callback: (v) => fmt.pct(v, 0) } } } }) });
  mk('cRoll', { type: 'line', data: { labels: d.rolling.map((x) => x.date), datasets: [
    { label: 'Portfolio', data: d.rolling.map((x) => x.port), borderColor: css('--series-1') }, { label: 'Benchmark', data: d.rolling.map((x) => x.bench), borderColor: css('--series-2') },
  ] }, options: merge(baseOpts(), { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt.pct(c.raw, 1)}` } } }, scales: { y: { ticks: { callback: (v) => fmt.pct(v, 0) } } } }) });
  mk('cContrib', { type: 'bar', data: { labels: tb.map((x) => x.ticker), datasets: [{ data: tb.map((x) => x.contribution), backgroundColor: tb.map((x) => (x.contribution >= 0 ? css('--series-1') : css('--neg-fill'))) }] },
    options: merge(baseOpts({ indexAxis: 'y' }), { interaction: { mode: 'nearest', intersect: true, axis: 'y' }, plugins: { tooltip: { callbacks: { label: (c) => `${tb[c.dataIndex].name}: ${fmt.pct(c.raw)}` } } }, scales: { x: { grid: { display: true, color: css('--border') }, ticks: { callback: (v) => fmt.pct(v, 1) } }, y: { grid: { display: false }, ticks: { autoSkip: false } } } }) });
}

// ===================================================================== ATTRIBUTION
export function renderAttribution(el, ctx) {
  const a = ctx.attr;
  if (!a || a.skipped) { el.innerHTML = `<div class="msg warn">${esc(a ? a.skipped : 'Attribution not computed.')}</div>`; return; }
  let html = '<div class="kpis">';
  html += kpi('Portfolio return', fmt.pct(a.portReturn));
  html += kpi('Benchmark (constituents)', fmt.pct(a.benchReturn), a.officialBench != null ? `official index ${fmt.pct(a.officialBench)}` : '');
  html += kpi('Active return', fmt.pct(a.active));
  html += kpi('Allocation effect', fmt.pct(a.totals.alloc), 'sector over/underweights');
  html += kpi('Selection effect', fmt.pct(a.totals.sel), 'stock picking within sectors');
  html += kpi('Interaction effect', fmt.pct(a.totals.inter));
  html += '</div>';
  html += '<div class="grid2">';
  html += panel('From benchmark to portfolio return', chartBox('cWater'), 'Each bar adds one effect to the benchmark return.');
  html += panel('Effects by sector', legend([[css('--series-1'), 'Allocation', true], [css('--series-2'), 'Selection', true], [css('--series-3'), 'Interaction', true]]) + chartBox('cEff'));
  html += '</div>';
  html += '<div class="grid1">' + panel('Sector attribution (Brinson-Fachler)', table([
    { h: 'Sector', l: true, f: (x) => esc(x.sector) },
    { h: 'Port. weight', f: (x) => fmt.pct(x.wp, 1) }, { h: 'Bench. weight', f: (x) => fmt.pct(x.wb, 1) }, { h: 'Active weight', f: (x) => fmt.pct(x.wp - x.wb, 1), v: (x) => x.wp - x.wb, signed: true },
    { h: 'Port. return', f: (x) => fmt.pct(x.rp) }, { h: 'Bench. return', f: (x) => fmt.pct(x.rb) },
    { h: 'Allocation', f: (x) => fmt.pct(x.alloc), v: (x) => x.alloc, signed: true }, { h: 'Selection', f: (x) => fmt.pct(x.sel), v: (x) => x.sel, signed: true },
    { h: 'Interaction', f: (x) => fmt.pct(x.inter), v: (x) => x.inter, signed: true }, { h: 'Total', f: (x) => fmt.pct(x.total), v: (x) => x.total, signed: true },
  ], a.rows, { sector: 'Total', wp: 1, wb: 1, rp: a.portReturn, rb: a.benchReturn, alloc: a.totals.alloc, sel: a.totals.sel, inter: a.totals.inter, total: a.totals.alloc + a.totals.sel + a.totals.inter }),
  'Weights are period averages; returns are chain-linked daily. Cash is its own segment with zero benchmark weight and is benchmarked at 0%, so the cash cushion or drag appears as allocation; fees and interest appear as selection.') + '</div>';
  html += '<div class="grid2">';
  html += panel('Monthly attribution', table([
    { h: 'Month', l: true, f: (x) => x.month }, { h: 'Portfolio', f: (x) => fmt.pct(x.port) }, { h: 'Benchmark', f: (x) => fmt.pct(x.bench) },
    { h: 'Allocation', f: (x) => fmt.pct(x.alloc), v: (x) => x.alloc, signed: true }, { h: 'Selection', f: (x) => fmt.pct(x.sel), v: (x) => x.sel, signed: true },
    { h: 'Interaction', f: (x) => fmt.pct(x.inter), v: (x) => x.inter, signed: true },
  ], a.monthly));
  html += panel('Reconciliation and notes', `<table>
      <tr><td class="l">Portfolio TWR</td><td>${fmt.pct(a.portReturn, 4)}</td></tr>
      <tr><td class="l">Constituent-built benchmark</td><td>${fmt.pct(a.benchReturn, 4)}</td></tr>
      <tr><td class="l">Active return</td><td>${fmt.pct(a.active, 4)}</td></tr>
      <tr><td class="l">Allocation + selection + interaction</td><td>${fmt.pct(a.totals.alloc + a.totals.sel + a.totals.inter, 4)}</td></tr>
      <tr><td class="l">Residual (should be ≈ 0)</td><td>${fmt.bp(a.residual)}</td></tr>
      ${a.officialBench != null ? `<tr><td class="l">Official index return (Yahoo)</td><td>${fmt.pct(a.officialBench, 4)}</td></tr><tr><td class="l">Constituent vs official gap</td><td>${fmt.bp(a.benchReturn - a.officialBench)}</td></tr>` : ''}
    </table>
    <ul class="notes" style="margin-top:12px">
      <li>Benchmark members are held buy-and-hold from the weights in Benchmark_Constituents at period start; mid-period index rebalances and free-float changes are not replayed, which explains most of the gap to the official index.</li>
      <li>Daily Brinson-Fachler effects are linked with Carino's logarithmic coefficients so they add up exactly to the active return.</li>
      <li>Sectors in Holdings and Benchmark_Constituents are matched by name; keep the PSE sector labels consistent.</li>
    </ul>`);
  html += '</div>';
  el.innerHTML = html;

  const steps = [['Benchmark', a.benchReturn, true], ['Allocation', a.totals.alloc], ['Selection', a.totals.sel], ['Interaction', a.totals.inter], ['Portfolio', a.portReturn, true]];
  let run = 0; const bars = [], colors = [];
  for (const [l, v, isTotal] of steps) {
    if (isTotal) { bars.push([0, v]); colors.push(l === 'Benchmark' ? css('--series-2') : css('--series-1')); run = v; }
    else { bars.push([run, run + v]); colors.push(v >= 0 ? css('--series-3') : css('--neg-fill')); run += v; }
  }
  mk('cWater', { type: 'bar', data: { labels: steps.map((s) => s[0]), datasets: [{ data: bars, backgroundColor: colors, barPercentage: 0.6, borderRadius: 3, borderSkipped: false }] },
    options: merge(baseOpts(), { interaction: { mode: 'nearest', intersect: true }, plugins: { tooltip: { callbacks: { label: (c) => { const s = steps[c.dataIndex]; return `${s[0]}: ${fmt.pct(s[1])}`; } } } }, scales: { y: { ticks: { callback: (v) => fmt.pct(v, 1) } } } }) });
  const rows = a.rows;
  mk('cEff', { type: 'bar', data: { labels: rows.map((x) => x.sector), datasets: [
    { label: 'Allocation', data: rows.map((x) => x.alloc), backgroundColor: css('--series-1') },
    { label: 'Selection', data: rows.map((x) => x.sel), backgroundColor: css('--series-2') },
    { label: 'Interaction', data: rows.map((x) => x.inter), backgroundColor: css('--series-3') },
  ] }, options: merge(baseOpts(), { plugins: { tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${fmt.pct(c.raw)}` } } }, scales: { x: { ticks: { autoSkip: false } }, y: { ticks: { callback: (v) => fmt.pct(v, 1) } } } }) });
}

// ===================================================================== DATA QUALITY
export function renderDQ(el, ctx) {
  const { msgs, dq, book } = ctx;
  let html = '';
  html += panel('Messages', (msgs.errors.map((m) => `<div class="msg err">${esc(m)}</div>`).join('') + msgs.warnings.map((m) => `<div class="msg warn">${esc(m)}</div>`).join('')) || '<p class="muted">No issues found.</p>',
    book && book.openingMode ? esc(book.openingMode) : '');
  html += '<div class="grid1" style="margin-top:16px">' + panel('Price coverage (Yahoo Finance)', table([
    { h: 'Ticker', l: true, f: (x) => `<b>${esc(x.ticker)}</b>` }, { h: 'Yahoo symbol', l: true, f: (x) => esc(x.yahoo) }, { h: 'Used in', l: true, f: (x) => esc(x.role) },
    { h: 'Status', l: true, f: (x) => `<span class="status ${x.status.replace(' ', '')}">${x.status}</span>` },
    { h: 'Days in VaR window', f: (x) => (x.window ? `${x.obs} / ${x.window}` : '0') }, { h: 'First date', l: true, f: (x) => x.first || '–' }, { h: 'Last date', l: true, f: (x) => x.last || '–' },
    { h: 'Last price', f: (x) => fmt.num(x.lastPx) }, { h: 'Note', l: true, wrap: true, f: (x) => esc(x.note) },
  ], dq)) + '</div>';
  if (book && book.recon && book.recon.length) html += '<div class="grid1">' + panel('Position reconciliation vs closing PMS snapshot', table([
    { h: 'Ticker', l: true, f: (x) => esc(x.ticker) }, { h: 'Rolled forward', f: (x) => fmt.qty(x.book) }, { h: 'PMS snapshot', f: (x) => fmt.qty(x.pms) }, { h: 'Difference', f: (x) => fmt.qty(x.diff) },
  ], book.recon)) + '</div>';
  if (book && book.priceCheck && book.priceCheck.length) html += '<div class="grid1">' + panel('PMS price vs Yahoo close (> 1% difference)', table([
    { h: 'Ticker', l: true, f: (x) => esc(x.ticker) }, { h: 'PMS price', f: (x) => fmt.num(x.pms, 4) }, { h: 'Yahoo close', f: (x) => fmt.num(x.yahoo, 4) }, { h: 'Difference', f: (x) => fmt.pct(x.diff) },
  ], book.priceCheck)) + '</div>';
  if (book && book.txLog && book.txLog.length) html += '<div class="grid2">' + panel('Trades applied', table([
    { h: 'Date', l: true, f: (x) => x.date }, { h: 'Ticker', l: true, f: (x) => esc(x.ticker) }, { h: 'Type', l: true, f: (x) => x.type },
    { h: 'Quantity', f: (x) => fmt.qty(x.qty) }, { h: 'Price', f: (x) => fmt.num(x.priceUsed, 4) }, { h: 'Price source', l: true, f: (x) => x.priceSource }, { h: 'Cash', f: (x) => fmt.php(x.cash), v: (x) => x.cash, signed: true },
  ], book.txLog), 'Trades with a blank price are valued at that day\'s Yahoo close.') +
    panel('Dividends credited from Yahoo', book.autoDivs.length ? table([
      { h: 'Ex-date', l: true, f: (x) => x.date }, { h: 'Ticker', l: true, f: (x) => esc(x.ticker) }, { h: 'Per share', f: (x) => fmt.num(x.dps, 4) }, { h: 'Shares', f: (x) => fmt.qty(x.qty) }, { h: 'Amount', f: (x) => fmt.php(x.amount) },
    ], book.autoDivs) : '<p class="muted">None (PMS dividend rows used, or auto-dividends switched off).</p>') + '</div>';
  el.innerHTML = html;
}

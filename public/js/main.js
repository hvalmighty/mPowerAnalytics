import { parseWorkbook } from './parser.js';
import { fetchPrices, buildPanel, buildBook, dataQuality } from './data.js';
import { computeRisk } from './risk.js';
import { computePerformance } from './performance.js';
import { computeAttribution } from './attribution.js';
import { renderSummary, renderRisk, renderPerformance, renderAttribution, renderDQ, renderHoldings, destroyCharts } from './report.js';
import { isPositionReport, parsePositionReport, buildModelFromPortfolio } from './pms.js';

const $ = (id) => document.getElementById(id);
// PSE_HOSTED is set by the single-file build (tools/build_hosted.mjs): no server,
// prices generated in the browser, files saved through the host's download prompt.
const HOSTED = !!window.PSE_HOSTED;
const log = $('log');
let workbook = null, fileName = '', ctx = null, serverMode = 'live', isSample = false;
const priceWb = null; // prices are built in; a price-file upload may return later

// Built-in prices (public/data/market_prices.json)
let builtin = null, builtinInfo = null, builtinRaw = null;
let pms = null; // parsed mPower position report (portfolio dropdown)
const builtinReady = HOSTED ? Promise.resolve() : fetch('/data/market_prices.json').then((r) => (r.ok ? r.json() : null)).then((j) => {
  if (!j || !j.dates) return;
  const rows = [];
  for (const [t, arr] of Object.entries(j.series)) arr.forEach((p, i) => { if (p > 0) rows.push({ date: j.dates[i], ticker: t, close: p, adj: null }); });
  builtinRaw = j; builtin = rows; builtinInfo = { n: Object.keys(j.series).length, from: j.from, to: j.to, source: j.source };
}).catch(() => {});
const fmtD = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function say(text, cls = '') { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; log.appendChild(li); return li; }

// data-source badge
// Demo mode only (local testing with `npm run demo`), never on the live site.
function demoBadge() {
  const b = $('modeBadge'); b.textContent = 'Demo prices'; b.className = 'badge demo';
  $('demoBanner').textContent = 'Demo mode: prices are generated for testing. Restart the server without demo mode for real prices.'; $('demoBanner').hidden = false;
}
let statusReady;
if (HOSTED) {
  demoBadge(); $('btnPrint').hidden = true;
  $('demoBanner').textContent = 'Test version: prices are synthetic and generated in your browser. They are not Yahoo Finance or PSE data, so the figures mean nothing. Real prices need the full app running on a server.';
    statusReady = Promise.resolve();
} else statusReady = fetch('/api/status').then((r) => r.json()).then(async (s) => {
  const b = $('modeBadge');
  serverMode = s.mode;
  if (s.mode === 'demo') return demoBadge();
  await builtinReady;
  if (builtinInfo) { b.textContent = `Prices to ${fmtD(builtinInfo.to)}`; b.className = 'badge live'; b.title = `Built-in prices for ${builtinInfo.n} PSE securities, ${fmtD(builtinInfo.from)} – ${fmtD(builtinInfo.to)}. PSEi index from Yahoo Finance.`; }
  else { b.textContent = 'Prices unavailable'; b.className = 'badge warnb'; }
}).catch(() => { $('modeBadge').textContent = 'Price server offline'; });

// ---- sample portfolio, shown until a portfolio is uploaded
const demoish = () => HOSTED || serverMode === 'demo';
const sampleName = () => (demoish() ? 'PSE_Portfolio_Sample.xlsx' : 'Portfolio_Sample_mPower.xlsx');
async function sampleBytes() {
  if (HOSTED) return Uint8Array.from(atob(window.PSE_SAMPLE_B64), (c) => c.charCodeAt(0)).buffer;
  const r = await fetch('/sample/' + sampleName());
  if (!r.ok) throw new Error('sample not found');
  return r.arrayBuffer();
}
// ---- default portfolio file (public/data/Portfolio_upload.xlsx), loaded as soon as the page opens
const DEFAULT_PORTFOLIO = 'Portfolio_upload.xlsx';
if (!HOSTED) (async () => {
  $('emptyState').hidden = true;
  await statusReady; await builtinReady;
  if (workbook || demoish()) { if (!workbook) $('emptyState').hidden = false; return; }
  try {
    const r = await fetch('/data/' + DEFAULT_PORTFOLIO);
    if (!r.ok) throw new Error('not found');
    if (!workbook && await loadBuffer(await r.arrayBuffer(), DEFAULT_PORTFOLIO, false)) await run();
  } catch { if (!workbook) $('emptyState').hidden = false; }
})();

$('btnSample').addEventListener('click', async () => {
  await statusReady; await builtinReady;
  try { if (await loadBuffer(await sampleBytes(), sampleName(), true)) run(); }
  catch (e) { log.innerHTML = ''; say('Could not load the sample portfolio: ' + e.message, 'err'); }
});

// ---- saving files: the hosted page must go through the viewer's download prompt
let downloadsApi;
async function saveFile(name, buf) {
  if (!HOSTED) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return;
  }
  if (downloadsApi === undefined) downloadsApi = window.claude ? await window.claude.use('downloads') : null;
  if (!downloadsApi) { say('Saving files is not available in this view. Open the page in claude.ai to download.', 'warn'); return; }
  try { await downloadsApi.save({ filename: name, data: new Uint8Array(buf) }); }
  catch (e) { if (e && e.code !== 'declined') say('Could not save the file: ' + (e.message || e.code), 'warn'); }
}

// ---- upload: icon button at the top right, or drop a file anywhere on the page
$('btnUpload').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) uploadFile(f); });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); const f = e.dataTransfer.files[0]; if (f) uploadFile(f); });

async function uploadFile(f) {
  if (await loadBuffer(await f.arrayBuffer(), f.name, false)) run();
}
async function loadBuffer(buf, name, sample) {
  try {
    workbook = XLSX.read(buf, { type: 'array' });
    fileName = name; isSample = sample;
    pms = isPositionReport(workbook) ? parsePositionReport(workbook) : null;
    const sel = $('selPortfolio');
    sel.innerHTML = '';
    if (pms && pms.portfolios.length) {
      pms.portfolios.forEach((p, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${p.label} (${p.positions.length})`; sel.appendChild(o); });
      $('selectors').hidden = false;
      showTab('holdings');
    } else {
      $('selectors').hidden = true;
      if (pms) { pms = null; log.innerHTML = ''; say(`${name}: no positions found under the Security / Market Value in Transaction Currency / Portfolio columns.`, 'err'); return false; }
      showTab('summary');
    }
    return true;
  } catch (e) {
    log.innerHTML = ''; say(`Could not read ${name} as Excel: ${e.message}`, 'err');
    return false;
  }
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('selPortfolio').addEventListener('change', () => run());
$('selBenchmark').addEventListener('change', () => run());

// Business-day calendar for the past year, used when no built-in price data is loaded (test build).
function lastYearDates() {
  const out = [], d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 1);
  const end = new Date();
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  return out;
}
$('btnPrint').addEventListener('click', () => window.print());

$('btnExcel').addEventListener('click', exportExcel);

async function run() {
  if (!workbook) return;
  await statusReady; await builtinReady;
  const btns = [$('btnUpload'), $('btnSample')]; btns.forEach((b) => { b.classList.add('busy'); b.disabled = true; }); log.innerHTML = '';
  let ok = false;
  try {
    let model;
    if (pms) {
      const pf = pms.portfolios[+$('selPortfolio').value || 0];
      const bsel = $('selBenchmark');
      model = buildModelFromPortfolio(pf, builtinRaw || { dates: lastYearDates(), series: {} }, { id: bsel.value, name: bsel.options[bsel.selectedIndex].textContent.replace(/^PSEi – /, '') + ' (PSEi)' });
    } else model = parseWorkbook(workbook, priceWb, demoish() ? null : builtin);
    if (!demoish() && !model.priceHistory.length) { say('No prices available: the built-in price data could not be loaded. Reload the page and try again.', 'err'); return; }
    if (!pms) say(`Read ${model.holdings.length} holding rows${model.transactions.length ? `, ${model.transactions.length} transactions` : ''}${model.cashFlows.length ? `, ${model.cashFlows.length} cash flows` : ''}${model.benchmark.length ? `, ${model.benchmark.length} benchmark constituents` : ''}.`);
    if (model.priceRange && !pms) say(`Prices: ${model.priceRange.securities} securities, ${model.priceRange.min} → ${model.priceRange.max} ${model.usedBuiltin ? '(built in)' : 'from the Price_History sheet'}.`);
    model.info.forEach((w) => say(w));
    model.warnings.forEach((w) => say(w, 'warn'));
    if (model.errors.length) { log.innerHTML = ''; model.errors.forEach((e) => say(e, 'err')); say(`Fix the errors above in ${fileName} and upload it again with the upload button (top right).`, 'err'); return; }

    const progress = say('Fetching prices…');
    const fetched = await fetchPrices(model, (t) => (progress.textContent = t));
    const nOk = Object.keys(fetched.data).length, nErr = Object.keys(fetched.errors).length;
    const localLabel = model.priceSource === 'file' ? 'the market price file' : 'the Price_History sheet';
    progress.textContent = `Prices matched: ${nOk} symbols${fetched.localCount ? ` (${fetched.localCount} from ${localLabel})` : ''}${nErr ? `, ${nErr} missing` : ''}${fetched.mode === 'demo' ? ' — DEMO synthetic data' : ''}.`;
    if (nErr && Object.values(fetched.errors).some((e) => /no longer carries/i.test(e)))
      say('Yahoo Finance no longer provides Philippine stock prices. Add a Price_History sheet (Date, PSE_Ticker, Close) exported from your PMS, or ask your administrator to set an EODHD API key on the server.', 'err');
    progress.className = nErr ? 'warn' : 'ok';
    for (const [s, e] of Object.entries(fetched.errors)) say(`${s}: ${e}`, 'warn');

    const panel = buildPanel(model, fetched);
    const book = buildBook(model, panel, fetched);
    const msgs = { errors: [...model.errors, ...(book.errors || [])], warnings: [...model.warnings, ...panel.warnings, ...(book.warnings || [])], info: [...model.info] };
    if (book.errors && book.errors.length && !book.dates) { book.errors.forEach((e) => say(e, 'err')); return; }

    say('Computing VaR…');
    await new Promise((r) => setTimeout(r, 0));
    let risk, perf, attr;
    try { risk = computeRisk(model, panel, book); msgs.warnings.push(...(risk.warnings || [])); } catch (e) { risk = { error: 'VaR failed: ' + e.message }; console.error(e); }
    try { perf = computePerformance(model, panel, book); } catch (e) { msgs.errors.push('Performance failed: ' + e.message); console.error(e); }
    try { attr = computeAttribution(model, panel, book); msgs.warnings.push(...(attr.warnings || [])); } catch (e) { attr = { skipped: 'Attribution failed: ' + e.message }; console.error(e); }
    const dq = dataQuality(model, panel, fetched, book);

    ctx = { model, fetched, panel, book, risk, perf, attr, dq, msgs };
    window.pseReport = ctx; // inspect every intermediate result from the browser console
    render();
    ok = true;
    $('btnExcel').disabled = false; $('btnPrint').disabled = false;
  } catch (e) {
    console.error(e); say('Failed: ' + e.message, 'err');
  } finally {
    btns.forEach((b) => { b.classList.remove('busy'); b.disabled = false; });
    // On success the progress log is cleared; every message stays in the Data Quality tab.
    if (ok) log.innerHTML = '';
  }
}

function render() {
  const c = ctx.model.config;
  destroyCharts();
  $('report').hidden = false; $('emptyState').hidden = true;
  const title = pms ? c.name : isSample ? 'Sample portfolio' : c.hasInfoSheet ? c.name : fileName.replace(/\.[^.]+$/, '');
  $('rTitle').textContent = `${title}${c.id && !isSample ? ' · ' + c.id : ''}`;
  $('rMeta').textContent = `Period ${ctx.book.dates[0]} → ${ctx.book.dates[ctx.book.T - 1]} · valuation ${c.valuationDate} · benchmark ${c.benchmarkName}` + (isSample ? '' : ` · file ${fileName}`);
  $('tabBtnHoldings').hidden = !ctx.model.positions;
  renderHoldings($('tab-holdings'), ctx);
  const issues = ctx.msgs.errors.length + ctx.msgs.warnings.length + ctx.dq.filter((d) => d.status !== 'OK').length;
  $('dqCount').textContent = issues ? String(issues) : '';
  renderSummary($('tab-summary'), ctx);
  renderRisk($('tab-risk'), ctx);
  renderPerformance($('tab-perf'), ctx);
  renderAttribution($('tab-attr'), ctx);
  renderDQ($('tab-dq'), ctx);
  // charts in hidden tabs need a resize once shown
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => window.dispatchEvent(new Event('resize')), { once: true }));
  $('report').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function exportExcel() {
  if (!ctx) return;
  const { risk, perf, attr, book, dq, model } = ctx;
  const wb = XLSX.utils.book_new();
  const add = (name, rows) => { if (rows && rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name); };
  const r4 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1e6) / 1e6);
  const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
  add('Summary', [
    { Item: 'Portfolio', Value: model.config.name }, { Item: 'Valuation date', Value: model.config.valuationDate },
    { Item: 'Valuation currency', Value: 'PHP' },
    ...(risk && !risk.error ? [{ Item: 'NAV', Value: r2(risk.totalNAV) }] : []),
    ...(perf ? [{ Item: 'TWR', Value: r4(perf.twr) }, { Item: 'Benchmark return', Value: r4(perf.bench) }, { Item: 'Active return', Value: r4(perf.active) }, { Item: 'XIRR', Value: r4(perf.irr) }] : []),
    ...(attr && !attr.skipped ? [{ Item: 'Allocation', Value: r4(attr.totals.alloc) }, { Item: 'Selection', Value: r4(attr.totals.sel) }, { Item: 'Interaction', Value: r4(attr.totals.inter) }] : []),
  ]);
  if (model.positions) add('Holdings', model.positions.map((p) => ({ Security: p.security, 'Security Name': p.name, 'Asset Class': p.assetClass, Currency: p.currency, 'Book Cost in Transaction Currency': p.bookCost, 'Market Value in Transaction Currency': p.marketValue, 'Book Cost (PHP)': r2(p.bookCostPHP), 'Market Value (PHP)': r2(p.marketValuePHP), Portfolio: p.portfolio })));
  if (risk && !risk.error) {
    add('VaR', risk.table.map((x) => ({ Confidence: x.conf, Horizon_Days: x.horizon, Hist_VaR: r2(x.histVar), Hist_ES: r2(x.histEs), Param_VaR: r2(x.paraVar), Param_ES: r2(x.paraEs), MC_VaR: r2(x.mcVar), MC_ES: r2(x.mcEs) })));
    add('Risk_Contribution', risk.contrib.map((x) => ({ Ticker: x.ticker, Name: x.name, Sector: x.sector, Market_Value: r2(x.mv), Weight: r4(x.weight), Ann_Vol: r4(x.annVol), Standalone_VaR: r2(x.standalone), Marginal_VaR: r4(x.marginal), Component_VaR: r2(x.component), Pct_of_VaR: r4(x.componentPct), Incremental_VaR: r2(x.incremental), ES_Contribution: r2(x.histEsContrib) })));
    add('Risk_by_Sector', risk.bySector.map((x) => ({ Sector: x.sector, Weight: r4(x.weight), Sector_VaR: r2(x.sectorVar), Component_VaR: r2(x.component), Pct_of_VaR: r4(x.componentPct) })));
    add('Stress', risk.stress.map((x) => ({ Scenario: x.name, Type: x.type, Detail: x.detail, PnL: r2(x.pnl), Pct_NAV: r4(x.pct) })));
    add('Backtest', risk.backtest.series.map((x) => ({ Date: x.date, PnL: r2(x.pnl), Minus_VaR: r2(x.var), Exception: x.pnl < x.var ? 1 : 0 })));
  }
  if (perf) {
    add('Returns', perf.periods.map((x) => ({ Period: x.label, From: x.from, Portfolio: r4(x.port), Benchmark: r4(x.bench), Active: r4(x.active) })));
    add('Monthly', perf.months.map((x) => ({ Month: x.key, Portfolio: r4(x.port), Benchmark: r4(x.bench), Active: r4(x.active) })));
    add('Contribution', perf.contrib.map((x) => ({ Ticker: x.ticker, Name: x.name, Sector: x.sector, Avg_Weight: r4(x.avgWeight), Holding_Return: r4(x.ret), PnL: r2(x.pnl), Contribution: r4(x.contribution) })));
    add('Daily_NAV', book.dates.map((d, k) => ({ Date: d, NAV: r2(book.V[k]), Cash: r2(book.cash[k]), Client_Flow: r2(book.flow[k]), Portfolio_Return: r4(book.ret[k]), Benchmark_Return: r4(perf.rb[k]) })));
  }
  if (attr && !attr.skipped) {
    add('Attribution', attr.rows.map((x) => ({ Sector: x.sector, Port_Weight: r4(x.wp), Bench_Weight: r4(x.wb), Port_Return: r4(x.rp), Bench_Return: r4(x.rb), Allocation: r4(x.alloc), Selection: r4(x.sel), Interaction: r4(x.inter), Total: r4(x.total) })));
    add('Attribution_Monthly', attr.monthly.map((x) => ({ Month: x.month, Portfolio: r4(x.port), Benchmark: r4(x.bench), Allocation: r4(x.alloc), Selection: r4(x.sel), Interaction: r4(x.inter) })));
  }
  add('Data_Quality', dq.map((x) => ({ Ticker: x.ticker, Yahoo: x.yahoo, Role: x.role, Status: x.status, Obs: x.obs, Window: x.window, First: x.first, Last: x.last, Note: x.note })));
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveFile(`${model.config.name.replace(/[^\w\-]+/g, '_')}_report_${model.config.valuationDate}.xlsx`, out);
}

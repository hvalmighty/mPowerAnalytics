import { parseWorkbook } from './parser.js';
import { fetchPrices, buildPanel, buildBook, dataQuality } from './data.js';
import { computeRisk } from './risk.js';
import { computePerformance } from './performance.js';
import { computeAttribution } from './attribution.js';
import { renderSummary, renderRisk, renderPerformance, renderAttribution, renderDQ, destroyCharts } from './report.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
let workbook = null, fileName = '', ctx = null;
// PSE_HOSTED is set by the single-file build (tools/build_hosted.mjs): no server,
// prices generated in the browser, files saved through the host's download prompt.
const HOSTED = !!window.PSE_HOSTED;

function say(text, cls = '') { const li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; log.appendChild(li); return li; }

// data-source badge
function demoBadge() { const b = $('modeBadge'); b.textContent = 'Demo prices (synthetic)'; b.className = 'badge demo'; $('demoBanner').hidden = false; }
if (HOSTED) {
  demoBadge(); $('btnPrint').hidden = true;
  $('demoBanner').textContent = 'Test version: prices are synthetic and generated in your browser. They are not Yahoo Finance or PSE data, so the figures mean nothing. Real prices need the full app running on a server.';
  document.querySelector('.foot').textContent = 'Test version with synthetic prices. The full app fetches daily PSE prices from Yahoo Finance.';
}
else fetch('/api/status').then((r) => r.json()).then((s) => {
  const b = $('modeBadge');
  if (s.mode === 'demo') demoBadge();
  else { b.textContent = 'Live: Yahoo Finance'; b.className = 'badge live'; }
}).catch(() => { $('modeBadge').textContent = 'Price server offline'; });

// ---- sample workbook
async function sampleBytes() {
  if (HOSTED) return Uint8Array.from(atob(window.PSE_SAMPLE_B64), (c) => c.charCodeAt(0)).buffer;
  const r = await fetch('/sample/PSE_Portfolio_Sample.xlsx');
  if (!r.ok) throw new Error('sample not found');
  return r.arrayBuffer();
}
$('btnSample').addEventListener('click', async () => {
  const buf = await sampleBytes();
  await loadBuffer(buf, 'PSE_Portfolio_Sample.xlsx');
  if (workbook) run();
});
$('btnSaveSample').addEventListener('click', async () => saveFile('PSE_Portfolio_Sample.xlsx', await sampleBytes()));

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

// file input + drag/drop
const drop = $('drop');
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });

async function loadFile(f) {
  if (!f) return;
  await loadBuffer(await f.arrayBuffer(), f.name);
}
async function loadBuffer(buf, name) {
  fileName = name; $('fileName').textContent = name;
  try { workbook = XLSX.read(buf, { type: 'array' }); $('btnRun').disabled = false; }
  catch (e) { workbook = null; log.innerHTML = ''; say('Could not read the file as Excel: ' + e.message, 'err'); }
}

$('btnRun').addEventListener('click', run);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
}));
$('btnPrint').addEventListener('click', () => window.print());

$('btnExcel').addEventListener('click', exportExcel);

async function run() {
  if (!workbook) return;
  $('btnRun').disabled = true; log.innerHTML = '';
  try {
    const model = parseWorkbook(workbook);
    say(`Read ${model.holdings.length} holding rows, ${model.transactions.length} transactions, ${model.cashFlows.length} cash flows, ${model.benchmark.length} benchmark constituents.`);
    model.warnings.forEach((w) => say(w, 'warn'));
    if (model.errors.length) { model.errors.forEach((e) => say(e, 'err')); say('Fix the errors above and upload again.', 'err'); return; }

    const progress = say('Fetching prices…');
    const fetched = await fetchPrices(model, (t) => (progress.textContent = t));
    const nOk = Object.keys(fetched.data).length, nErr = Object.keys(fetched.errors).length;
    progress.textContent = `Prices: ${nOk} symbols loaded (${fetched.from} → ${fetched.to})${nErr ? `, ${nErr} failed` : ''}${fetched.mode === 'demo' ? ' — DEMO synthetic data' : ''}.`;
    progress.className = nErr ? 'warn' : 'ok';
    for (const [s, e] of Object.entries(fetched.errors)) say(`${s}: ${e}`, 'warn');

    const panel = buildPanel(model, fetched);
    const book = buildBook(model, panel, fetched);
    const msgs = { errors: [...model.errors, ...(book.errors || [])], warnings: [...model.warnings, ...panel.warnings, ...(book.warnings || [])] };
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
    say('Reports ready.', 'ok');
    $('btnExcel').disabled = false; $('btnPrint').disabled = false;
  } catch (e) {
    console.error(e); say('Failed: ' + e.message, 'err');
  } finally { $('btnRun').disabled = false; }
}

function render() {
  const c = ctx.model.config;
  destroyCharts();
  $('report').hidden = false;
  $('rTitle').textContent = `${c.name}${c.id ? ' · ' + c.id : ''}`;
  $('rMeta').textContent = `Period ${ctx.book.dates[0]} → ${ctx.book.dates[ctx.book.T - 1]} · valuation ${c.valuationDate} · benchmark ${c.benchmarkName} · ${ctx.fetched.mode === 'demo' ? 'DEMO synthetic prices' : 'prices: Yahoo Finance'} · source file ${fileName}`;
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
    { Item: 'Data source', Value: ctx.fetched.mode === 'demo' ? 'DEMO synthetic prices' : 'Yahoo Finance' },
    ...(risk && !risk.error ? [{ Item: 'NAV', Value: r2(risk.totalNAV) }] : []),
    ...(perf ? [{ Item: 'TWR', Value: r4(perf.twr) }, { Item: 'Benchmark return', Value: r4(perf.bench) }, { Item: 'Active return', Value: r4(perf.active) }, { Item: 'XIRR', Value: r4(perf.irr) }] : []),
    ...(attr && !attr.skipped ? [{ Item: 'Allocation', Value: r4(attr.totals.alloc) }, { Item: 'Selection', Value: r4(attr.totals.sel) }, { Item: 'Interaction', Value: r4(attr.totals.inter) }] : []),
  ]);
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

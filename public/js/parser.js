// Reads the uploaded workbook (SheetJS global XLSX) into a clean data model,
// collecting hard errors (stop) and warnings (continue).

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Accepted header aliases per field
const ALIASES = {
  date: ['date', 'snapshotdate', 'asofdate', 'tradedate', 'valuedate'],
  ticker: ['pseticker', 'ticker', 'symbol', 'stockcode', 'code', 'securitycode'],
  yahoo: ['yahoosymbol', 'yahooticker'],
  isin: ['isin'],
  name: ['securityname', 'name', 'companyname', 'description'],
  sector: ['sector', 'psesector', 'industrygroup'],
  subsector: ['subsector', 'industry'],
  qty: ['quantity', 'qty', 'shares', 'units', 'position'],
  avgCost: ['avgcost', 'averagecost', 'costprice', 'unitcost'],
  price: ['price', 'pmsprice', 'tradeprice', 'marketprice', 'closeprice', 'close', 'closingprice', 'lastprice'],
  adj: ['adjclose', 'adjustedclose', 'totalreturnprice', 'adjustedprice'],
  mv: ['marketvalue', 'marketvaluephp', 'mv', 'value'],
  type: ['type', 'transactiontype', 'txntype'],
  fees: ['fees', 'charges', 'commission', 'feesandtaxes'],
  net: ['netamount', 'net', 'amount', 'netcash'],
  amount: ['amount', 'cashflow', 'flowamount'],
  weight: ['weight', 'indexweight', 'weightpct', 'weight%'],
  scenario: ['scenario', 'scenarioname'],
  target: ['target', 'appliesto', 'riskfactor'],
  shock: ['shock', 'shockpct', 'shock%'],
  start: ['startdate', 'start', 'from'],
  end: ['enddate', 'end', 'to'],
};

function excelDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // DD/MM/YYYY (PH & IN convention)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

function num(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/[,\s₱]|PHP/gi, '');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const pct = s.endsWith('%'); if (pct) s = s.slice(0, -1);
  const n = Number(s);
  if (!isFinite(n)) return NaN;
  return (neg ? -n : n) / (pct ? 100 : 1);
}

export const cleanTicker = (t) => String(t ?? '').trim().toUpperCase().replace(/\.PS$/, '');
export const yahooSymbol = (t) => (t === 'CASH' ? null : `${t}.PS`);

function findSheet(wb, names) {
  const want = names.map(norm);
  return wb.SheetNames.find((n) => want.includes(norm(n)));
}

function readTable(wb, sheetNames, fields, required, ctx) {
  const name = findSheet(wb, sheetNames);
  if (!name) return null;
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false });
  // header = first row that contains at least 2 known aliases
  let hIdx = rows.findIndex((r) => r.filter((c) => fields.some((f) => ALIASES[f].includes(norm(c)))).length >= 2);
  if (hIdx < 0) { ctx.errors.push(`Sheet "${name}": could not find a header row.`); return []; }
  const header = rows[hIdx].map(norm);
  const col = {};
  for (const f of fields) col[f] = header.findIndex((h) => ALIASES[f].includes(h));
  const missing = required.filter((f) => col[f] < 0);
  if (missing.length) ctx.errors.push(`Sheet "${name}": missing required column(s): ${missing.join(', ')}.`);
  const out = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c == null || c === '')) continue;
    const o = { _row: i + 1, _sheet: name };
    for (const f of fields) o[f] = col[f] >= 0 ? r[col[f]] : null;
    out.push(o);
  }
  return out;
}

function readConfig(wb, ctx) {
  const name = findSheet(wb, ['Portfolio_Info', 'PortfolioInfo', 'Config', 'Settings']);
  if (!name) { ctx.errors.push('Required sheet "Portfolio_Info" not found.'); return {}; }
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
  const kv = {};
  for (const r of rows) if (r && r[0] != null && r[1] != null && r[1] !== '') kv[norm(r[0])] = r[1];
  const g = (...keys) => { for (const k of keys) if (kv[norm(k)] != null) return kv[norm(k)]; return null; };

  const list = (v, d) => (v == null ? d : String(v).split(/[,;\s]+/).filter(Boolean).map(Number).filter(isFinite));
  const conf = list(g('VaR_Confidence_Levels', 'Confidence_Levels'), [95, 99]).map((x) => (x > 1 ? x / 100 : x));
  const cfg = {
    name: g('Portfolio_Name') || 'Portfolio',
    id: g('Portfolio_ID') || '',
    manager: g('Portfolio_Manager', 'Manager') || '',
    baseCurrency: (g('Base_Currency') || 'PHP').toString().toUpperCase(),
    valuationDate: excelDate(g('Valuation_Date', 'As_Of_Date')),
    periodStart: excelDate(g('Period_Start', 'Reporting_Period_Start')),
    periodEnd: excelDate(g('Period_End', 'Reporting_Period_End')),
    inceptionDate: excelDate(g('Inception_Date')),
    benchmarkName: g('Benchmark_Name') || 'PSE Composite Index (PSEi)',
    benchmarkSymbol: (g('Benchmark_Yahoo_Symbol', 'Benchmark_Symbol') || 'PSEI.PS').toString().trim().toUpperCase(),
    confidence: conf.length ? conf : [0.95, 0.99],
    horizons: list(g('VaR_Horizon_Days', 'Horizon_Days'), [1, 10]).filter((x) => x >= 1),
    lookback: Math.round(num(g('VaR_Lookback_Days', 'Lookback_Days')) || 500),
    mcSims: Math.round(num(g('MC_Simulations', 'Monte_Carlo_Simulations')) || 10000),
    covMethod: String(g('Covariance_Method') || 'EWMA').toUpperCase().startsWith('S') ? 'SAMPLE' : 'EWMA',
    ewmaLambda: num(g('EWMA_Lambda')) || 0.94,
    backtestDays: Math.round(num(g('Backtest_Days')) || 250),
    riskFreeRate: (() => { const v = num(g('Risk_Free_Rate', 'Risk_Free_Rate_Annual')); return v == null ? 0 : v > 1 ? v / 100 : v; })(),
    autoDividends: !/^(n|no|false|0)$/i.test(String(g('Auto_Dividends_From_Yahoo', 'Auto_Dividends') ?? 'YES')),
    benchmarkReturnType: String(g('Benchmark_Return_Type') || 'PRICE').toUpperCase().startsWith('T') ? 'TOTAL' : 'PRICE',
    attributionGroup: (g('Attribution_Grouping') || 'Sector').toString(),
  };
  cfg.periodEnd = cfg.periodEnd || cfg.valuationDate;
  cfg.valuationDate = cfg.valuationDate || cfg.periodEnd;
  if (!cfg.valuationDate) ctx.errors.push('Portfolio_Info: Valuation_Date is required.');
  if (!cfg.periodStart) ctx.errors.push('Portfolio_Info: Period_Start is required.');
  if (cfg.periodStart && cfg.periodEnd && cfg.periodStart >= cfg.periodEnd) ctx.errors.push('Portfolio_Info: Period_Start must be before Period_End.');
  if (cfg.valuationDate && cfg.periodEnd && cfg.valuationDate !== cfg.periodEnd) ctx.warnings.push(`Valuation_Date (${cfg.valuationDate}) differs from Period_End (${cfg.periodEnd}); VaR uses positions on Valuation_Date.`);
  if (cfg.baseCurrency !== 'PHP') ctx.warnings.push(`Base currency ${cfg.baseCurrency}: PSE prices are in PHP and no FX conversion is applied in this version.`);
  if (cfg.confidence.some((c) => !(c > 0.5 && c < 1))) ctx.errors.push('Portfolio_Info: confidence levels must be between 50 and 100.');
  if (cfg.lookback < 60) ctx.errors.push('Portfolio_Info: VaR_Lookback_Days should be at least 60 (250+ recommended).');
  return cfg;
}

export function parseWorkbook(wb) {
  const ctx = { errors: [], warnings: [] };
  const config = readConfig(wb, ctx);

  // ---- Holdings ----
  const H = readTable(wb, ['Holdings', 'Positions'], ['date', 'ticker', 'yahoo', 'isin', 'name', 'sector', 'subsector', 'qty', 'avgCost', 'price', 'mv'], ['ticker', 'qty'], ctx);
  if (!H) ctx.errors.push('Required sheet "Holdings" not found.');
  const holdings = [];
  for (const r of H || []) {
    const ticker = cleanTicker(r.ticker);
    const qty = num(r.qty);
    if (!ticker && qty == null) continue; // note / blank line
    if (!ticker) { ctx.warnings.push(`Holdings row ${r._row}: blank ticker, row skipped.`); continue; }
    if (qty == null || isNaN(qty)) { ctx.errors.push(`Holdings row ${r._row} (${ticker}): quantity is not a number.`); continue; }
    holdings.push({
      date: excelDate(r.date) || config.valuationDate, ticker, yahoo: r.yahoo ? String(r.yahoo).trim().toUpperCase() : yahooSymbol(ticker),
      isin: r.isin || '', name: r.name || ticker, sector: ticker === 'CASH' ? 'Cash' : (r.sector || 'Unclassified').toString().trim(),
      subsector: r.subsector || '', qty, avgCost: num(r.avgCost), price: num(r.price), mv: num(r.mv),
    });
  }

  // ---- Transactions ----
  const T = readTable(wb, ['Transactions', 'Trades'], ['date', 'ticker', 'type', 'qty', 'price', 'fees', 'net'], ['date', 'ticker', 'type'], ctx) || [];
  const TYPES = { BUY: 'BUY', B: 'BUY', PURCHASE: 'BUY', SELL: 'SELL', S: 'SELL', SALE: 'SELL', DIVIDEND: 'DIVIDEND', DIV: 'DIVIDEND', CASHDIVIDEND: 'DIVIDEND', FEE: 'FEE', FEES: 'FEE', MANAGEMENTFEE: 'FEE', TAX: 'FEE', INTEREST: 'INTEREST', STOCKDIVIDEND: 'STOCK_DIVIDEND', BONUS: 'STOCK_DIVIDEND', SPLIT: 'STOCK_DIVIDEND' };
  const transactions = [];
  for (const r of T) {
    if (r.type == null && r.ticker == null) continue; // note line
    const type = TYPES[norm(r.type).toUpperCase()];
    const date = excelDate(r.date);
    const ticker = cleanTicker(r.ticker) || 'CASH';
    if (!type) { ctx.errors.push(`Transactions row ${r._row}: unknown type "${r.type}" (use BUY, SELL, DIVIDEND, FEE, INTEREST, STOCK_DIVIDEND).`); continue; }
    if (!date) { ctx.errors.push(`Transactions row ${r._row}: invalid date.`); continue; }
    const t = { date, ticker, type, qty: Math.abs(num(r.qty) || 0), price: num(r.price), fees: Math.abs(num(r.fees) || 0), net: num(r.net), _row: r._row };
    if ((type === 'BUY' || type === 'SELL') && !t.qty) { ctx.errors.push(`Transactions row ${r._row}: ${type} needs a quantity.`); continue; }
    if ((type === 'DIVIDEND' || type === 'FEE' || type === 'INTEREST') && t.net == null) { ctx.errors.push(`Transactions row ${r._row}: ${type} needs Net_Amount.`); continue; }
    if (config.periodStart && (date <= config.periodStart || date > config.periodEnd)) { ctx.warnings.push(`Transactions row ${r._row}: ${date} is on/before Period_Start or after Period_End (opening snapshot is end-of-day), ignored.`); continue; }
    transactions.push(t);
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  // ---- External cash flows ----
  const C = readTable(wb, ['Cash_Flows', 'CashFlows', 'Flows'], ['date', 'amount', 'type'], ['date', 'amount'], ctx) || [];
  const cashFlows = [];
  for (const r of C) {
    const date = excelDate(r.date); let amount = num(r.amount);
    if (!date || amount == null || isNaN(amount)) { ctx.errors.push(`Cash_Flows row ${r._row}: invalid date or amount.`); continue; }
    const tp = norm(r.type);
    if (tp.startsWith('with') || tp.startsWith('redem')) amount = -Math.abs(amount);
    else if (tp.startsWith('contr') || tp.startsWith('subs') || tp.startsWith('dep')) amount = Math.abs(amount);
    if (config.periodStart && (date <= config.periodStart || date > config.periodEnd)) { ctx.warnings.push(`Cash_Flows row ${r._row}: ${date} is outside the reporting period, ignored.`); continue; }
    cashFlows.push({ date, amount, type: r.type || (amount >= 0 ? 'Contribution' : 'Withdrawal') });
  }

  // ---- Benchmark constituents (attribution) ----
  const B = readTable(wb, ['Benchmark_Constituents', 'Benchmark', 'Index_Constituents'], ['ticker', 'yahoo', 'name', 'sector', 'weight'], ['ticker', 'sector', 'weight'], ctx);
  const benchmark = [];
  for (const r of B || []) {
    const ticker = cleanTicker(r.ticker); const w = num(r.weight);
    if (!ticker || w == null || isNaN(w)) continue;
    benchmark.push({ ticker, yahoo: r.yahoo ? String(r.yahoo).trim().toUpperCase() : yahooSymbol(ticker), name: r.name || ticker, sector: (r.sector || 'Unclassified').toString().trim(), weight: w });
  }
  if (benchmark.length) {
    const tw = benchmark.reduce((s, b) => s + b.weight, 0);
    benchmark.forEach((b) => (b.weight /= tw)); // works for % or fractions; always normalised to 100%
    const off = tw > 1.5 ? Math.abs(tw - 100) > 0.5 : Math.abs(tw - 1) > 0.005;
    if (off) ctx.warnings.push(`Benchmark weights sum to ${tw.toFixed(2)}${tw > 1.5 ? '%' : ''}; normalised to 100%.`);
  } else ctx.warnings.push('No Benchmark_Constituents sheet: attribution report will be skipped.');

  // ---- Stress scenarios (optional) ----
  const S = readTable(wb, ['Stress_Scenarios', 'Scenarios'], ['scenario', 'type', 'target', 'shock', 'start', 'end'], ['scenario', 'type'], ctx) || [];
  const scenarios = [];
  for (const r of S) {
    if (r.type == null || r.type === '') continue; // note line
    const type = String(r.type || '').toUpperCase().startsWith('H') ? 'HISTORICAL' : 'SHOCK';
    const s = { name: String(r.scenario), type, target: String(r.target || 'ALL').trim(), shock: num(r.shock), start: excelDate(r.start), end: excelDate(r.end) };
    if (type === 'HISTORICAL' && (!s.start || !s.end)) { ctx.warnings.push(`Stress_Scenarios row ${r._row}: historical scenario needs Start_Date and End_Date.`); continue; }
    if (type === 'SHOCK') {
      if (s.shock == null || isNaN(s.shock)) { ctx.warnings.push(`Stress_Scenarios row ${r._row}: shock scenario needs Shock_%.`); continue; }
      if (Math.abs(s.shock) > 1) s.shock /= 100;
    }
    scenarios.push(s);
  }

  // ---- Price overrides (optional) ----
  const O = readTable(wb, ['Price_Override', 'Price_Overrides'], ['date', 'ticker', 'price'], ['date', 'ticker', 'price'], ctx) || [];
  const overrides = O.map((r) => ({ date: excelDate(r.date), ticker: cleanTicker(r.ticker), price: num(r.price) })).filter((o) => o.date && o.ticker && o.price > 0);

  // ---- Price history from the PMS (optional; overrides fetched prices for the tickers it covers)
  const PH = readTable(wb, ['Price_History', 'PriceHistory', 'Prices'], ['date', 'ticker', 'price', 'adj'], ['date', 'ticker', 'price'], ctx) || [];
  const priceHistory = [];
  let badPx = 0;
  for (const r of PH) {
    const date = excelDate(r.date), ticker = cleanTicker(r.ticker), close = num(r.price), adj = num(r.adj);
    if (!date && !ticker) continue;
    if (!date || !ticker || !(close > 0)) { badPx++; continue; }
    priceHistory.push({ date, ticker, close, adj: adj > 0 ? adj : null });
  }
  if (badPx) ctx.warnings.push(`Price_History: ${badPx} row(s) skipped (missing date, ticker or a positive close).`);

  if (!holdings.length && H) ctx.errors.push('Holdings sheet has no valid rows.');
  return { config, holdings, transactions, cashFlows, benchmark, scenarios, overrides, priceHistory, errors: ctx.errors, warnings: ctx.warnings };
}

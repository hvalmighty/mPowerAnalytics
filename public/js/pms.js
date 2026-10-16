// Reads the mPower position report (one or many portfolios) and turns a selected
// portfolio into the model the risk / performance engines use.
//
// Fields used: Security, Security Name, Book Cost in Transaction Currency,
// Market Value in Transaction Currency, Portfolio. Asset-class header rows
// ("Asset Class:ORD - Ordinary Shares") group the positions; subtotal rows are skipped.
//
// Prices: the built-in PMS price data when the Security code is found there;
// otherwise a simulated daily series that stays within a 3–5% band of today's
// value (band fixed per security). The PSEi benchmark is simulated the same way.

import { defaultConfig } from './parser.js';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const FIELDS = {
  security: ['security'],
  name: ['securityname'],
  bookCost: ['bookcostintransactioncurrency'],
  mv: ['marketvalueintransactioncurrency'],
  portfolio: ['portfolio'],
  currency: ['transactioncurrency'],
};
// FX to the reporting currency (PHP); positions in other currencies are converted at these rates.
export const FX_TO_PHP = { PHP: 1, USD: 62.5 };
export const toPHP = (amount, ccy) => (amount == null ? null : amount * (FX_TO_PHP[(ccy || 'PHP').toUpperCase()] ?? 1));
const num = (v) => (typeof v === 'number' ? v : v == null || v === '' ? null : Number(String(v).replace(/[,\s]/g, '')));

// ---- detection + parsing --------------------------------------------------
export function isPositionReport(wb) {
  return !!findHeader(wb);
}
function findHeader(wb) {
  for (const sn of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: null, blankrows: false });
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const h = (rows[i] || []).map(norm);
      if (h.includes('security') && h.includes('portfolio') && h.includes('marketvalueintransactioncurrency')) return { rows, i, h, sheet: sn };
    }
  }
  return null;
}

export function parsePositionReport(wb) {
  const f = findHeader(wb);
  if (!f) return null;
  const col = {};
  for (const [k, al] of Object.entries(FIELDS)) col[k] = f.h.findIndex((x) => al.includes(x));
  const byPf = new Map();
  let assetClass = '';
  for (let r = f.i + 1; r < f.rows.length; r++) {
    const row = f.rows[r] || [];
    const sec = String(row[col.security] ?? '').trim();
    if (!sec) continue;
    const ac = sec.match(/^Asset Class\s*:\s*(.+)$/i);
    if (ac) { assetClass = ac[1].replace(/^[A-Z0-9]+\s*-\s*/, '').trim() || ac[1].trim(); continue; }
    if (/total\s*:?\s*$/i.test(sec)) continue;
    const mv = num(row[col.mv]);
    if (mv == null || isNaN(mv)) continue;
    const pf = String(row[col.portfolio] ?? '').trim() || 'Portfolio';
    if (!byPf.has(pf)) byPf.set(pf, []);
    byPf.get(pf).push({
      security: sec,
      name: String(row[col.name] ?? '').trim() || sec,
      bookCost: num(row[col.bookCost]),
      marketValue: mv,
      portfolio: pf,
      currency: (col.currency >= 0 ? String(row[col.currency] ?? '').trim() : '') || 'PHP',
      assetClass: assetClass || 'Other',
    });
  }
  return { sheet: f.sheet, portfolios: [...byPf.entries()].map(([id, positions]) => ({ id, label: id.replace(/\s*:\s*/, ' · '), positions })) };
}

// ---- simulated prices (deterministic per code) ------------------------------
function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) {
  let s = seed >>> 0;
  const uni = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { let u = 0; while (!u) u = uni(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * uni()); };
}
export const simBand = (code) => 0.03 + (hash('band:' + code) % 2001) / 100000; // 3.00% – 5.00%

// Index series on `dates` ending exactly at `endLevel`; every point stays within ±band of it.
export function simulateSeries(code, dates, endLevel = 100) {
  const band = simBand(code), n = dates.length, g = rng(hash('px:' + code));
  const x = new Array(n).fill(0);
  const step = band / 6;
  for (let i = n - 2; i >= 0; i--) { // walk backwards from today, reflecting at the band edges
    let v = x[i + 1] + step * g();
    if (v > band) v = 2 * band - v;
    if (v < -band) v = -2 * band - v;
    x[i] = Math.max(-band, Math.min(band, v));
  }
  return { band, closes: x.map((v) => +(endLevel * (1 + v)).toFixed(6)) };
}

// ---- model for one portfolio --------------------------------------------------
// builtin: { dates, series: {CODE: [prices…]} } from public/data/market_prices.json
export function buildModelFromPortfolio(pf, builtin, benchmark = { id: 'PSEI', name: 'PSE Composite Index (PSEi)' }) {
  const dates = builtin.dates;
  const priceRange = { min: dates[0], max: dates[dates.length - 1], securities: 0 };
  const ctx = { errors: [], warnings: [], info: [] };
  const config = defaultConfig(priceRange, ctx);
  config.name = pf.label;
  config.benchmarkName = benchmark.name;
  config.benchmarkSymbol = 'PSEI.PS';
  config.autoDividends = false;

  const priceHistory = [], holdings = [], simulated = [], matched = [];
  const seen = new Set();
  for (const p of pf.positions) {
    const code = p.security.trim().toUpperCase();
    const key = seen.has(code) ? `${code}#${seen.size}` : code; // keep duplicate codes as separate lines
    seen.add(code);
    let last = null;
    const real = builtin.series[code];
    if (real && real.some((v) => v > 0)) {
      real.forEach((v, i) => { if (v > 0) { priceHistory.push({ date: dates[i], ticker: key, close: v, adj: null }); last = v; } });
      matched.push(p.security);
    } else {
      const s = simulateSeries(code, dates, 100);
      s.closes.forEach((v, i) => priceHistory.push({ date: dates[i], ticker: key, close: v, adj: null, sim: true }));
      last = 100;
      simulated.push(`${p.security} (±${(s.band * 100).toFixed(1)}%)`);
    }
    const mvPHP = toPHP(p.marketValue, p.currency);
    p.marketValuePHP = mvPHP; p.bookCostPHP = toPHP(p.bookCost, p.currency);
    holdings.push({
      date: config.valuationDate, ticker: key, yahoo: `${key}.PS`, isin: '', name: p.name, sector: p.assetClass,
      subsector: '', qty: mvPHP / last, avgCost: null, price: null, mv: mvPHP,
    });
  }
  const b = simulateSeries('BENCH:' + benchmark.id, dates, 6000);
  b.closes.forEach((v, i) => priceHistory.push({ date: dates[i], ticker: 'PSEI', close: v, adj: null, sim: true }));
  priceRange.securities = matched.length + simulated.length;

  ctx.info.push(`Holdings treated as unchanged over ${priceRange.min} → ${priceRange.max}.`);
  const fx = [...new Set(pf.positions.map((p) => p.currency.toUpperCase()).filter((c) => c !== 'PHP'))];
  if (fx.length) ctx.info.push(`Values in PHP; ${fx.map((c) => `${c} converted at ${FX_TO_PHP[c] ?? 1}`).join(', ')}.`);

  return {
    config, holdings, transactions: [], cashFlows: [], benchmark: [], scenarios: [], overrides: [],
    priceHistory, priceRange, priceSource: 'file', usedBuiltin: true, benchmarkSimulated: true, fxRates: FX_TO_PHP,
    positions: pf.positions, errors: ctx.errors, warnings: ctx.warnings, info: ctx.info,
  };
}

// PSE Portfolio Risk & Performance — backend
// Serves the browser app and fetches daily price history, with a file cache.
//
// Price sources (in order):
//   1. EODHD (https://eodhd.com) for PSE stocks, when EODHD_API_KEY is set.
//      Yahoo Finance no longer carries individual Philippine stocks.
//   2. Yahoo Finance: the PSEi index (PSEI.PS) and any symbol EODHD cannot supply.
//   (A Price_History sheet in the uploaded workbook overrides both, in the browser.)
//
//   npm start            -> live data
//   npm run demo         -> synthetic prices (offline testing only, clearly flagged in the UI)

const express = require('express');
const path = require('path');
const fs = require('fs');
let demoHistory; // loaded only in DEMO mode (ES module shared with the browser build)

const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO === '1';
// Serverless hosts (Vercel, Netlify, Lambda) only allow writes under /tmp.
const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);
const CACHE_DIR = process.env.CACHE_DIR || (SERVERLESS ? '/tmp/pse-cache' : path.join(__dirname, 'cache'));
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 12);
const CONCURRENCY = Number(process.env.YAHOO_CONCURRENCY || 3);
const EODHD_KEY = (process.env.EODHD_API_KEY || '').trim();
const EODHD_EXCHANGE = process.env.EODHD_EXCHANGE || 'PSE';
const EODHD_DIVIDENDS = process.env.EODHD_DIVIDENDS !== '0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

let cacheOk = true;
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { cacheOk = false; console.warn('Price cache disabled:', e.message); }

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Browser libraries live in public/vendor (copied by `npm run vendor`) so static hosts serve them too.

const toUnix = (d) => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYMBOL_RE = /^[A-Z0-9^.\-=]{1,20}$/;

// ---------- EODHD end-of-day API ----------
// Our symbols use the Yahoo form (BDO.PS); EODHD uses BDO.PSE.
const toEodhd = (symbol) => symbol.replace(/\.PS$/, '.' + EODHD_EXCHANGE);
const useEodhd = (symbol) => !!EODHD_KEY && /\.PS$/.test(symbol) && !/^PSEI\./.test(symbol) && !symbol.startsWith('^');

async function eodhdGet(pathAndQuery) {
  const url = `https://eodhd.com/api/${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}api_token=${encodeURIComponent(EODHD_KEY)}&fmt=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error('EODHD rejected the API key (check EODHD_API_KEY)');
  if (res.status === 402 || res.status === 429) throw new Error('EODHD daily request limit reached for this API key');
  if (res.status === 404) throw new Error('EODHD has no data for this ticker');
  if (!res.ok) throw new Error(`EODHD HTTP ${res.status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { throw new Error('EODHD returned an unexpected response: ' + text.slice(0, 120)); }
}

async function fetchEodhd(symbol, from, to) {
  const t = encodeURIComponent(toEodhd(symbol));
  const rows = await eodhdGet(`eod/${t}?from=${from}&to=${to}&period=d`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('EODHD returned no prices for this ticker and period');
  const out = { dates: [], close: [], adjclose: [], volume: [], dividends: [], splits: [], currency: 'PHP', name: toEodhd(symbol), provider: 'eodhd' };
  for (const r of rows) {
    if (r.close == null || !isFinite(r.close)) continue;
    out.dates.push(r.date); out.close.push(r.close); out.adjclose.push(r.adjusted_close ?? r.close); out.volume.push(r.volume ?? null);
  }
  if (EODHD_DIVIDENDS) {
    try {
      const divs = await eodhdGet(`div/${t}?from=${from}&to=${to}`);
      if (Array.isArray(divs)) for (const d of divs) { const v = d.unadjustedValue ?? d.value; if (d.date && v > 0) out.dividends.push({ date: d.date, amount: v }); }
    } catch (e) { console.warn(`EODHD dividends for ${symbol}:`, e.message); }
  }
  return out;
}

// ---------- Yahoo Finance v8 chart endpoint ----------
async function fetchYahoo(symbol, from, to) {
  const p1 = toUnix(from);
  const p2 = toUnix(to) + 86400;
  const qs = `period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const host = hosts[attempt % 2];
    try {
      const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (res.status === 429) { lastErr = new Error('Rate limited by Yahoo (429)'); await sleep(1500 * (attempt + 1)); continue; }
      const json = await res.json().catch(() => null);
      if (!json || !json.chart) throw new Error(`HTTP ${res.status}`);
      if (json.chart.error) throw new Error(json.chart.error.description || json.chart.error.code);
      return parseChart(json.chart.result[0]);
    } catch (e) {
      lastErr = e;
      if (/Not Found|No data found|delisted/i.test(e.message)) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

function parseChart(r) {
  const off = (r.meta && r.meta.gmtoffset) || 28800; // Asia/Manila
  const ts = r.timestamp || [];
  const q = (r.indicators.quote && r.indicators.quote[0]) || {};
  const adj = (r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || q.close || [];
  const toDate = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const out = { dates: [], close: [], adjclose: [], volume: [], dividends: [], splits: [], currency: r.meta && r.meta.currency, name: r.meta && (r.meta.longName || r.meta.shortName) };
  const seen = new Set();
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null || !isFinite(c)) continue;
    const d = toDate(ts[i]);
    if (seen.has(d)) { // Yahoo sometimes repeats the live bar; keep the last value
      const k = out.dates.length - 1; out.close[k] = c; out.adjclose[k] = adj[i] ?? c; continue;
    }
    seen.add(d);
    out.dates.push(d); out.close.push(c); out.adjclose.push(adj[i] ?? c); out.volume.push(q.volume ? q.volume[i] : null);
  }
  const ev = r.events || {};
  for (const k of Object.keys(ev.dividends || {})) out.dividends.push({ date: toDate(ev.dividends[k].date), amount: ev.dividends[k].amount });
  for (const k of Object.keys(ev.splits || {})) out.splits.push({ date: toDate(ev.splits[k].date), ratio: `${ev.splits[k].numerator}:${ev.splits[k].denominator}` });
  out.dividends.sort((a, b) => a.date.localeCompare(b.date));
  out.splits.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

// ---------- cache ----------
const cacheFile = (s) => path.join(CACHE_DIR, s.replace(/[^A-Za-z0-9_.\-]/g, '_') + '.json');
function readCache(symbol) {
  if (!cacheOk) return null;
  try { return JSON.parse(fs.readFileSync(cacheFile(symbol), 'utf8')); } catch { return null; }
}
function cacheCovers(c, from, to) {
  if (!c) return false;
  const fresh = (Date.now() - c.fetchedAt) / 3.6e6 < CACHE_TTL_HOURS;
  // Past prices never change: reuse if the cache spans the range, or if it was
  // fetched recently (the requested end date may be a holiday / not yet traded).
  return c.from <= from && (c.to >= to || fresh);
}

async function getHistory(symbol, from, to) {
  if (DEMO) {
    if (!demoHistory) ({ demoHistory } = await import('./public/js/demo-prices.mjs'));
    return { ...demoHistory(symbol, from, to), source: 'demo' };
  }
  const c = readCache(symbol);
  if (c && cacheCovers(c, from, to)) return { ...slice(c.data, from, to), source: 'cache' };
  const fFrom = c && c.from < from ? c.from : from;
  let data;
  if (useEodhd(symbol)) {
    try { data = await fetchEodhd(symbol, fFrom, to); }
    catch (e) {
      try { data = await fetchYahoo(symbol, fFrom, to); data.provider = 'yahoo'; }
      catch { throw e; } // report the EODHD reason: it is the source that should have worked
    }
  } else {
    try { data = await fetchYahoo(symbol, fFrom, to); data.provider = 'yahoo'; }
    catch (e) {
      if (/No data found|delisted|Not Found/i.test(e.message) && /\.PS$/.test(symbol) && !/^PSEI\./.test(symbol))
        throw new Error('Yahoo Finance no longer carries Philippine stocks. Add a Price_History sheet to the workbook, or set EODHD_API_KEY on the server.');
      throw e;
    }
  }
  const lastDate = data.dates[data.dates.length - 1] || fFrom;
  if (cacheOk) {
    try { fs.writeFileSync(cacheFile(symbol), JSON.stringify({ from: fFrom, to: lastDate < to ? lastDate : to, fetchedAt: Date.now(), data })); }
    catch (e) { console.warn('Cache write failed:', e.message); }
  }
  return { ...slice(data, from, to), source: data.provider || 'yahoo' };
}

function slice(d, from, to) {
  const idx = d.dates.map((x, i) => (x >= from && x <= to ? i : -1)).filter((i) => i >= 0);
  const pick = (a) => idx.map((i) => a[i]);
  return {
    ...d,
    dates: pick(d.dates), close: pick(d.close), adjclose: pick(d.adjclose), volume: pick(d.volume || []),
    dividends: d.dividends.filter((x) => x.date >= from && x.date <= to),
    splits: d.splits.filter((x) => x.date >= from && x.date <= to),
  };
}

// ---------- API ----------
// POST /api/history  { symbols: ["BDO.PS","PSEI.PS"], from: "2022-01-01", to: "2026-09-30" }
app.post('/api/history', async (req, res) => {
  const { symbols, from, to } = req.body || {};
  if (!Array.isArray(symbols) || !symbols.length || symbols.length > 400) return res.status(400).json({ error: 'symbols must be a non-empty array (max 400)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  const clean = [...new Set(symbols.map((s) => String(s).trim().toUpperCase()))];
  const bad = clean.filter((s) => !SYMBOL_RE.test(s));
  if (bad.length) return res.status(400).json({ error: 'Invalid symbols: ' + bad.join(', ') });

  const data = {}; const errors = {};
  let i = 0;
  async function worker() {
    while (i < clean.length) {
      const s = clean[i++];
      try { data[s] = await getHistory(s, from, to); }
      catch (e) { errors[s] = e.message || String(e); }
      if (!DEMO) await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clean.length) }, worker));
  res.json({ mode: DEMO ? 'demo' : 'live', data, errors });
});

// Vercel and other serverless hosts import this file and expect the Express app as the export.
module.exports = app;
Object.assign(module.exports, { parseChart, slice, start, fetchEodhd, getHistory });

app.get('/api/status', (req, res) => res.json({ mode: DEMO ? 'demo' : 'live', stockSource: DEMO ? 'demo' : EODHD_KEY ? 'eodhd' : 'yahoo', indexSource: 'yahoo' }));
app.get('/healthz', (req, res) => res.send('ok'));

function start() {
  return app.listen(PORT, () => {
  console.log(`PSE Portfolio Analytics running at http://localhost:${PORT}  [${DEMO ? 'DEMO synthetic data' : 'live Yahoo Finance data'}]`);
});
}
if (require.main === module) start();

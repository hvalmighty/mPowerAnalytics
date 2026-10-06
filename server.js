// PSE Portfolio Risk & Performance — backend
// Serves the browser app and fetches daily price history from Yahoo Finance
// for Philippine Stock Exchange tickers (Yahoo suffix ".PS"), with a file cache.
//
//   npm start            -> live Yahoo Finance data
//   DEMO=1 npm start     -> synthetic prices (offline testing only, clearly flagged in the UI)

const express = require('express');
const path = require('path');
const fs = require('fs');
const { demoHistory } = require('./lib/demo');

const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO === '1';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 12);
const CONCURRENCY = Number(process.env.YAHOO_CONCURRENCY || 3);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/xlsx', express.static(path.join(__dirname, 'node_modules/xlsx/dist')));
app.use('/vendor/chartjs', express.static(path.join(__dirname, 'node_modules/chart.js/dist')));

const toUnix = (d) => Math.floor(new Date(d + 'T00:00:00Z').getTime() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SYMBOL_RE = /^[A-Z0-9^.\-=]{1,20}$/;

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
  if (DEMO) return { ...demoHistory(symbol, from, to), source: 'demo' };
  const c = readCache(symbol);
  if (c && cacheCovers(c, from, to)) return { ...slice(c.data, from, to), source: 'cache' };
  const fFrom = c && c.from < from ? c.from : from;
  const data = await fetchYahoo(symbol, fFrom, to);
  const lastDate = data.dates[data.dates.length - 1] || fFrom;
  fs.writeFileSync(cacheFile(symbol), JSON.stringify({ from: fFrom, to: lastDate < to ? lastDate : to, fetchedAt: Date.now(), data }));
  return { ...slice(data, from, to), source: 'yahoo' };
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

module.exports = { parseChart, slice };

app.get('/api/status', (req, res) => res.json({ mode: DEMO ? 'demo' : 'live' }));

if (require.main === module) app.listen(PORT, () => {
  console.log(`PSE Portfolio Analytics running at http://localhost:${PORT}  [${DEMO ? 'DEMO synthetic data' : 'live Yahoo Finance data'}]`);
});

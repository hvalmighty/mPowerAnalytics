// Synthetic price generator for offline testing (DEMO=1). NOT market data.
// Deterministic: the same symbol/date always gives the same price.
// One-factor + sector-factor model with fat tails and stress windows, so the
// risk/performance engines have something realistic-looking to chew on.

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rand(seed) { // mulberry32 single draw
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function normal(seed) {
  const u = Math.max(rand(seed), 1e-12), v = rand(seed ^ 0x9e3779b9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// listing dates for recent IPOs so the "short history" logic gets exercised
const LISTED = { 'AREIT.PS': '2020-08-13', 'MONDE.PS': '2021-06-01', 'RCR.PS': '2021-09-14', 'MYNLD.PS': '2026-03-10', 'CNVRG.PS': '2020-10-26' };
const EPOCH = '2005-01-03';
// Rough price levels around Sep-2025 so the sample workbook's cash arithmetic is sensible in demo mode.
// Approximate only; demo prices are synthetic regardless.
const REF_DATE = '2025-09-30';
const REF = { 'PSEI.PS': 6000, 'BDO.PS': 140, 'BPI.PS': 120, 'MBT.PS': 70, 'CBC.PS': 65, 'ICT.PS': 450, 'SM.PS': 800, 'AC.PS': 560,
  'JGS.PS': 25, 'ALI.PS': 25, 'SMPH.PS': 22, 'AREIT.PS': 38, 'JFC.PS': 200, 'URC.PS': 80, 'MER.PS': 530, 'TEL.PS': 1300, 'GLO.PS': 1800,
  'CNVRG.PS': 15, 'SCC.PS': 30, 'PLUS.PS': 35, 'AEV.PS': 35, 'AGI.PS': 7, 'ACEN.PS': 3.5, 'CNPF.PS': 38, 'DMC.PS': 9, 'EMI.PS': 17,
  'GTCAP.PS': 600, 'LTG.PS': 10, 'MONDE.PS': 8, 'PGOLD.PS': 30, 'SMC.PS': 75, 'RCR.PS': 6, 'MYNLD.PS': 20 };

function businessDays(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function stressDrift(date) {
  if (date >= '2008-09-10' && date <= '2008-10-27') return -0.006;
  if (date >= '2020-02-19' && date <= '2020-03-19') return -0.012;
  if (date >= '2022-09-01' && date <= '2022-10-10') return -0.003;
  return 0;
}

function demoHistory(symbol, from, to) {
  const days = businessDays(EPOCH, to);
  const isIndex = symbol.startsWith('PSEI') || symbol.startsWith('^');
  const h = hash(symbol);
  const sector = h % 6;
  const beta = isIndex ? 1 : 0.6 + (h % 70) / 100;          // 0.6 – 1.3
  const idio = isIndex ? 0 : 0.008 + ((h >> 8) % 12) / 1000; // 0.8% – 1.9% daily
  const mu = isIndex ? 0.00012 : (((h >> 4) % 9) - 3) / 20000;
  let p = isIndex ? 2000 : 5 + ((h >> 12) % 600);
  const listed = LISTED[symbol] || EPOCH;
  const yieldPct = isIndex ? 0 : 0.01 + ((h >> 16) % 30) / 1000;

  const dates = [], close = [], dividends = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const di = hash(d);
    const m = 0.0105 * (rand(di ^ 77) < 0.03 ? 2.5 : 1) * normal(di) + stressDrift(d);
    const s = 0.006 * normal(di ^ (sector * 7919 + 13));
    const e = idio * normal(di ^ h);
    const r = mu + beta * m + (isIndex ? 0 : s + e);
    p = p * Math.exp(Math.max(-0.25, Math.min(0.25, r)));
    if (d < listed) continue;
    dates.push(d); close.push(+p.toFixed(p < 10 ? 4 : 2));
    if (!isIndex && d.slice(5, 7) === '05' && i > 0 && days[i - 1].slice(5, 7) === '04') {
      dividends.push({ date: d, amount: +(p * yieldPct).toFixed(4) });
    }
  }
  if (REF[symbol]) {
    let r = -1; for (let i = 0; i < dates.length; i++) if (dates[i] <= REF_DATE) r = i;
    const f = REF[symbol] / (r >= 0 ? close[r] : close[0]);
    for (let i = 0; i < close.length; i++) close[i] = +(close[i] * f).toFixed(close[i] * f < 10 ? 4 : 2);
    dividends.forEach((d) => (d.amount = +(d.amount * f).toFixed(4)));
  }
  // dividend-adjusted close (Yahoo-style backward adjustment)
  const adjclose = close.slice();
  let f = 1, k = dividends.length - 1;
  for (let i = close.length - 1; i >= 0; i--) {
    adjclose[i] = close[i] * f;
    while (k >= 0 && dividends[k].date === dates[i]) { if (i > 0) f *= 1 - dividends[k].amount / close[i - 1]; k--; }
  }
  const idx = dates.map((x, i) => (x >= from && x <= to ? i : -1)).filter((i) => i >= 0);
  return {
    dates: idx.map((i) => dates[i]), close: idx.map((i) => close[i]), adjclose: idx.map((i) => +adjclose[i].toFixed(4)),
    volume: [], dividends: dividends.filter((x) => x.date >= from && x.date <= to), splits: [],
    currency: 'PHP', name: symbol + ' (synthetic)',
  };
}

export { demoHistory };

// Numeric helpers: statistics, linear algebra, distributions, RNG, IRR.

export const sum = (a) => a.reduce((s, x) => s + x, 0);
export const mean = (a) => (a.length ? sum(a) / a.length : NaN);
export function std(a, ddof = 1) {
  if (a.length <= ddof) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof));
}
export function covariance(x, y) {
  const mx = mean(x), my = mean(y);
  let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (x.length - 1);
}

// Linear-interpolated quantile (Excel PERCENTILE.INC)
export function quantile(arr, p) {
  const a = Float64Array.from(arr).sort();
  if (!a.length) return NaN;
  const h = (a.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return a[lo] + (h - lo) * (a[hi] - a[lo]);
}

// Sample covariance matrix of returns: R is T x N (array of rows)
export function covMatrix(R) {
  const T = R.length, N = R[0].length;
  const mu = new Array(N).fill(0);
  for (const row of R) for (let j = 0; j < N; j++) mu[j] += row[j] / T;
  const C = Array.from({ length: N }, () => new Array(N).fill(0));
  for (const row of R) for (let i = 0; i < N; i++) { const di = row[i] - mu[i]; for (let j = i; j < N; j++) C[i][j] += di * (row[j] - mu[j]); }
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { C[i][j] /= T - 1; C[j][i] = C[i][j]; }
  return C;
}

// RiskMetrics EWMA covariance (zero-mean), oldest row first
export function ewmaCov(R, lambda = 0.94) {
  const T = R.length, N = R[0].length;
  const C = Array.from({ length: N }, () => new Array(N).fill(0));
  let wsum = 0;
  for (let t = 0; t < T; t++) {
    const w = Math.pow(lambda, T - 1 - t); wsum += w;
    const row = R[t];
    for (let i = 0; i < N; i++) for (let j = i; j < N; j++) C[i][j] += w * row[i] * row[j];
  }
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { C[i][j] /= wsum; C[j][i] = C[i][j]; }
  return C;
}

export const matVec = (M, v) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
export const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

// Cholesky with diagonal jitter if the matrix is not positive definite
export function cholesky(A) {
  const n = A.length;
  for (let attempt = 0; attempt < 6; attempt++) {
    const jitter = attempt === 0 ? 0 : 1e-10 * Math.pow(10, attempt) * mean(A.map((r, i) => r[i]));
    const L = Array.from({ length: n }, () => new Array(n).fill(0));
    let ok = true;
    for (let i = 0; i < n && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = A[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) { ok = false; break; } L[i][i] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
    }
    if (ok) return L;
  }
  throw new Error('Covariance matrix is not positive definite');
}

// Standard normal CDF / PDF / inverse (Acklam)
export const normPdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = normPdf(x);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
export function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  const q = p - 0.5, r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Chi-square(1) survival function, for the Kupiec test
export const chi2sf1 = (x) => (x <= 0 ? 1 : 2 * (1 - normCdf(Math.sqrt(x))));

// Seeded RNG (mulberry32) + Box–Muller, so Monte Carlo results are reproducible
export function makeRng(seed = 42) {
  let s = seed >>> 0; let spare = null;
  const uni = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const norm = () => {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0; while (u === 0) u = uni();
    const v = uni(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return { uni, norm };
}

// XIRR: flows = [{date:'YYYY-MM-DD', amount}] (investor perspective: contributions negative)
export function xirr(flows) {
  if (flows.length < 2) return NaN;
  const t0 = new Date(flows[0].date).getTime();
  const yrs = flows.map((f) => (new Date(f.date).getTime() - t0) / (365 * 864e5));
  const npv = (r) => flows.reduce((s, f, i) => s + f.amount / Math.pow(1 + r, yrs[i]), 0);
  let lo = -0.9999, hi = 10;
  if (npv(lo) * npv(hi) > 0) return NaN;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export const compound = (rets) => rets.reduce((p, r) => p * (1 + r), 1) - 1;

# PSE Portfolio Analytics

A JavaScript app that reads a PMS export in Excel for a Philippine-listed equity portfolio. It fetches daily prices from Yahoo Finance and produces four reports:

- **VaR & Risk**: historical, parametric and Monte Carlo VaR, plus Expected Shortfall at each confidence level and horizon. It also shows component, marginal and incremental VaR by position and by sector, a correlation matrix, historical and hypothetical stress tests, and a backtest with the Kupiec test and Basel traffic-light zone.
- **Performance**: daily time-weighted return (net and gross of fees), XIRR, and returns by period and by month. Also Sharpe, Sortino, max drawdown, Calmar, beta, alpha, tracking error, information ratio and up/down capture, plus contribution to return by security and by sector (Carino-linked).
- **Attribution**: Brinson-Fachler allocation, selection and interaction effects by PSE sector. Effects are computed daily and Carino-linked, so they add up exactly to the active return. Includes a monthly breakdown.
- **Data quality**: price coverage per symbol, gaps and stale prices, positions rolled forward and reconciled to the closing PMS snapshot, PMS-vs-Yahoo price checks, the trades applied and the dividends credited.

Every report can be exported to Excel (13 sheets, including daily NAV) or printed to PDF.

## Run it on your own computer (best way to test with real prices)

1. Install **Node.js LTS** from https://nodejs.org (one-time).
2. Unzip this folder.
3. Double-click **start-windows.bat** (Windows) or **start-mac.command** (Mac). The first run installs packages, then opens http://localhost:3000.
4. Click **Run with sample portfolio**, or upload your PMS export and click **Generate reports**.

From a terminal the same thing is `npm install` then `npm start`. Use `npm run demo` for synthetic prices with no internet (a red banner says so).

Optional environment variables: `PORT`, `CACHE_TTL_HOURS` (default 12), `YAHOO_CONCURRENCY` (default 3).

## Host it so others can use it

The app is one small Node.js server, so any Node host works. Two easy routes:

**Render.com (free tier)**
1. Create a GitHub repository and upload the contents of this folder (GitHub's "Add file → Upload files" works; skip `node_modules`).
2. On https://render.com, sign in with GitHub, then **New + → Blueprint** and pick the repository. `render.yaml` sets everything up.
3. When the build finishes, Render gives you a URL such as `https://pse-portfolio-analytics.onrender.com`.

The free tier sleeps after 15 minutes idle, so the first request takes about a minute. Its disk is temporary, so the price cache resets on each restart.

**Vercel**
1. Push this folder to GitHub with `server.js`, `package.json` and `vercel.json` at the repository root, not inside a subfolder.
2. On vercel.com choose **Add New → Project**, import the repository, and keep the defaults (Framework: Other). If the files sit in a subfolder, set **Root Directory** to that folder.
3. Deploy, then open `https://<your-app>.vercel.app/healthz`. It should show `ok`.

On Vercel the server runs as a serverless function: the price cache lives in `/tmp` and is lost between cold starts. The browser asks for prices in small batches to stay within Vercel's time limit.

**Any server with Docker** (a company VM, AWS Lightsail, Azure App Service, Google Cloud Run):
```bash
docker build -t pse-analytics .
docker run -d -p 3000:3000 --name pse-analytics pse-analytics
```

**Before hosting, check:**
- **Yahoo and cloud servers.** Yahoo sometimes rate-limits or blocks requests from cloud data centres. If prices fail on the hosted copy but work on your computer, that is the cause. Run it on an office machine, or switch to a licensed data feed.
- **No login.** The app has no sign-in. Anyone with the URL can use it. Uploaded files are processed in the user's browser and never stored on the server, but put it behind your company's access control (VPN, SSO proxy, or Render's IP allow-list on paid plans) before using real client data.

## Single-file test build

`npm run build-hosted` writes `dist/pse-portfolio-analytics.html`. It is a self-contained page with synthetic prices and the sample workbook embedded, and it needs no server, so it is useful for demos. It cannot fetch real prices, because browsers block calls to Yahoo from a web page.

## How prices are fetched

- Each PSE ticker in Holdings, Transactions and Benchmark_Constituents is mapped to Yahoo as `TICKER.PS` (BDO → `BDO.PS`). Any listed PSE stock works the same way. To use a different Yahoo symbol, add a `Yahoo_Symbol` column.
- The benchmark index is `PSEI.PS`; you can change it in Portfolio_Info.
- The server (`server.js`) calls Yahoo's v8 chart endpoint and caches each symbol in `cache/`. Later runs only re-download recent data. The browser never calls Yahoo directly, because CORS restrictions would block it.
- Valuation uses Yahoo's close, which is split-adjusted but not dividend-adjusted. Dividends are credited as cash on the ex-date. VaR returns use the dividend-adjusted close.
- History fetched covers the VaR lookback plus the backtest window (about 3 years with the defaults), plus any historical stress windows you list (the sample includes 2008 and 2020).

## Input workbook

| Sheet | Required | Contents |
|---|---|---|
| Portfolio_Info | yes | Valuation_Date, Period_Start/End, benchmark, VaR settings (confidence levels, horizons, lookback, EWMA λ, MC paths, backtest days), risk-free rate, Auto_Dividends_From_Yahoo |
| Holdings | yes | Snapshot_Date, PSE_Ticker, Security_Name, Sector, Quantity, and optional ISIN / Avg_Cost / PMS_Price / Market_Value. Cash is a row with ticker `CASH`. |
| Transactions | for trading in the period | Trade_Date, PSE_Ticker, Type (BUY / SELL / DIVIDEND / FEE / INTEREST / STOCK_DIVIDEND), Quantity, Price (leave blank to use the Yahoo close), Fees, Net_Amount |
| Cash_Flows | if the client added or withdrew money | Date, Amount, Type (Contribution / Withdrawal) |
| Benchmark_Constituents | for attribution | PSE_Ticker, Sector, Weight at Period_Start |
| Stress_Scenarios | optional | HISTORICAL rows (Start_Date to End_Date) or SHOCK rows (Target = ALL, a sector, or a ticker; Shock_%) |
| Price_Override | optional | Manual prices for suspended or illiquid names |

How positions are built:

- **Opening positions** come from the Holdings snapshot dated on or before Period_Start. They are rolled forward day by day with Transactions.
- **Closing snapshot (optional):** a snapshot dated later is used to reconcile the rolled-forward positions.
- **No opening snapshot:** if only a closing snapshot exists, opening positions are derived by reversing the transactions.

Column headers are matched loosely, so for example `Ticker`, `Symbol` or `Stock Code` all work.

## Methodology notes

- **TWR:** rₜ = (Vₜ − Vₜ₋₁ − CFₜ) / Vₜ₋₁, with client flows assumed at the end of the day, chain-linked daily. Periods shorter than one year are not annualised.
- **Historical VaR:** today's positions revalued with each of the last N days' returns. VaR is taken at the PERCENTILE.INC quantile.
- **Parametric VaR:** z·√(MVᵀΣMV), with Σ from EWMA (RiskMetrics) or the sample covariance.
- **Monte Carlo VaR:** seeded Cholesky simulation, so results are reproducible.
- **Multi-day horizons:** √T scaling.
- **Missing returns** (recent IPOs, suspensions) are filled with the benchmark return and flagged.
- **Attribution benchmark:** constituents held buy-and-hold from the Period_Start weights. Mid-period PSEi rebalances are not replayed, so the report shows the gap to the official index.
  - **Cash** is its own segment, benchmarked at 0%. A cash cushion or drag therefore shows up as allocation, and fees and interest as selection.

## Limitations to know about

- **Yahoo Finance is unofficial.** There is no SLA, and Yahoo can rate-limit, change the endpoint, or have gaps for thinly traded PSE names. Its terms restrict commercial redistribution. Use it for internal analysis, and use a licensed feed or your PMS prices for client reporting.
- **PSEi is a price index.** A portfolio that receives dividends has a small structural edge over it. Set `Benchmark_Return_Type = TOTAL` to use dividend-adjusted constituent prices in attribution.
- **Stock splits and stock dividends** inside the period: Yahoo back-adjusts prices. Record the share change as `STOCK_DIVIDEND`; the app warns when Yahoo reports a split on a stock you hold.
- **Currency:** PHP only. No FX conversion and no FX risk.
- **Sample data:** the weights, quantities, fees and sector labels in the sample workbook are illustrative. Replace the benchmark weights with official PSE index weights.
- **SheetJS version:** the app uses SheetJS 0.18.5 from npm. SheetJS now publishes newer builds only on its own CDN. For production, install `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`; the API is the same.

## Files

```
server.js              Express server, Yahoo fetch + file cache, /api/history
demo.js                starts the server with synthetic prices
public/js/demo-prices.mjs  synthetic price generator (demo mode and test build)
Dockerfile, render.yaml, vercel.json    hosting
start-windows.bat, start-mac.command  double-click launchers
tools/build_hosted.mjs single-file test build
public/index.html      UI
public/vendor/         SheetJS and Chart.js (copied from node_modules by `npm run vendor`)
public/js/parser.js    Excel → data model, validation
public/js/data.js      price alignment, daily book (positions, cash, P&L), data quality
public/js/risk.js      VaR / ES / decomposition / stress / backtest
public/js/performance.js  TWR, XIRR, statistics, contribution
public/js/attribution.js  Brinson-Fachler + Carino linking
public/js/report.js    tables and charts (Chart.js)
public/sample/PSE_Portfolio_Sample.xlsx   input template with a sample portfolio
tools/make_sample.py   regenerates the sample workbook
```

Every intermediate result can be inspected in the browser console as `window.pseReport`.

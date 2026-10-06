# PSE Portfolio Analytics

A JavaScript app that reads a PMS export in Excel for a Philippine-listed equity portfolio. It fetches daily prices from Yahoo Finance and produces four reports:

- **VaR & Risk**: historical, parametric and Monte Carlo VaR, plus Expected Shortfall at each confidence level and horizon. It also shows component, marginal and incremental VaR by position and by sector, a correlation matrix, historical and hypothetical stress tests, and a backtest with the Kupiec test and Basel traffic-light zone.
- **Performance**: daily time-weighted return (net and gross of fees), XIRR, and returns by period and by month. Also Sharpe, Sortino, max drawdown, Calmar, beta, alpha, tracking error, information ratio and up/down capture, plus contribution to return by security and by sector (Carino-linked).
- **Attribution**: Brinson-Fachler allocation, selection and interaction effects by PSE sector. Effects are computed daily and Carino-linked, so they add up exactly to the active return. Includes a monthly breakdown.
- **Data quality**: price coverage per symbol, gaps and stale prices, positions rolled forward and reconciled to the closing PMS snapshot, PMS-vs-Yahoo price checks, the trades applied and the dividends credited.

Every report can be exported to Excel (13 sheets, including daily NAV) or printed to PDF.

## Run it

Requires Node.js 18 or later and internet access to `query1/query2.finance.yahoo.com`.

```bash
npm install
npm start            # http://localhost:3000  (live Yahoo Finance prices)
```

Open the page, click **Download sample workbook**, then upload it (or your own PMS export) and click **Generate reports**.

```bash
npm run demo         # offline mode with SYNTHETIC prices, for testing only
```

Demo mode shows a red banner and badge. Its prices are generated and are not market data.

Optional environment variables: `PORT`, `CACHE_TTL_HOURS` (default 12), `YAHOO_CONCURRENCY` (default 3).

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
lib/demo.js            synthetic price generator (DEMO=1 only)
public/index.html      UI
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

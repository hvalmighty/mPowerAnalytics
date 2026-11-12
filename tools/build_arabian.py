"""Builds the Arabian portfolio (ALBFUND, USD base) from its holding statement.
Outputs:
  public/data/Portfolio_Arabian.xlsx          holdings in the mPower position-report layout
  public/data/arabian_data.json               USD price series for the holdings (simulated history
                                              anchored to the statement's 23-Sep-2026 prices) and the
                                              benchmark constituents
  public/data/Benchmark_MSCI_Arabian_IMI.xlsx benchmark workbook
Benchmark: MSCI Arabian Markets IMI Index (USD), factsheet as of 30-Oct-2026. Only the top-10
constituents that have price data in the statement are used, with their weights rescaled to 100%.
No benchmark prices are simulated: the benchmark has no price history, so benchmark returns and
attribution are not computed until history is supplied.
Run: python3 tools/build_arabian.py <Holding_Statement.xls>"""
import sys, json, math, random, zlib, datetime, statistics
from pathlib import Path
import xlrd, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent.parent
OUT_XLSX = ROOT / "public/data/Portfolio_Arabian.xlsx"
OUT_JSON = ROOT / "public/data/arabian_data.json"
OUT_BM = ROOT / "public/data/Benchmark_MSCI_Arabian_IMI.xlsx"
VAL_DATE = datetime.date(2026, 9, 23)
START = datetime.date(2023, 8, 1)          # history start: ~3 years of weekdays, enough for a 500-day lookback + 250-day backtest
REPORT_START = "2025-09-23"               # performance is reported from here; earlier history is simulated (VaR and backtest only)
BAND = 0.10                               # holdings stay within +/-10% of their statement price
HDR_FILL = PatternFill("solid", fgColor="19395C"); HDR_FONT = Font(bold=True, color="FFFFFF")

SECTOR = {
 "ADC":"Financials","ADI":"Financials","FAB":"Financials","ALR":"Financials","SNB":"Financials",
 "NBK":"Financials","BKM":"Financials","SIB":"Financials","BMS":"Financials","SOH":"Financials",
 "TAW":"Financials","MNT":"Financials",
 "ADG":"Energy","ADL":"Energy",
 "EEC":"Communication Services",
 "ALD":"Real Estate","EMD":"Real Estate","EMR":"Real Estate","UAQ":"Real Estate",
 "DTX":"Industrials","EIC":"Industrials","EPI":"Industrials","PKN":"Industrials","UIT":"Industrials",
 "NMC":"Health Care","SAH":"Health Care",
 "PRS":"Information Technology","RSN":"Information Technology",
}
SIGMA = {"Financials":0.22,"Energy":0.26,"Communication Services":0.20,"Real Estate":0.28,
         "Industrials":0.24,"Health Care":0.22,"Information Technology":0.36}

# MSCI Arabian Markets Index (USD): the 10 constituents from the supplied factsheet.
# ticker, statement code (None = not in the statement), name, country, currency, sector, index weight %, float adj mkt cap USD bn
TOP10 = [
 ("ALR", "ALR", "Al Rajhi Banking & Investment", "Saudi Arabia", "SAR", "Financials", 14.59, 95.53),
 ("ARAMCO", None, "Saudi Aramco", "Saudi Arabia", "SAR", "Energy", 6.38, 41.79),
 ("SNB", "SNB", "Saudi National Bank", "Saudi Arabia", "SAR", "Financials", 5.48, 35.87),
 ("KFH", None, "Kuwait Finance House", "Kuwait", "KWD", "Financials", 4.19, 27.40),
 ("NBK", "NBK", "National Bank of Kuwait", "Kuwait", "KWD", "Financials", 3.61, 23.62),
 ("FAB", "FAB", "First Abu Dhabi Bank", "United Arab Emirates", "AED", "Financials", 3.40, 22.28),
 ("STC", None, "Saudi Telecom Co", "Saudi Arabia", "SAR", "Communication Services", 3.35, 21.94),
 ("ETEC", None, "Emirates Telecommunications Group", "United Arab Emirates", "AED", "Communication Services", 3.03, 19.83),
 ("QNBK", None, "Qatar National Bank", "Qatar", "QAR", "Financials", 3.02, 19.76),
 ("EMR", "EMR", "Emaar Properties", "United Arab Emirates", "AED", "Real Estate", 2.93, 19.17),
]
FACTSHEET_TOTAL = 49.98  # sum of the 10 index weights as published

def read_statement(path):
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    pf_label = None; rows = []; hdr = None
    for r in range(sh.nrows):
        v = sh.row_values(r)
        if str(v[0]).strip() == "Security" and "Security Name" in str(v[1]): hdr = r
        if str(v[2]).strip().startswith("ALBFUND"): pf_label = str(v[2]).strip()
    for r in range(hdr + 2, sh.nrows):
        v = sh.row_values(r)
        code = str(v[0]).strip()
        if not code or code.endswith("Total :") or "Asset Class" in code: continue
        if code in ("Cash/NCA", "Net Asset Value") or code.startswith(("*", "Valuation", "Page")): continue
        if not isinstance(v[4], str) or not v[4]: continue
        rows.append(dict(code=code, name=str(v[1]).strip(), ccy=str(v[4]).strip().upper(), isin=str(v[5]).strip(),
                         qty=float(v[7]), avg=float(v[10]), book_tx=float(v[11]), price=float(v[13]),
                         mv_tx=float(v[14]), mv_usd=float(v[15]), book_usd=float(v[12])))
    return pf_label, rows

BENCH_DRIFT = 0.05   # assumed annual drift of the benchmark constituents (stated assumption, not a market figure)
APPROX_LEVEL = {"ARAMCO": 27.0, "KFH": 0.75, "STC": 40.0, "ETEC": 14.0, "QNBK": 17.5}  # local, unverified

def main(path):
    pf_label, rows = read_statement(path)
    fx = {"USD": 1.0}
    for ccy in sorted({r["ccy"] for r in rows if r["ccy"] != "USD"}):
        fx[ccy] = 1.0 / statistics.median([r["mv_tx"] / r["mv_usd"] for r in rows if r["ccy"] == ccy])  # USD per unit
    fx["QAR"] = 1 / 3.64   # not in the statement: standard peg
    px_of = {r["code"]: r for r in rows}

    # ---------- benchmark: top-10 constituents with price data, rescaled to 100% ----------
    # All 10 supplied constituents; weights reconstituted to 100% in proportion to the published weights.
    bm = [dict(ticker=t[0], name=t[2], country=t[3], currency=t[4], sector=t[5], fact_w=t[6], cap=t[7],
               weight=t[6] / FACTSHEET_TOTAL, local_px=(px_of[t[1]]["price"] if t[1] in px_of else None),
               held=(t[1] in px_of),
               status=("Statement price 23-Sep-2026 only (no history)" if t[1] in px_of else "No price data")) for t in TOP10]
    assert abs(sum(b["weight"] for b in bm) - 1) < 1e-9

    # ---------- holdings price history (simulated, anchored to the statement prices) ----------
    dates = []; d = START
    while d <= VAL_DATE:
        if d.weekday() < 5: dates.append(d.isoformat())
        d += datetime.timedelta(days=1)
    n = len(dates)
    def simulate_bounded(key, anchor_local, sector, fx_rate):
        """Holdings: a daily random path kept within +/-BAND of the statement price, ending on it."""
        rng = random.Random(zlib.crc32(("H:" + key).encode()))
        s = SIGMA.get(sector, 0.24) / math.sqrt(252)
        lo, hi = anchor_local * (1 - BAND), anchor_local * (1 + BAND)
        p = [anchor_local * (1 + rng.uniform(-BAND, BAND))]
        for _ in range(n - 1):
            x = p[-1] * math.exp(rng.gauss(0, s))
            while x < lo or x > hi:          # reflect back into the band
                x = 2 * lo - x if x < lo else 2 * hi - x
            p.append(x)
        p[-1] = anchor_local                  # the valuation-date price is the statement price
        return [round(x * fx_rate, 6) for x in p]   # USD

    def simulate(key, anchor_local, sector, fx_rate, drift=0.0):
        rng = random.Random(zlib.crc32(key.encode()))
        s = SIGMA.get(sector, 0.24) / math.sqrt(252)
        mu = math.log(1 + drift) / 252
        lvl = [1.0]
        for _ in range(n - 1): lvl.append(lvl[-1] * math.exp(mu + rng.gauss(0, s)))
        scale = anchor_local / lvl[-1]
        return [round(x * scale * fx_rate, 6) for x in lvl]   # USD
    series = {}
    holding_rows = []
    for r in rows:
        sec = SECTOR[r["code"]]
        series[r["code"]] = simulate_bounded(r["code"], r["price"], sec, fx[r["ccy"]])
        holding_rows.append(r | {"sector": sec})


    # benchmark constituents: simulated with the stated drift, anchored to the statement price or the approximate level
    bm_series = {}
    for b in bm:
        key = "BM:" + b["ticker"]
        anchor = b["local_px"] if b["local_px"] is not None else APPROX_LEVEL[b["ticker"]]
        bm_series[key] = simulate(key, anchor, b["sector"], fx[b["currency"]], drift=BENCH_DRIFT)
        b["key"] = key
        b["status"] = ("Simulated: statement price 23-Sep-2026 anchor, %d%% p.a. drift assumption" % round(BENCH_DRIFT * 100)
                       if b["held"] else "Simulated: approximate level (unverified) anchor, %d%% p.a. drift assumption" % round(BENCH_DRIFT * 100))
    index = [0.0] * n
    for b in bm:
        p = bm_series[b["key"]]
        for i in range(n): index[i] += b["weight"] * p[i] / p[0]
    series.update(bm_series)
    series["MSCIAM"] = [round(100 * x, 6) for x in index]

    OUT_JSON.write_text(json.dumps({
        "source": "Holding statement " + path.split("/")[-1] + "; holdings history simulated within +/-10% of statement prices before 2025-09-23 and for the report period (VaR/backtest history)",
        "base": "USD", "valuationDate": VAL_DATE.isoformat(), "reportStart": REPORT_START, "fx": fx,
        "dates": dates, "series": series,
        "benchmarkAssumptions": {"annualDrift": BENCH_DRIFT, "pricesSimulated": True, "note": "Benchmark prices simulated; no market history available"},
        "benchmark": {"id": "MSCIAM", "name": "MSCI Arabian Markets IMI Index (USD), top-10 constituents with price data",
                      "source": "MSCI Arabian Markets Index (USD) factsheet, top-10 constituents (supplied)", "priceHistory": True,
                      "constituents": [{"ticker": b["ticker"], "name": b["name"], "sector": b["sector"], "country": b["country"],
                                        "currency": b["currency"], "weight": round(b["weight"], 8), "factsheetWeight": b["fact_w"],
                                        "anchorLocal": b["local_px"] if b["local_px"] is not None else APPROX_LEVEL[b["ticker"]],
                                        "priceIsSimulated": b["local_px"] is None,
                                        "floatCapUsdBn": b["cap"], "priceStatus": b["status"], "yahoo": b["key"]} for b in bm]},
    }, separators=(",", ":")))
    write_benchmark_xlsx(bm, fx, dates, bm_series, series["MSCIAM"])

    # ---------- holdings workbook (mPower position-report layout; no cash line) ----------
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Holdings"
    hdr = ["Security", "Security Name", "Book Cost in Transaction Currency", "Market Value in Transaction Currency",
           "Portfolio", "Transaction Currency", "Quantity", "Market Price", "Sector", "Portfolio Currency",
           "Book Cost in Portfolio Currency", "Market Value in Portfolio Currency"]
    ws.append(hdr)
    for c in ws[1]: c.fill = HDR_FILL; c.font = HDR_FONT; c.alignment = Alignment(wrap_text=True)
    ws.append(["Asset Class:ORD - Ordinary Shares"]); ws.cell(row=2, column=1).font = Font(bold=True, color="19395C")
    for r in holding_rows:
        ws.append([r["code"], r["name"], r["book_tx"], r["mv_tx"], pf_label, r["ccy"], r["qty"], r["price"], r["sector"], "USD", r["book_usd"], r["mv_usd"]])
    for row in ws.iter_rows(min_row=3, min_col=3, max_col=4):
        for c in row: c.number_format = "#,##0.00"
    for i, w in enumerate([12, 36, 26, 30, 36, 14, 16, 12, 24, 16, 26, 30], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    wb.save(OUT_XLSX)
    print(f"wrote {OUT_XLSX} ({len(holding_rows)} holdings), {OUT_JSON}, {OUT_BM}")
    print("benchmark:", [(b["ticker"], round(b["weight"] * 100, 2)) for b in bm], "sum", round(sum(b["weight"] for b in bm), 6))

def write_benchmark_xlsx(bm, fx, dates, bm_series, index_series):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Benchmark_Constituents"
    hdr = ["Ticker", "Security Name", "Country", "Currency", "Sector", "Float Adj Mkt Cap (USD bn)", "Index Weight, Factsheet (%)",
           "Benchmark Weight, Reconstituted to 100% (%)", "Local Price 23-Sep-2026", "Price Data Status", "Held in ALBFUND"]
    ws.append(hdr)
    for c in ws[1]: c.fill = HDR_FILL; c.font = HDR_FONT; c.alignment = Alignment(wrap_text=True)
    first = 2
    for b in bm:
        ws.append([b["ticker"], b["name"], b["country"], b["currency"], b["sector"], b["cap"], b["fact_w"], None,
                   b["local_px"], b["status"], "Yes" if b["held"] else "No"])
    last = ws.max_row
    for r in range(first, last + 1):
        ws.cell(row=r, column=8, value=f"=G{r}/SUM($G${first}:$G${last})*100")
    ws.append(["TOTAL", "", "", "", "", f"=SUM(F{first}:F{last})", f"=SUM(G{first}:G{last})", f"=SUM(H{first}:H{last})"])
    ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    for row in ws.iter_rows(min_row=first, max_row=ws.max_row, min_col=6, max_col=8):
        for c in row: c.number_format = "0.00"
    for i, w in enumerate([12, 36, 22, 12, 24, 22, 22, 26, 20, 40, 14], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"

    ts = wb.create_sheet("Benchmark_Daily_USD")
    ts.append(["Date", "Index (rebased 100)"] + [b["ticker"] + " (USD)" for b in bm])
    for c in ts[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for i, d in enumerate(dates):
        ts.append([d, index_series[i]] + [round(bm_series[b["key"]][i], 6) for b in bm])
    ts.freeze_panes = "B2"
    ts.column_dimensions["A"].width = 12
    last_r = ts.max_row
    ts.cell(row=last_r + 2, column=1, value="Index return over the period").font = Font(bold=True)
    start_row = 2 + dates.index(REPORT_START)
    ts.cell(row=last_r + 2, column=2, value=f"=B{last_r}/B{start_row}-1").number_format = "0.00%"
    ts.cell(row=last_r + 3, column=1, value=f"Report period from {REPORT_START}; earlier rows are simulated history for VaR and backtest.")

    cur = wb.create_sheet("Currency_Weights")
    cur.append(["Currency", "Benchmark Weight (%)"])
    for c in cur[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for ccy in sorted({b["currency"] for b in bm}):
        r = cur.max_row + 1
        cur.append([ccy, f"=SUMIF(Benchmark_Constituents!$D${first}:$D${last},A{r},Benchmark_Constituents!$H${first}:$H${last})"])
    cur.column_dimensions["A"].width = 14; cur.column_dimensions["B"].width = 22

    cty = wb.create_sheet("Country_Weights")
    cty.append(["Country", "Benchmark Weight (%)"])
    for c in cty[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for ctry in sorted({b["country"] for b in bm}):
        r = cty.max_row + 1
        cty.append([ctry, f"=SUMIF(Benchmark_Constituents!$C${first}:$C${last},A{r},Benchmark_Constituents!$H${first}:$H${last})"])
    cty.column_dimensions["A"].width = 24; cty.column_dimensions["B"].width = 22

    sec = wb.create_sheet("Sector_Weights")
    sec.append(["Sector", "Benchmark Weight (%)"])
    for c in sec[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for s_ in sorted({b["sector"] for b in bm}):
        r = sec.max_row + 1
        sec.append([s_, f"=SUMIF(Benchmark_Constituents!$E${first}:$E${last},A{r},Benchmark_Constituents!$H${first}:$H${last})"])
    sec.column_dimensions["A"].width = 26; sec.column_dimensions["B"].width = 22

    nt = wb.create_sheet("Notes")
    for line in [
        "Source: MSCI Arabian Markets Index (USD) factsheet, top-10 constituents as supplied (Float Adj Mkt Cap USD bn, Index Wt %).",
        "Benchmark = these 10 constituents only. Index weights total 49.98%; each weight is divided by 49.98 so the benchmark sums to 100%.",
        "Benchmark prices are SIMULATED, not market data. Web sources had no usable daily history for these names.",
        "Drift assumption: 5% a year for each constituent (stated assumption). The realised return depends on the simulated noise and is not targeted.",
        "Anchors: five names use their 23-Sep-2026 statement price; Aramco, KFH, STC, e& and QNB use approximate levels (unverified).",
        "Benchmark_Daily_USD holds the daily index. Sector and currency attribution use this series.",
    ]: nt.append([line])
    nt.column_dimensions["A"].width = 140
    wb.save(OUT_BM)

if __name__ == "__main__":
    main(sys.argv[1])

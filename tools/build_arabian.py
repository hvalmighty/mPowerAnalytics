"""Builds the Arabian portfolio (ALBFUND, USD base) from its holding statement.
Outputs:
  public/data/Portfolio_Arabian.xlsx  holdings in the mPower position-report layout
                                      (+ Sector and Portfolio Currency columns, + CASH line)
  public/data/arabian_data.json       USD-converted daily price series (simulated, anchored to
                                      the statement's 23-Sep-2026 prices) and the benchmark
Run: python3 tools/build_arabian.py <Holding_Statement.xls>
Benchmark: MSCI Arabian Markets IMI Index (USD). Top-10 weights and sector weights are from the
MSCI factsheet (as of 30-Oct-2026); the remaining sector weight is carried by one sector-proxy
line per sector, so sector weights match the factsheet. Benchmark-only prices are simulated."""
import sys, json, math, random, zlib, datetime, statistics
from pathlib import Path
import xlrd, openpyxl
from openpyxl.styles import Font, PatternFill, Alignment

ROOT = Path(__file__).resolve().parent.parent
OUT_XLSX = ROOT / "public/data/Portfolio_Arabian.xlsx"
OUT_JSON = ROOT / "public/data/arabian_data.json"
VAL_DATE = datetime.date(2026, 9, 23)
START = datetime.date(2025, 9, 23)

# sector per holding (GICS-style names used by the MSCI factsheet)
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
         "Industrials":0.24,"Health Care":0.22,"Information Technology":0.36,"Materials":0.28,
         "Utilities":0.16,"Consumer Discretionary":0.26,"Consumer Staples":0.18}

# FX: units of local currency per 1 USD, implied by the statement's market values (median across lines);
# QAR is not in the statement, so the standard peg is used.
def read_statement(path):
    sh = xlrd.open_workbook(path).sheet_by_index(0)
    pf_label = None; rows = []
    for r in range(sh.nrows):
        v = sh.row_values(r)
        if str(v[0]).strip() == "Security" and "Security Name" in str(v[1]): hdr = r
    for r in range(sh.nrows):
        v = sh.row_values(r)
        if str(v[2]).strip().startswith("ALBFUND"): pf_label = str(v[2]).strip()
    for r in range(hdr + 2, sh.nrows):
        v = sh.row_values(r)
        code = str(v[0]).strip()
        if not code or code.endswith("Total :") or "Asset Class" in code: continue
        if code in ("Cash/NCA", "Net Asset Value") or code.startswith("*") or code.startswith("Valuation") or code.startswith("***") or code.startswith("Page"): continue
        if not isinstance(v[4], str) or not v[4]: continue
        rows.append(dict(code=code, name=str(v[1]).strip(), ccy=str(v[4]).strip().upper(), isin=str(v[5]).strip(),
                         qty=float(v[7]), avg=float(v[10]), book_tx=float(v[11]), price=float(v[13]),
                         mv_tx=float(v[14]), mv_usd=float(v[15]), book_usd=float(v[12])))
    cash_usd = None
    for r in range(hdr + 2, sh.nrows):
        v = sh.row_values(r)
        if str(v[0]).strip() == "Cash/NCA":
            cash_usd = next(float(x) for x in v[1:] if isinstance(x, float))
    return pf_label, rows, cash_usd

def main(path):
    pf_label, rows, cash_usd = read_statement(path)
    fx = {"USD": 1.0}
    for ccy in sorted({r["ccy"] for r in rows if r["ccy"] != "USD"}):
        ratios = [r["mv_tx"] / r["mv_usd"] for r in rows if r["ccy"] == ccy]
        fx[ccy] = 1.0 / statistics.median(ratios)     # USD per 1 unit of ccy
    fx["QAR"] = 1 / 3.64
    # ---------- benchmark (MSCI Arabian Markets IMI, USD) ----------
    px_of = {r["code"]: r["price"] for r in rows}
    top10 = [  # ticker, name, sector, weight (%), ccy, anchor price (local)
      ("ALR","Al Rajhi Banking & Investment","Financials",12.42,"SAR",px_of["ALR"]),
      ("ARAMCO","Saudi Aramco","Energy",5.43,"SAR",27.00),
      ("SNB","Saudi National Bank","Financials",4.66,"SAR",px_of["SNB"]),
      ("KFH","Kuwait Finance House","Financials",3.56,"KWD",0.75),
      ("NBK","National Bank of Kuwait","Financials",3.07,"KWD",px_of["NBK"]),
      ("FAB","First Abu Dhabi Bank","Financials",2.90,"AED",px_of["FAB"]),
      ("STC","Saudi Telecom Co","Communication Services",2.85,"SAR",40.00),
      ("ETEC","Emirates Telecommunications Group","Communication Services",2.58,"AED",14.00),
      ("QNBK","Qatar National Bank","Financials",2.57,"QAR",17.50),
      ("EMR","Emaar Properties","Real Estate",2.49,"AED",px_of["EMR"]),
    ]
    sector_w = {"Financials":52.29,"Communication Services":9.09,"Energy":9.08,"Materials":8.35,"Real Estate":6.5,
                "Industrials":4.59,"Utilities":3.01,"Consumer Discretionary":2.76,"Consumer Staples":1.97,
                "Health Care":1.71,"Information Technology":0.63}
    cons = [dict(ticker=t, name=n, sector=s, weight=w, ccy=c, anchor=a, proxy=False) for t, n, s, w, c, a in top10]
    for s, sw in sector_w.items():
        rest = sw - sum(c["weight"] for c in cons if c["sector"] == s)
        if rest > 0.005:
            cons.append(dict(ticker="IDX-" + "".join(ch for ch in s.upper() if ch.isalpha())[:6], name=f"Index remainder: {s} (sector proxy)",
                             sector=s, weight=round(rest, 2), ccy="USD", anchor=100.0, proxy=True))
    tot = sum(c["weight"] for c in cons)
    for c in cons: c["weight"] = round(c["weight"] / tot, 6)

    # ---------- daily dates and simulated prices ----------
    dates = []
    d = START
    while d <= VAL_DATE:
        if d.weekday() < 5: dates.append(d.isoformat())
        d += datetime.timedelta(days=1)
    n = len(dates)

    def simulate(key, anchor_local, sector, fx_rate):
        rng = random.Random(zlib.crc32(key.encode()))
        s = SIGMA.get(sector, 0.24) / math.sqrt(252)
        lvl = [1.0]
        for _ in range(n - 1): lvl.append(lvl[-1] * math.exp(rng.gauss(0, s)))
        scale = anchor_local / lvl[-1]
        return [round(x * scale * fx_rate, 6) for x in lvl]   # USD

    series = {}
    holding_rows = []
    for r in rows:
        sec = SECTOR[r["code"]]
        series[r["code"]] = simulate(r["code"], r["price"], sec, fx[r["ccy"]])
        holding_rows.append(r | {"sector": sec})
    for c in cons:
        if c["ticker"] in series: continue
        series[c["ticker"]] = simulate(c["ticker"], c["anchor"], c["sector"], fx[c["ccy"]] if not c["proxy"] else 1.0)
    series["CASH"] = [1.0] * n
    # benchmark index: fixed-weight, rebased to 100 at the start
    idx = [0.0] * n
    for c in cons:
        p = series[c["ticker"]]
        for i in range(n): idx[i] += c["weight"] * p[i] / p[0]
    series["MSCIAM"] = [round(100 * x, 6) for x in idx]

    # ---------- JSON for the app ----------
    OUT_JSON.write_text(json.dumps({
        "source": "Holding statement " + path.split("/")[-1] + "; simulated prices anchored to 23-Sep-2026",
        "base": "USD", "valuationDate": VAL_DATE.isoformat(), "fx": fx,
        "dates": dates, "series": {k: v for k, v in series.items()},
        "benchmark": {"id": "MSCIAM", "name": "MSCI Arabian Markets IMI Index (USD)", "asOf": "2026-10-30",
                      "constituents": [{"ticker": c["ticker"], "name": c["name"], "sector": c["sector"], "weight": c["weight"], "yahoo": c["ticker"]} for c in cons]},
        "cashUsd": cash_usd,
    }, separators=(",", ":")))

    # ---------- holdings workbook (mPower position-report layout) ----------
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Holdings"
    hdr = ["Security", "Security Name", "Book Cost in Transaction Currency", "Market Value in Transaction Currency",
           "Portfolio", "Transaction Currency", "Quantity", "Market Price", "Sector", "Portfolio Currency",
           "Book Cost in Portfolio Currency", "Market Value in Portfolio Currency"]
    ws.append(hdr)
    fill = PatternFill("solid", fgColor="19395C")
    for c in ws[1]: c.fill = fill; c.font = Font(bold=True, color="FFFFFF"); c.alignment = Alignment(wrap_text=True)
    ws.append(["Asset Class:ORD - Ordinary Shares"])
    ws.cell(row=2, column=1).font = Font(bold=True, color="19395C")
    for r in holding_rows:
        ws.append([r["code"], r["name"], r["book_tx"], r["mv_tx"], pf_label, r["ccy"], r["qty"], r["price"], r["sector"], "USD", r["book_usd"], r["mv_usd"]])
    ws.append(["Asset Class:CSH - Cash"])
    ws.cell(row=ws.max_row, column=1).font = Font(bold=True, color="19395C")
    ws.append(["CASH", "Cash / net current assets", cash_usd, cash_usd, pf_label, "USD", cash_usd, 1.0, "Cash", "USD", cash_usd, cash_usd])
    for row in ws.iter_rows(min_row=3, min_col=3, max_col=4):
        for c in row: c.number_format = "#,##0.00"
    for i, w in enumerate([12, 36, 26, 30, 36, 14, 16, 12, 24, 16, 26, 30], 1):
        ws.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    wb.save(OUT_XLSX)
    print(f"wrote {OUT_XLSX} ({len(holding_rows)} holdings + cash), {OUT_JSON} ({n} dates, {len(series)} series, {len(cons)} benchmark lines)")
    print("fx (USD per unit):", {k: round(v, 6) for k, v in fx.items()})
    print("benchmark weights sum:", round(sum(c["weight"] for c in cons), 6), "cash USD:", cash_usd)

if __name__ == "__main__":
    main(sys.argv[1])

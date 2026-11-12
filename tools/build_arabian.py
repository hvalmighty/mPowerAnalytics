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
START = datetime.date(2025, 9, 23)
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

# MSCI Arabian Markets IMI (USD) top-10 constituents, factsheet as of 30-Oct-2026
TOP10 = [  # ticker, statement code (None = no price data), name, country, currency, sector, factsheet weight %
 ("ALR", "ALR", "Al Rajhi Banking & Investment", "Saudi Arabia", "SAR", "Financials", 12.42),
 ("ARAMCO", None, "Saudi Aramco", "Saudi Arabia", "SAR", "Energy", 5.43),
 ("SNB", "SNB", "Saudi National Bank", "Saudi Arabia", "SAR", "Financials", 4.66),
 ("KFH", None, "Kuwait Finance House", "Kuwait", "KWD", "Financials", 3.56),
 ("NBK", "NBK", "National Bank of Kuwait", "Kuwait", "KWD", "Financials", 3.07),
 ("FAB", "FAB", "First Abu Dhabi Bank", "United Arab Emirates", "AED", "Financials", 2.90),
 ("STC", None, "Saudi Telecom Co", "Saudi Arabia", "SAR", "Communication Services", 2.85),
 ("ETEC", None, "Emirates Telecommunications Group", "United Arab Emirates", "AED", "Communication Services", 2.58),
 ("QNBK", None, "Qatar National Bank", "Qatar", "QAR", "Financials", 2.57),
 ("EMR", "EMR", "Emaar Properties", "United Arab Emirates", "AED", "Real Estate", 2.49),
]

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

def main(path):
    pf_label, rows = read_statement(path)
    fx = {"USD": 1.0}
    for ccy in sorted({r["ccy"] for r in rows if r["ccy"] != "USD"}):
        fx[ccy] = 1.0 / statistics.median([r["mv_tx"] / r["mv_usd"] for r in rows if r["ccy"] == ccy])  # USD per unit
    fx["QAR"] = 1 / 3.64   # not in the statement: standard peg
    px_of = {r["code"]: r for r in rows}

    # ---------- benchmark: top-10 constituents with price data, rescaled to 100% ----------
    have = [t for t in TOP10 if t[1] in px_of]
    missing = [t for t in TOP10 if t[1] not in px_of]
    tot = sum(t[6] for t in have)
    bm = [dict(ticker=t[0], name=t[2], country=t[3], currency=t[4], sector=t[5], fact_w=t[6],
               weight=t[6] / tot, local_px=px_of[t[1]]["price"], held=True) for t in have]

    # ---------- holdings price history (simulated, anchored to the statement prices) ----------
    dates = []; d = START
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

    OUT_JSON.write_text(json.dumps({
        "source": "Holding statement " + path.split("/")[-1] + "; holdings history simulated, anchored to 23-Sep-2026 prices",
        "base": "USD", "valuationDate": VAL_DATE.isoformat(), "fx": fx,
        "dates": dates, "series": series,
        "benchmark": {"id": "MSCIAM", "name": "MSCI Arabian Markets IMI Index (USD), top-10 constituents with price data",
                      "asOf": "2026-10-30", "priceHistory": False,
                      "constituents": [{"ticker": b["ticker"], "name": b["name"], "sector": b["sector"], "country": b["country"],
                                        "currency": b["currency"], "weight": round(b["weight"], 8), "yahoo": b["ticker"]} for b in bm]},
    }, separators=(",", ":")))

    write_benchmark_xlsx(bm, missing, fx)

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

def write_benchmark_xlsx(bm, missing, fx):
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Benchmark_Constituents"
    hdr = ["Ticker", "Security Name", "Country", "Currency", "Sector", "Factsheet Weight (%)", "Benchmark Weight (%)",
           "Local Price 23-Sep-2026", "Price Source", "Held in ALBFUND"]
    ws.append(hdr)
    for c in ws[1]: c.fill = HDR_FILL; c.font = HDR_FONT; c.alignment = Alignment(wrap_text=True)
    first = 2
    for b in bm:
        ws.append([b["ticker"], b["name"], b["country"], b["currency"], b["sector"], b["fact_w"], None,
                   b["local_px"], "Statement, 23-Sep-2026", "Yes" if b["held"] else "No"])
    last = ws.max_row
    for r in range(first, last + 1):
        ws.cell(row=r, column=7, value=f"=F{r}/SUM($F${first}:$F${last})*100")
    ws.append(["TOTAL", "", "", "", "", f"=SUM(F{first}:F{last})", f"=SUM(G{first}:G{last})"])
    ws.cell(row=ws.max_row, column=1).font = Font(bold=True)
    for row in ws.iter_rows(min_row=first, max_row=ws.max_row, min_col=6, max_col=7):
        for c in row: c.number_format = "0.00"
    for i, w in enumerate([12, 36, 22, 12, 24, 20, 22, 22, 24, 16], 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"

    cur = wb.create_sheet("Currency_Weights")
    cur.append(["Currency", "Benchmark Weight (%)"])
    for c in cur[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for ccy in sorted({b["currency"] for b in bm}):
        cur.append([ccy, f"=SUMIF(Benchmark_Constituents!$D${first}:$D${last},A{cur.max_row + 1},Benchmark_Constituents!$G${first}:$G${last})"])
    cur.column_dimensions["A"].width = 14; cur.column_dimensions["B"].width = 22

    ex = wb.create_sheet("Top10_Excluded")
    ex.append(["Ticker", "Security Name", "Country", "Currency", "Sector", "Factsheet Weight (%)", "Reason"])
    for c in ex[1]: c.fill = HDR_FILL; c.font = HDR_FONT
    for t in missing:
        ex.append([t[0], t[2], t[3], t[4], t[5], t[6], "No price data in the statement or any other file supplied"])
    ex.column_dimensions["B"].width = 36; ex.column_dimensions["G"].width = 60

    fact = wb.create_sheet("Factsheet_Reference")
    fact.append(["Country (factsheet, 30-Oct-2026)", "Weight (%)"])
    for k, v in [("Saudi Arabia", 53.18), ("United Arab Emirates", 21.23), ("Kuwait", 10.1), ("Qatar", 8.37), ("Morocco", 2.54), ("Other", 4.58)]:
        fact.append([k, v])
    fact.append([]); fact.append(["Sector (factsheet, 30-Oct-2026)", "Weight (%)"])
    for sec, w in [("Financials", 52.29), ("Communication Services", 9.09), ("Energy", 9.08), ("Materials", 8.35), ("Real Estate", 6.5),
                   ("Industrials", 4.59), ("Utilities", 3.01), ("Consumer Discretionary", 2.76), ("Consumer Staples", 1.97), ("Health Care", 1.71), ("Information Technology", 0.63)]:
        fact.append([sec, w])
    fact.column_dimensions["A"].width = 36

    nt = wb.create_sheet("Notes")
    for line in [
        "Source: MSCI Arabian Markets IMI Index (USD) factsheet as of 30-Oct-2026: top-10 weights, country and sector weights.",
        "Benchmark = the top-10 constituents that have price data (5 names). Their factsheet weights are rescaled to sum to 100%.",
        "The 5 excluded top-10 names (Aramco, KFH, STC, e&, QNB) have no price data, so they are not in the benchmark.",
        "Only one price date (23-Sep-2026) is available for these names. No benchmark price history exists, so benchmark returns and attribution are not computed.",
        "Local prices are from the holding statement. Country and currency are from the factsheet and the names' listing markets.",
    ]: nt.append([line])
    nt.column_dimensions["A"].width = 140
    wb.save(OUT_BM)

if __name__ == "__main__":
    main(sys.argv[1])

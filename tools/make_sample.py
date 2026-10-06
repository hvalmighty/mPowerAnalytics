"""Builds public/sample/PSE_Portfolio_Sample.xlsx — the input template with an
illustrative Philippine equity portfolio. Run: python3 tools/make_sample.py"""
from datetime import date
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment

OUT = Path(__file__).resolve().parent.parent / "public" / "sample" / "PSE_Portfolio_Sample.xlsx"
OUT.parent.mkdir(parents=True, exist_ok=True)

F = "Arial"
HDR_FILL = PatternFill("solid", fgColor="1C5CAB")
REQ_FILL = PatternFill("solid", fgColor="0D366B")
INPUT_FONT = Font(name=F, size=10, color="0000FF")      # blue = user input
TEXT = Font(name=F, size=10)
HDR = Font(name=F, size=10, bold=True, color="FFFFFF")
NOTE = Font(name=F, size=9, italic=True, color="52514E")
TITLE = Font(name=F, size=13, bold=True)
thin = Side(style="thin", color="E2E0DA")
BORDER = Border(bottom=thin)

wb = Workbook()


def header(ws, row, cols, required=()):
    for j, (name, width, note) in enumerate(cols, start=1):
        c = ws.cell(row=row, column=j, value=name)
        c.font = HDR
        c.fill = REQ_FILL if name in required else HDR_FILL
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        if note:
            c.comment = Comment(note, "Template")
        ws.column_dimensions[c.column_letter].width = width
    ws.row_dimensions[row].height = 30
    ws.freeze_panes = ws.cell(row=row + 1, column=1)


def rows(ws, start, data, fmts):
    for i, r in enumerate(data):
        for j, v in enumerate(r, start=1):
            c = ws.cell(row=start + i, column=j, value=v)
            c.font = INPUT_FONT
            c.border = BORDER
            f = fmts.get(j)
            if f:
                c.number_format = f


def notes(ws, row, lines):
    for i, t in enumerate(lines):
        ws.cell(row=row + i, column=1, value=t).font = NOTE


# ------------------------------------------------------------------ Instructions
ws = wb.active
ws.title = "Instructions"
ws.column_dimensions["A"].width = 26
ws.column_dimensions["B"].width = 110
ws["A1"] = "PSE Portfolio Analytics — input workbook"
ws["A1"].font = TITLE
ws["A2"] = ("Upload this workbook (exported from the PMS) to the app. Prices are fetched automatically from Yahoo Finance "
            "(EODHD for PSE stocks when the server has an API key; Yahoo Finance for the PSEi index), or read from the Price_History sheet.")
ws["A2"].font = TEXT
ws["A3"] = ("ALL VALUES IN THIS SAMPLE ARE ILLUSTRATIVE (quantities, costs, fees, flows, benchmark weights and sector labels). "
            "Replace them with your PMS data and official PSE index weights before use.")
ws["A3"].font = Font(name=F, size=10, bold=True, color="C0392B")
info = [
    ("Sheet", "Purpose and rules"),
    ("Portfolio_Info (required)", "Key/value settings: dates, benchmark, VaR parameters. Edit column B only. Dates as real Excel dates."),
    ("Holdings (required)", "One row per security per snapshot date. Ticker = PSE stock code (no .PS). Cash is a row with ticker CASH and Quantity = cash balance in PHP. "
                            "Give a snapshot dated on Period_Start (opening positions); a later snapshot (e.g. Period_End) is optional and is used to reconcile rolled-forward positions. "
                            "If only a closing snapshot is given, opening positions are derived by reversing the transactions."),
    ("Transactions", "Trades and income inside the period (after Period_Start, up to Period_End). Type: BUY, SELL, DIVIDEND, FEE, INTEREST, STOCK_DIVIDEND. "
                     "Quantity always positive. Price blank = Yahoo close on the trade date. Net_Amount required for DIVIDEND / FEE / INTEREST (positive numbers); "
                     "if given for BUY/SELL it overrides Quantity x Price +/- Fees. If a stock has no DIVIDEND rows, dividends are taken from Yahoo (Auto_Dividends_From_Yahoo = YES)."),
    ("Cash_Flows", "External client money only (subscriptions/contributions and redemptions/withdrawals). Amount positive; Type decides the sign. Needed for correct time-weighted return."),
    ("Benchmark_Constituents", "Index members, PSE sector and weight at Period_Start, for sector attribution. Sector labels must match those used in Holdings. Weights in % or decimals; they are normalised to 100%."),
    ("Stress_Scenarios", "Optional. HISTORICAL rows replay actual returns between Start_Date and End_Date. SHOCK rows apply Shock_% to ALL, a sector name, or a single ticker."),
    ("Price_History", "Daily closing prices from the PMS (Date, PSE_Ticker, Close, optional Adj_Close). Yahoo Finance no longer carries Philippine stocks, so supply this sheet unless the server has an EODHD API key. Use ticker PSEI for the index if you also want to supply it."),
    ("Price_Override", "Optional. Manual prices for single dates (suspended / illiquid names). Overrides every other source on that date."),
    ("Colour code", "Dark-blue headers = required columns; mid-blue = optional. Blue text = input values. Hover a header for its definition."),
]
for i, (a, b) in enumerate(info, start=5):
    ws.cell(row=i, column=1, value=a).font = Font(name=F, size=10, bold=(i == 5))
    c = ws.cell(row=i, column=2, value=b)
    c.font = Font(name=F, size=10, bold=(i == 5))
    c.alignment = Alignment(wrap_text=True, vertical="top")
    ws.cell(row=i, column=1).alignment = Alignment(vertical="top")

# ------------------------------------------------------------------ Portfolio_Info
ws = wb.create_sheet("Portfolio_Info")
header(ws, 1, [("Parameter", 30, None), ("Value", 30, None), ("Description", 90, None)], required=("Parameter", "Value"))
P = [
    ("Portfolio_Name", "Sample PH Equity PMS", "Shown on the report"),
    ("Portfolio_ID", "PMS-PH-0001", ""),
    ("Portfolio_Manager", "Sample Manager", ""),
    ("Base_Currency", "PHP", "PSE prices are in PHP; no FX conversion in this version"),
    ("Valuation_Date", date(2026, 9, 30), "Positions on this date are used for VaR (required)"),
    ("Period_Start", date(2025, 9, 30), "Performance/attribution start; opening snapshot date (required)"),
    ("Period_End", date(2026, 9, 30), "Performance/attribution end (defaults to Valuation_Date)"),
    ("Inception_Date", date(2023, 1, 2), "Informational"),
    ("Benchmark_Name", "PSE Composite Index (PSEi)", ""),
    ("Benchmark_Yahoo_Symbol", "PSEI.PS", "Yahoo symbol for the benchmark index"),
    ("Benchmark_Return_Type", "PRICE", "PRICE (PSEi is a price index) or TOTAL (use dividend-adjusted constituent prices in attribution)"),
    ("VaR_Confidence_Levels", "95, 99", "Comma-separated, in %"),
    ("VaR_Horizon_Days", "1, 10", "Multi-day VaR scaled by square-root of time"),
    ("VaR_Lookback_Days", 500, "Trading days of history for VaR (250 minimum recommended)"),
    ("Covariance_Method", "EWMA", "EWMA (RiskMetrics) or SAMPLE (equal-weighted)"),
    ("EWMA_Lambda", 0.94, "Decay factor for EWMA"),
    ("MC_Simulations", 10000, "Monte Carlo paths"),
    ("Backtest_Days", 250, "Days of VaR backtesting (Kupiec test, Basel traffic light)"),
    ("Risk_Free_Rate", 0.055, "Annual rate for Sharpe/Sortino/alpha. ILLUSTRATIVE — set to the current PH T-bill yield"),
    ("Auto_Dividends_From_Yahoo", "YES", "YES = credit Yahoo cash dividends for stocks with no DIVIDEND rows in Transactions"),
    ("Attribution_Grouping", "Sector", "Attribution segments (Sector)"),
]
for i, (k, v, d) in enumerate(P, start=2):
    ws.cell(row=i, column=1, value=k).font = Font(name=F, size=10, bold=True)
    c = ws.cell(row=i, column=2, value=v)
    c.font = INPUT_FONT
    if isinstance(v, date):
        c.number_format = "yyyy-mm-dd"
    if k == "Risk_Free_Rate":
        c.number_format = "0.00%"
    ws.cell(row=i, column=3, value=d).font = NOTE
    for j in (1, 2, 3):
        ws.cell(row=i, column=j).border = BORDER

# ------------------------------------------------------------------ Holdings
ws = wb.create_sheet("Holdings")
H_COLS = [
    ("Snapshot_Date", 14, "Date the positions are as of (end of day)"),
    ("PSE_Ticker", 12, "PSE stock code, e.g. BDO, ICT, SM. Cash = CASH"),
    ("ISIN", 16, "Optional"),
    ("Security_Name", 34, ""),
    ("Sector", 16, "PSE sector: Financials, Industrial, Holding Firms, Property, Services, Mining and Oil"),
    ("Sub_Sector", 22, "Optional"),
    ("Quantity", 14, "Shares held; for CASH the PHP balance"),
    ("Avg_Cost", 12, "Optional: average cost per share"),
    ("PMS_Price", 12, "Optional: PMS valuation price, checked against Yahoo close"),
    ("Market_Value", 16, "Optional: PMS market value"),
]
header(ws, 1, H_COLS, required=("PSE_Ticker", "Quantity", "Snapshot_Date", "Sector"))
o = date(2025, 9, 30)
c_ = date(2026, 9, 30)
opening = [
    ("BDO", "BDO Unibank, Inc.", "Financials", "Banks", 60000, 128.40),
    ("BPI", "Bank of the Philippine Islands", "Financials", "Banks", 50000, 112.10),
    ("MBT", "Metropolitan Bank & Trust Co.", "Financials", "Banks", 80000, 64.25),
    ("ICT", "International Container Terminal Services, Inc.", "Services", "Transportation Services", 20000, 385.00),
    ("SM", "SM Investments Corporation", "Holding Firms", "Holding Firms", 6000, 845.50),
    ("AC", "Ayala Corporation", "Holding Firms", "Holding Firms", 7000, 610.00),
    ("JGS", "JG Summit Holdings, Inc.", "Holding Firms", "Holding Firms", 100000, 27.80),
    ("ALI", "Ayala Land, Inc.", "Property", "Property", 250000, 28.90),
    ("SMPH", "SM Prime Holdings, Inc.", "Property", "Property", 300000, 24.60),
    ("AREIT", "AREIT, Inc.", "Property", "REIT", 120000, 35.20),
    ("JFC", "Jollibee Foods Corporation", "Industrial", "Food, Beverage & Tobacco", 20000, 215.00),
    ("URC", "Universal Robina Corporation", "Industrial", "Food, Beverage & Tobacco", 40000, 92.40),
    ("MER", "Manila Electric Company", "Industrial", "Electricity, Energy, Power & Water", 8000, 505.00),
    ("TEL", "PLDT Inc.", "Services", "Telecommunications", 2500, 1325.00),
    ("CNVRG", "Converge Information and Communications Technology Solutions, Inc.", "Services", "Telecommunications", 300000, 14.10),
    ("SCC", "Semirara Mining and Power Corporation", "Mining and Oil", "Mining", 60000, 31.50),
]
data = [(o, t, None, n, s, ss, q, ac, None, None) for (t, n, s, ss, q, ac) in opening]
data.append((o, "CASH", None, "Cash (PHP)", "Cash", None, 4000000, None, None, None))
# closing snapshot (securities only) — used to reconcile rolled-forward positions
closing_qty = {"BDO": 75000, "BPI": 50000, "MBT": 80000, "ICT": 23000, "SM": 6000, "AC": 7000, "ALI": 150000, "SMPH": 300000,
               "AREIT": 120000, "JFC": 20000, "URC": 40000, "MER": 8000, "TEL": 2500, "CNVRG": 150000, "SCC": 60000,
               "GLO": 1500, "CBC": 40000, "PLUS": 100000}
names = {t: (n, s, ss) for (t, n, s, ss, q, ac) in opening}
names.update({"GLO": ("Globe Telecom, Inc.", "Services", "Telecommunications"),
              "CBC": ("China Banking Corporation", "Financials", "Banks"),
              "PLUS": ("DigiPlus Interactive Corp.", "Services", "Casinos & Gaming")})
for t, q in closing_qty.items():
    n, s, ss = names[t]
    data.append((c_, t, None, n, s, ss, q, None, None, None))
rows(ws, 2, data, {1: "yyyy-mm-dd", 7: "#,##0", 8: "#,##0.00", 9: "#,##0.00", 10: "#,##0"})
dv = DataValidation(type="list", formula1='"Financials,Industrial,Holding Firms,Property,Services,Mining and Oil,Cash"', allow_blank=True)
ws.add_data_validation(dv)
dv.add("E2:E1000")
notes(ws, len(data) + 3, [
    "Rows dated 2025-09-30 = opening snapshot (incl. CASH). Rows dated 2026-09-30 = closing snapshot used only for reconciliation (no CASH row, so cash is not reconciled).",
    "Quantities and costs are illustrative. ISIN optional. Leave PMS_Price / Market_Value blank to rely on Yahoo prices; fill them to get a PMS-vs-Yahoo price check.",
])

# ------------------------------------------------------------------ Transactions
ws = wb.create_sheet("Transactions")
header(ws, 1, [
    ("Trade_Date", 13, "Trade date (lands on the next PSE trading day if a holiday)"),
    ("PSE_Ticker", 12, "Stock code; CASH for fees/interest not tied to a stock"),
    ("Type", 15, "BUY, SELL, DIVIDEND, FEE, INTEREST, STOCK_DIVIDEND"),
    ("Quantity", 12, "Shares (always positive)"),
    ("Price", 11, "Trade price; blank = Yahoo close that day"),
    ("Fees", 11, "Commission + taxes (positive)"),
    ("Net_Amount", 15, "Cash amount (positive). Required for DIVIDEND/FEE/INTEREST"),
    ("Remarks", 34, ""),
], required=("Trade_Date", "PSE_Ticker", "Type"))
T = [
    (date(2025, 10, 15), "CASH", "FEE", None, None, None, 125000, "Q3 management fee"),
    (date(2025, 11, 14), "GLO", "BUY", 1500, None, 6750, None, "New position"),
    (date(2025, 12, 10), "CNVRG", "SELL", 150000, None, 5600, None, "Trim"),
    (date(2026, 1, 15), "CASH", "FEE", None, None, None, 125000, "Q4 management fee"),
    (date(2026, 1, 20), "BDO", "BUY", 15000, None, 5250, None, "Add after contribution"),
    (date(2026, 2, 17), "JGS", "SELL", 100000, None, 6900, None, "Exit"),
    (date(2026, 3, 9), "CBC", "BUY", 40000, None, 6500, None, "New position"),
    (date(2026, 4, 15), "CASH", "FEE", None, None, None, 125000, "Q1 management fee"),
    (date(2026, 5, 20), "PLUS", "BUY", 100000, None, 8750, None, "New position"),
    (date(2026, 5, 25), "ALI", "SELL", 100000, None, 6200, None, "Reduce property"),
    (date(2026, 6, 30), "CASH", "INTEREST", None, None, None, 18500, "Interest on cash"),
    (date(2026, 7, 15), "CASH", "FEE", None, None, None, 125000, "Q2 management fee"),
    (date(2026, 8, 12), "ICT", "BUY", 3000, None, 3500, None, "Add"),
]
rows(ws, 2, T, {1: "yyyy-mm-dd", 4: "#,##0", 5: "#,##0.00", 6: "#,##0.00", 7: "#,##0.00"})
dv = DataValidation(type="list", formula1='"BUY,SELL,DIVIDEND,FEE,INTEREST,STOCK_DIVIDEND"', allow_blank=False)
ws.add_data_validation(dv)
dv.add("C2:C2000")
notes(ws, len(T) + 3, [
    "Prices are left blank, so the app values each trade at that day's Yahoo close. Fees are illustrative.",
    "No DIVIDEND rows: cash dividends are credited automatically from Yahoo on ex-dates. If you add DIVIDEND rows for a stock, Yahoo dividends are not used for that stock.",
])

# ------------------------------------------------------------------ Cash_Flows
ws = wb.create_sheet("Cash_Flows")
header(ws, 1, [("Date", 13, "Value date"), ("Amount", 16, "Positive number; Type sets the sign"),
               ("Type", 16, "Contribution or Withdrawal"), ("Remarks", 30, "")], required=("Date", "Amount"))
rows(ws, 2, [(date(2026, 1, 5), 5000000, "Contribution", "Client top-up"),
             (date(2026, 6, 1), 2000000, "Withdrawal", "Client redemption")], {1: "yyyy-mm-dd", 2: "#,##0.00"})
dv = DataValidation(type="list", formula1='"Contribution,Withdrawal"', allow_blank=False)
ws.add_data_validation(dv)
dv.add("C2:C1000")

# ------------------------------------------------------------------ Benchmark_Constituents
ws = wb.create_sheet("Benchmark_Constituents")
header(ws, 1, [("PSE_Ticker", 12, ""), ("Security_Name", 46, ""), ("Sector", 16, "Same labels as Holdings"),
               ("Weight", 11, "Index weight at Period_Start (% or decimal)"), ("Notes", 50, "")],
       required=("PSE_Ticker", "Sector", "Weight"))
B = [
    ("ICT", "International Container Terminal Services, Inc.", "Services", 14.0),
    ("BDO", "BDO Unibank, Inc.", "Financials", 9.5),
    ("SM", "SM Investments Corporation", "Holding Firms", 8.0),
    ("BPI", "Bank of the Philippine Islands", "Financials", 7.5),
    ("SMPH", "SM Prime Holdings, Inc.", "Property", 6.0),
    ("MBT", "Metropolitan Bank & Trust Co.", "Financials", 5.0),
    ("ALI", "Ayala Land, Inc.", "Property", 4.5),
    ("AC", "Ayala Corporation", "Holding Firms", 4.5),
    ("MER", "Manila Electric Company", "Industrial", 3.5),
    ("TEL", "PLDT Inc.", "Services", 3.0),
    ("JFC", "Jollibee Foods Corporation", "Industrial", 3.0),
    ("CBC", "China Banking Corporation", "Financials", 2.5),
    ("URC", "Universal Robina Corporation", "Industrial", 2.0),
    ("GLO", "Globe Telecom, Inc.", "Services", 2.0),
    ("SMC", "San Miguel Corporation", "Industrial", 2.0),
    ("ACEN", "ACEN Corporation", "Industrial", 2.0),
    ("PLUS", "DigiPlus Interactive Corp.", "Services", 2.0),
    ("AEV", "Aboitiz Equity Ventures, Inc.", "Holding Firms", 1.5),
    ("JGS", "JG Summit Holdings, Inc.", "Holding Firms", 1.5),
    ("MONDE", "Monde Nissin Corporation", "Industrial", 1.5),
    ("GTCAP", "GT Capital Holdings, Inc.", "Holding Firms", 1.5),
    ("CNPF", "Century Pacific Food, Inc.", "Industrial", 1.5),
    ("SCC", "Semirara Mining and Power Corporation", "Mining and Oil", 1.5),
    ("AREIT", "AREIT, Inc.", "Property", 1.5),
    ("DMC", "DMCI Holdings, Inc.", "Holding Firms", 1.0),
    ("EMI", "Emperador Inc.", "Industrial", 1.0),
    ("LTG", "LT Group, Inc.", "Holding Firms", 1.0),
    ("PGOLD", "Puregold Price Club, Inc.", "Services", 1.0),
    ("AGI", "Alliance Global Group, Inc.", "Holding Firms", 1.0, "Left PSEi 2 Feb 2026 (replaced by RCR)"),
    ("CNVRG", "Converge ICT Solutions, Inc.", "Services", 1.0, "Left PSEi 3 Aug 2026 (replaced by MYNLD)"),
]
B = [b if len(b) == 5 else b + ("",) for b in B]
tot = sum(b[3] for b in B)
B = [(t, n, s, round(w / tot * 100, 2), nt) for (t, n, s, w, nt) in B]
rows(ws, 2, B, {4: "0.00"})
last = len(B) + 1
ws.cell(row=last + 1, column=3, value="Total").font = Font(name=F, size=10, bold=True)
c = ws.cell(row=last + 1, column=4, value=f"=SUM(D2:D{last})")
c.font = Font(name=F, size=10, bold=True)
c.number_format = "0.00"
dv = DataValidation(type="list", formula1='"Financials,Industrial,Holding Firms,Property,Services,Mining and Oil"', allow_blank=False)
ws.add_data_validation(dv)
dv.add("C2:C500")
notes(ws, last + 3, [
    "PSEi membership as of the 30 Sep 2025 period start. WEIGHTS ARE ILLUSTRATIVE PLACEHOLDERS: replace with official free-float weights from PSE index factsheets / PSE EDGE.",
    "Sector labels are a best-effort mapping to PSE sectors; use your PMS/PSE classification. Mid-period index changes (RCR in Feb 2026, MYNLD in Aug 2026) are not replayed: the benchmark is held buy-and-hold from these weights.",
])

# ------------------------------------------------------------------ Stress_Scenarios
ws = wb.create_sheet("Stress_Scenarios")
header(ws, 1, [("Scenario", 34, ""), ("Type", 13, "HISTORICAL or SHOCK"), ("Target", 16, "SHOCK only: ALL, a sector, or a ticker"),
               ("Shock_%", 10, "SHOCK only, e.g. -20"), ("Start_Date", 13, "HISTORICAL only"), ("End_Date", 13, "HISTORICAL only")],
       required=("Scenario", "Type"))
S = [
    ("COVID-19 crash", "HISTORICAL", None, None, date(2020, 2, 19), date(2020, 3, 19)),
    ("Global financial crisis", "HISTORICAL", None, None, date(2008, 9, 1), date(2008, 10, 28)),
    ("2022 rate-hike sell-off", "HISTORICAL", None, None, date(2022, 8, 31), date(2022, 10, 7)),
    ("Broad market -20%", "SHOCK", "ALL", -20, None, None),
    ("Banks -15%", "SHOCK", "Financials", -15, None, None),
    ("Property -25%", "SHOCK", "Property", -25, None, None),
    ("ICT -30% (single name)", "SHOCK", "ICT", -30, None, None),
]
rows(ws, 2, S, {5: "yyyy-mm-dd", 6: "yyyy-mm-dd", 4: "0.0"})
dv = DataValidation(type="list", formula1='"HISTORICAL,SHOCK"', allow_blank=False)
ws.add_data_validation(dv)
dv.add("B2:B500")
notes(ws, len(S) + 3, ["Historical windows are examples; stocks not listed at the time are proxied with the index move."])

# ------------------------------------------------------------------ Price_History
ws = wb.create_sheet("Price_History")
header(ws, 1, [("Date", 13, "Trading date"), ("PSE_Ticker", 12, "Stock code; use PSEI for the index"),
               ("Close", 12, "Closing price, PHP"), ("Adj_Close", 12, "Optional: dividend/split-adjusted close (used for VaR returns)")],
       required=("Date", "PSE_Ticker", "Close"))
notes(ws, 3, [
    "Optional, but needed for PSE stocks unless the server has an EODHD API key: Yahoo Finance no longer carries Philippine stocks.",
    "Export daily closing prices from the PMS for every holding and benchmark member, about 3 years back from Valuation_Date (VaR lookback + backtest).",
    "Long format, one row per ticker per date. Tickers listed here are not fetched online. When prices come from this sheet, dividends must be entered as DIVIDEND rows in Transactions.",
    "Delete these note rows (or leave them: rows without a date and ticker are ignored).",
])

# ------------------------------------------------------------------ Price_Override
ws = wb.create_sheet("Price_Override")
header(ws, 1, [("Date", 13, ""), ("PSE_Ticker", 12, ""), ("Price", 12, "PHP"), ("Reason", 40, "")],
       required=("Date", "PSE_Ticker", "Price"))
notes(ws, 3, ["Optional. Example: 2026-07-16 | RRHI | <last traded price> | Trading suspended after tender offer. Leave empty if not needed."])

for s in wb.worksheets:
    s.sheet_view.showGridLines = s.title not in ("Instructions",)

wb.save(OUT)
print("wrote", OUT)

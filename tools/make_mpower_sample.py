"""Builds public/sample/Portfolio_Sample_mPower.xlsx in the mPower position-report layout
(same 28 columns, asset-class header rows, subtotal rows, Portfolio column) with two
sample portfolios. Market values use the last built-in price where the code has one.
Run: python3 tools/make_mpower_sample.py"""
import json
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font

ROOT = Path(__file__).resolve().parent.parent
px = json.loads((ROOT / "public/data/market_prices.json").read_text())
last = {k: next(v for v in reversed(s) if v) for k, s in px["series"].items() if any(s)}
HEAD = ['Security', 'Security Name ', None, 'Investment Category', 'Transaction Currency', 'ISIN Code', 'Maturity Date', 'Quantity / Nominal',
        'Blocked Quantity', 'Nominal Value', 'Average Price', 'Book Cost in Transaction Currency', 'Book Cost in Portfolio Currency', 'Market Price',
        'Market Value in Transaction Currency', 'Market Value in Portfolio Currency', '% of NAV', 'Interest Accrual in Portfolio Currency ', 'Accrued AOD',
        'Amortised Cost', None, 'Amortised Cost Per Unit', 'App/Dep in Transaction Currency', None, 'App/Dep in Portfolio Currency',
        'Valuation Amount in Transaction Currency', 'Valuation Amount in Portfolio Currency', 'Portfolio']
PORTFOLIOS = {
    "DISCR0001 : SAMPLE GROWTH": {
        "ORD - Ordinary Shares": [("BDO", "BDO UNIBANK INC", 60000, 0.97), ("ICT", "INTL CONTAINER TERMINAL SERVICES", 20000, 0.80),
                                   ("SMM", "SM INVESTMENTS CORP", 6000, 1.25), ("ALI", "AYALA LAND INC", 250000, 1.10), ("MER", "MANILA ELECTRIC CO", 8000, 0.95)],
        "MFU - Mutual Fund Units": [("UITF EQUITY", "METRO EQUITY FUND", 2000000, None, 1.00, 1.12)],
    },
    "DISCR0002 : SAMPLE INCOME": {
        "ORD - Ordinary Shares": [("TEL", "PLDT INC", 2500, 1.05), ("BPI", "BANK OF THE PHILIPPINE ISLANDS", 40000, 1.02)],
        "RTS - Real Estate Investment Trusts": [("ARE", "AREIT INC", 120000, 1.08)],
        "MFU - Mutual Fund Units": [("UITF MUPF", "METRO UNIT PAYING FUND", 5000000, None, 1.00, 1.003)],
        "TB - Treasury Bills": [("FTBILLS092226", "0.00% PHP TREASURY BILL 09-22-2026", 3000000, None, 0.97, 0.985)],
    },
}
wb = Workbook(); ws = wb.active; ws.title = "Sheet1"
ws.append(HEAD)
for c in ws[1]: c.font = Font(bold=True)
for pf, classes in PORTFOLIOS.items():
    for ac, rows in classes.items():
        r = [None] * 28; r[0] = f"Asset Class:{ac}"; r[27] = pf; ws.append(r)
        tq = tb = tm = 0
        for row in rows:
            if row[3] is None:  # (code, name, qty, None, avg, mkt) for non-market securities
                code, name, qty, _, avg, mkt = row
            else:               # (code, name, qty, cost/market ratio) for listed codes
                code, name, qty, ratio = row
                mkt = last[code]; avg = round(mkt * ratio, 4)
            book, mv = round(qty * avg, 2), round(qty * mkt, 2)
            r = [None] * 28
            r[0], r[1], r[3], r[4], r[7], r[8], r[9], r[10] = code, name, "INVEST", "PHP", qty, 0, qty, avg
            r[11], r[12], r[13], r[14], r[15], r[22], r[24], r[25], r[26], r[27] = book, book, mkt, mv, mv, round(mv - book, 2), round(mv - book, 2), mv, mv, pf
            ws.append(r); tq += qty; tb += book; tm += mv
        r = [None] * 28; r[0] = f"{ac.split(' - ')[0]} Total :"; r[7] = tq; r[12] = round(tb, 2); r[15] = round(tm, 2); r[26] = round(tm, 2); r[27] = pf; ws.append(r)
out = ROOT / "public/sample/Portfolio_Sample_mPower.xlsx"
wb.save(out); print("wrote", out)

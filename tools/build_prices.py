"""Converts the PMS market price export into public/data/market_prices.json, the app's
built-in price source. Only security, date and price are kept (no client or custodian fields).
Run: python3 tools/build_prices.py path/to/Market_Price_Upload.xlsx"""
import json, sys, datetime
from pathlib import Path
import openpyxl

src = Path(sys.argv[1])
OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "market_prices.json"
norm = lambda s: "".join(ch for ch in str(s or "").lower() if ch.isalnum())
ws = openpyxl.load_workbook(src, read_only=True, data_only=True).worksheets[0]
rows = ws.iter_rows(values_only=True)
head = [norm(h) for h in next(rows)]
def col(*names):
    for n in names:
        if n in head: return head.index(n)
    raise SystemExit(f"column not found: {names}")
ci, cd, cp = col("security", "securitycode", "ticker"), col("effectivedate", "pricedate", "date"), col("mktprice", "marketprice", "closeprice", "close")
def iso(v):
    if isinstance(v, datetime.datetime): return v.date().isoformat()
    if isinstance(v, datetime.date): return v.isoformat()
    return datetime.datetime.strptime(str(v).strip(), "%d-%b-%Y").date().isoformat()
px, dates = {}, set()
for r in rows:
    if not r or r[ci] in (None, "") or r[cp] in (None, ""): continue
    p = float(r[cp])
    if p <= 0: continue
    d = iso(r[cd]); dates.add(d)
    px.setdefault(str(r[ci]).strip().upper(), {})[d] = p
dates = sorted(dates)
series = {s: [m.get(d) for d in dates] for s, m in sorted(px.items())}
import re
out = {"source": re.sub(r"^[0-9a-f]{8}-", "", src.name), "built": datetime.date.today().isoformat(), "from": dates[0], "to": dates[-1], "dates": dates, "series": series}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {OUT}: {len(series)} securities, {len(dates)} dates {dates[0]} -> {dates[-1]}, {OUT.stat().st_size // 1024} KB")

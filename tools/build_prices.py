"""Builds public/data/market_prices.json, the app's built-in price universe, from one or
more PMS price exports (security, effective_date, mkt_price). Files are merged: the
calendar is the union of all dates, and a later file overrides an earlier one for the
same security and date. Only security, date and price are kept.
Run: python3 tools/build_prices.py export1.xlsx [export2.xlsx ...]"""
import json, sys, datetime, re
from pathlib import Path
import openpyxl

OUT = Path(__file__).resolve().parent.parent / "public" / "data" / "market_prices.json"
norm = lambda s: "".join(ch for ch in str(s or "").lower() if ch.isalnum())

def iso(v):
    if isinstance(v, datetime.datetime): return v.date().isoformat()
    if isinstance(v, datetime.date): return v.isoformat()
    return datetime.datetime.strptime(str(v).strip(), "%d-%b-%Y").date().isoformat()

def read(src):
    ws = openpyxl.load_workbook(src, read_only=True, data_only=True).worksheets[0]
    rows = ws.iter_rows(values_only=True)
    head = [norm(h) for h in next(rows)]
    def col(*names):
        for n in names:
            if n in head: return head.index(n)
        raise SystemExit(f"{src}: column not found: {names}")
    ci, cd, cp = col("security", "securitycode", "ticker"), col("effectivedate", "pricedate", "date"), col("mktprice", "marketprice", "closeprice", "close")
    px = {}
    for r in rows:
        if not r or len(r) <= max(ci, cd, cp) or r[ci] in (None, "") or r[cp] in (None, "") or r[cd] in (None, ""): continue
        p = float(r[cp])
        if p <= 0: continue
        px.setdefault(str(r[ci]).strip().upper(), {})[iso(r[cd])] = p
    return px

merged, sources = {}, []
for f in sys.argv[1:]:
    src = Path(f)
    for sec, m in read(src).items(): merged.setdefault(sec, {}).update(m)
    sources.append(re.sub(r"^[0-9a-f]{8}-", "", src.name))
dates = sorted({d for m in merged.values() for d in m})
series = {s: [m.get(d) for d in dates] for s, m in sorted(merged.items())}
out = {"source": " + ".join(sources), "built": datetime.date.today().isoformat(), "from": dates[0], "to": dates[-1], "dates": dates, "series": series}
OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(json.dumps(out, separators=(",", ":")))
print(f"wrote {OUT}: {len(series)} securities, {len(dates)} dates {dates[0]} -> {dates[-1]}, {OUT.stat().st_size // 1024} KB")

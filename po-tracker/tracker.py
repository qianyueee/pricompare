"""读跟单总表（xlsx）的「订单明细」，按 WO# 汇总成页面用的订单列表。只用 Python 标准库。

状态全部来自人填的列（备注、发货日期、预计发货日期），这里不做任何猜测：
  - 一行算「结束」：备注就是「完成」，或备注里有「取消」，或填了发货日期；
  - 一个 WO 的所有行都结束了，这个 WO 才算结束（页面上变灰、排到最后）；
  - 其余一律按 WO Due 算紧急程度，备注原文照样显示。
"""
from __future__ import annotations

import datetime as dt
import re
import zipfile
import xml.etree.ElementTree as ET
from io import BytesIO
from pathlib import PurePosixPath

NS = {
    "m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}
R_ID = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"

DETAIL_SHEET = "订单明细"
VENDOR_CN = {"huachen": "华晨", "shenzhen kaiwei": "凯维", "kaiwei": "凯维", "xinghua": "兴华"}
DATE_COLS = ("PO Date", "Due Date", "WO Date", "WO Due", "发货日期", "预计发货日期")
MAX_CELLS = 2_000_000


class TrackerError(ValueError):
    """总表读不了或格式不对；消息直接给用户看。"""


# ---------------------------------------------------------------- 极简 xlsx 读取

def _col_index(ref: str) -> int:
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1


def _text(el) -> str:
    """<si>/<is> 里的文字：直接的 <t> 加上富文本 <r><t>，不要注音 <rPh>。"""
    if el is None:
        return ""
    parts = []
    for child in el:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "t":
            parts.append(child.text or "")
        elif tag == "r":
            t = child.find("m:t", NS)
            parts.append((t.text or "") if t is not None else "")
    return "".join(parts)


def read_xlsx(data: bytes) -> tuple[dict[str, list[list]], bool]:
    """返回 ({表名: 行列表}, 是否 1904 日期制)。数字是 float/int，文字是 str，空格子是 None。"""
    try:
        z = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile:
        raise TrackerError("这不是 .xlsx 文件（如果是 .xls 或 .xlsm 以外的老格式，请在 Excel 里另存为 .xlsx）")
    names = set(z.namelist())
    if "xl/workbook.xml" not in names:
        raise TrackerError("文件里找不到工作簿内容，不像是 Excel 文件")
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    pr = wb.find("m:workbookPr", NS)
    date1904 = pr is not None and pr.get("date1904") in ("1", "true")
    rels = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).findall("rel:Relationship", NS):
            target = r.get("Target", "")
            target = target[1:] if target.startswith("/") else str(PurePosixPath("xl") / target)
            rels[r.get("Id")] = target
    shared = []
    if "xl/sharedStrings.xml" in names:
        shared = [_text(si) for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS)]
    sheets: dict[str, list[list]] = {}
    total = 0
    for s in wb.findall("m:sheets/m:sheet", NS):
        path = rels.get(s.get(R_ID), "")
        if path not in names:
            continue
        rows: list[list] = []
        for row in ET.fromstring(z.read(path)).iterfind("m:sheetData/m:row", NS):
            ri = int(row.get("r", len(rows) + 1)) - 1
            while len(rows) < ri:
                rows.append([])
            vals: list = []
            for c in row.findall("m:c", NS):
                ci = _col_index(c.get("r", "")) if c.get("r") else len(vals)
                t = c.get("t", "n")
                v = c.find("m:v", NS)
                raw = v.text if v is not None else None
                if t == "s":
                    val = shared[int(raw)] if raw is not None and raw.isdigit() and int(raw) < len(shared) else None
                elif t == "inlineStr":
                    val = _text(c.find("m:is", NS))
                elif t in ("str", "e"):
                    val = raw
                elif t == "b":
                    val = raw == "1"
                elif raw is None:
                    val = None
                else:
                    try:
                        f = float(raw)
                        val = int(f) if f.is_integer() and "E" not in raw.upper() and "." not in raw else f
                    except ValueError:
                        val = raw
                while len(vals) < ci:
                    vals.append(None)
                if ci == len(vals):
                    vals.append(val)
                else:
                    vals[ci] = val
                total += 1
                if total > MAX_CELLS:
                    raise TrackerError("表太大了（超过 200 万个格子）")
            rows.append(vals)
        sheets[s.get("name", "")] = rows
    return sheets, date1904


# ---------------------------------------------------------------- 值的整理

def _excel_date(n: float, date1904: bool) -> dt.date | None:
    if not (20000 < n < 80000):  # 1954–2119 之间才当日期，其余是普通数字
        return None
    base = dt.date(1904, 1, 1) if date1904 else dt.date(1899, 12, 30)
    return base + dt.timedelta(days=int(n))


_DATE_PATTERNS = [
    (re.compile(r"^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})"), "ymd"),
    (re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$"), "mdY"),
    (re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{2})$"), "mdy"),
]


def to_date(v, date1904: bool = False) -> dt.date | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return _excel_date(float(v), date1904)
    s = str(v).strip()
    for rx, kind in _DATE_PATTERNS:
        m = rx.match(s)
        if not m:
            continue
        a, b, c = (int(x) for x in m.groups())
        try:
            if kind == "ymd":
                return dt.date(a, b, c)
            if kind == "mdY":
                return dt.date(c, a, b)
            return dt.date(2000 + c, a, b)
        except ValueError:
            return None
    return None


def _placeholder(d: dt.date | None) -> bool:
    return d is not None and d.year <= 2000  # 总表里 1/1/2000 之类是占位


def _s(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).strip()


def _num(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return v
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        return None


def _iso(d: dt.date | None) -> str | None:
    return d.isoformat() if d else None


def _uniq(items):
    out = []
    for x in items:
        if x not in ("", None) and x not in out:
            out.append(x)
    return out


# ---------------------------------------------------------------- 总表 → 订单

def find_header(rows: list[list]) -> tuple[int, dict[str, int]]:
    for i, row in enumerate(rows[:10]):
        cells = [_s(v) for v in row]
        if "WO#" in cells and "WO Due" in cells:
            return i, {name: j for j, name in enumerate(cells) if name}
    raise TrackerError("「订单明细」前 10 行里找不到表头（要有 WO# 和 WO Due 两列）")


def find_note(sheets: dict[str, list[list]]) -> str:
    """跟单进展等表上写的「最后更新时间 …」。"""
    for rows in sheets.values():
        for row in rows[:5]:
            for v in row:
                s = _s(v)
                if s.startswith("最后更新时间"):
                    return s
    return ""


def vendor_name(v: str) -> str:
    return VENDOR_CN.get(v.strip().lower(), v.strip())


def line_closed(line: dict) -> bool:
    note = line["note"]
    return note == "完成" or "取消" in note or bool(line["shipped"])


def parse_tracker(data: bytes) -> dict:
    sheets, d1904 = read_xlsx(data)
    if DETAIL_SHEET not in sheets:
        raise TrackerError(f"找不到「{DETAIL_SHEET}」这张表；现有的表：{'、'.join(sheets) or '没有'}")
    rows = sheets[DETAIL_SHEET]
    hi, H = find_header(rows)
    need = ["WO#", "WO Due", "Vendor", "P/N", "备注"]
    missing = [c for c in need if c not in H]
    if missing:
        raise TrackerError(f"「{DETAIL_SHEET}」缺少这些列：{'、'.join(missing)}")

    def get(row, name):
        j = H.get(name)
        return row[j] if j is not None and j < len(row) else None

    groups: dict[tuple[str, str], list[dict]] = {}
    for row in rows[hi + 1:]:
        wo = _s(get(row, "WO#"))
        if not wo:
            continue
        vendor = vendor_name(_s(get(row, "Vendor")))
        dates = {c: to_date(get(row, c), d1904) for c in DATE_COLS}
        eta_raw = get(row, "预计发货日期")
        line = {
            "pn": _s(get(row, "P/N")),
            "rev": _s(get(row, "Rev")),
            "desc": _s(get(row, "Description")),
            "qty": _num(get(row, "WO Q'ty")),
            "unit_price": _num(get(row, "WO RMB")),
            "amount": _num(get(row, "WO Sub")),
            "customer_po": _s(get(row, "PO #")),
            "customer_line": _s(get(row, "Line Item")),
            "end_user": _s(get(row, "End User")),
            "customer_due": _iso(dates["Due Date"]),
            "wo_date": _iso(dates["WO Date"]),
            "wo_due": _iso(dates["WO Due"]),
            "invoice": _s(get(row, "Invoice #")),
            "next_step": _s(get(row, "Next Step")),
            "clean_no": _s(get(row, "清洗单号")),
            "logistics": _s(get(row, "物流状态")),
            "shipped": _iso(dates["发货日期"]) if not _placeholder(dates["发货日期"]) else None,
            "eta": _iso(dates["预计发货日期"]) or (_s(eta_raw) if not dates["预计发货日期"] else ""),
            "note": _s(get(row, "备注")),
        }
        line["closed"] = line_closed(line)
        groups.setdefault((wo, vendor), []).append(line)

    orders = []
    for (wo, vendor), lines in groups.items():
        open_lines = [ln for ln in lines if not ln["closed"]]
        basis = open_lines or lines
        dues = sorted({ln["wo_due"] for ln in basis if ln["wo_due"]})
        all_dues = sorted({ln["wo_due"] for ln in lines if ln["wo_due"]})
        cancelled = all("取消" in ln["note"] for ln in lines)
        closed = all(ln["closed"] for ln in lines)
        amounts = [ln["amount"] for ln in lines if isinstance(ln["amount"], (int, float))]
        notes = _uniq(ln["note"] for ln in basis)
        shipped = sorted({ln["shipped"] for ln in lines if ln["shipped"]})
        etas = _uniq(ln["eta"] for ln in basis)
        orders.append({
            "source": "tracker",
            "po": wo,
            "supplier": vendor,
            "customer_po": " / ".join(_uniq(ln["customer_po"] for ln in lines)),
            "end_user": " / ".join(_uniq(ln["end_user"] for ln in lines)),
            "order_date": min((ln["wo_date"] for ln in lines if ln["wo_date"]), default=None),
            "due_date": dues[0] if dues else None,
            "due_text": "、".join(f"{int(d[5:7])}/{int(d[8:10])}" for d in all_dues) if len(all_dues) > 1 else "",
            "customer_due": min((ln["customer_due"] for ln in basis if ln["customer_due"]), default=None),
            "amount": round(sum(amounts), 2) if amounts else None,
            "currency": "RMB",
            "closed": closed,
            "status": ("已取消" if cancelled else "完成") if closed else "",
            "notes": notes,
            "eta": etas,
            "shipped": shipped,
            "open_lines": len(open_lines),
            "lines": lines,
        })
    return {"note": find_note(sheets), "rows": sum(len(v) for v in groups.values()), "orders": orders}

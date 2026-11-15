"""把跟单总表（.xlsx）导入成页面的起点数据 data/orders.json。只用 Python 标准库。

    python3 import_tracker.py 跟单总表20261111.xlsx --data ~/apps/po-tracker/data --dry-run   # 只看结果
    python3 import_tracker.py 跟单总表20261111.xlsx --data ~/apps/po-tracker/data             # 真的写

- 总表为准：304 个 WO 全部进来（结束的显示成 已完成 / 已发货 / 已取消，默认筛选里看不到）。
- 原来从邮件整理的 PO：同号同供应商的（44278 兴华对总表的 44278A 这种「号后面多一个字母」也算）把相关邮件、旧号带过来；
  没结束的单，邮件里已经是「已确认」的保留「已确认」，其余记「已下单」。总表里没有的邮件 PO 原样保留。
- 原 orders.json 先备份成 orders.before-import-<时间>.json；邮件整理的那份另存 orders.mail.json，以后再导入从它拿。
- edits.json / history.jsonl（网页上的改动）不动，照样盖在上面。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
from pathlib import Path

import tracker
from edits import order_key, write_atomic

KEEP_FROM_MAIL = ("mails", "last_mail_at", "buyer_entity", "customer", "tax")


def sheet_label(filename: str) -> str:
    m = re.search(r"20\d\d(\d\d)(\d\d)", filename)
    return f"跟单总表 {int(m.group(1))}/{int(m.group(2))}" if m else "跟单总表"


def fmt_eta(values: list[str]) -> str:
    """预计发货：一个日期就原样（页面会格式化）；多个就写成 11/20、随时。"""
    if len(values) == 1:
        return values[0]
    out = []
    for v in values:
        out.append(f"{int(v[5:7])}/{int(v[8:10])}" if re.match(r"^\d{4}-\d{2}-\d{2}$", v) else v)
    return "、".join(out)


def page_line(ln: dict) -> dict:
    keep = ("pn", "rev", "desc", "qty", "unit_price", "amount", "customer_po", "customer_line", "wo_due", "shipped",
            "eta", "note", "closed", "next_step", "invoice", "clean_no")
    return {k: ln[k] for k in keep if ln.get(k) not in (None, "")} | {"closed": ln["closed"]}


def match_mail(t: dict, mail_by_key: dict, mail_orders: list[dict]) -> dict | None:
    m = mail_by_key.get(order_key(t))
    if m:
        return m
    po, sup = str(t["po"]), t["supplier"]
    # 总表把重号的改成 44278A 这种：邮件号 + 一个字母，供应商相同
    cands = [o for o in mail_orders if (o.get("supplier") or "") == sup and re.fullmatch(re.escape(str(o.get("po"))) + r"[A-Za-z]", po)]
    return cands[0] if len(cands) == 1 else None


def build(parsed: dict, mail_orders: list[dict], label: str) -> tuple[list[dict], dict]:
    mail_by_key = {order_key(o): o for o in mail_orders}
    used: set[int] = set()
    out: list[dict] = []
    report = {"matched": [], "status_differs": [], "due_differs": []}
    for t in parsed["orders"]:
        m = match_mail(t, mail_by_key, mail_orders)
        if t["closed"]:
            status = t["status"]
        else:
            status = "已确认" if m and m.get("status") == "已确认" else "已下单"
        o = {
            "po": t["po"],
            "supplier": t["supplier"],
            "status": status,
            "due_date": t["due_date"],
            "due_text": t["due_text"],
            "order_date": t["order_date"],
            "customer_due": t["customer_due"],
            "customer_po": t["customer_po"],
            "end_user": t["end_user"],
            "amount": t["amount"],
            "currency": "RMB",
            "lines": [page_line(ln) for ln in t["lines"]],
            "open_lines": t["open_lines"],
            "source": "tracker",
        }
        if not t["closed"] and t["notes"]:
            o.update(note="；".join(t["notes"]), note_by=label)
        if not t["closed"] and t["eta"]:
            o["eta"] = fmt_eta(t["eta"])
        if t["shipped"]:
            o["shipped"] = t["shipped"]
        if m is not None:
            used.add(id(m))
            for k in KEEP_FROM_MAIL:
                if m.get(k):
                    o[k] = m[k]
            aliases = [a for a in [*(m.get("aliases") or []), str(m.get("po"))] if a and a != o["po"]]
            if aliases:
                o["aliases"] = sorted(set(aliases))
            o["mail_status"] = m.get("status") or ""
            report["matched"].append(f"{m.get('po')}|{m.get('supplier') or ''} → {order_key(o)}")
            if (m.get("status") or "") != status:
                report["status_differs"].append({"key": order_key(o), "mail": m.get("status"), "sheet": status,
                                                 "sheet_note": o.get("note", "")})
            if m.get("due_date") != o["due_date"]:
                report["due_differs"].append({"key": order_key(o), "mail": m.get("due_date"), "sheet": o["due_date"]})
        out.append(o)
    mail_only = [o for o in mail_orders if id(o) not in used]
    for o in mail_only:
        out.append({**o, "source": "mail"})
    report["mail_only"] = [{"key": order_key(o), "status": o.get("status"), "due_date": o.get("due_date")} for o in mail_only]
    pos: dict[str, list[str]] = {}
    for o in out:
        pos.setdefault(str(o["po"]), []).append(o.get("supplier") or "")
    report["same_po_two_suppliers"] = {p: s for p, s in pos.items() if len(s) > 1}
    return out, report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="把跟单总表导入成 PO 跟单页的起点数据")
    ap.add_argument("sheet", type=Path)
    ap.add_argument("--data", type=Path, required=True)
    ap.add_argument("--name", help="页面上显示的文件名（默认用 sheet 的文件名）")
    ap.add_argument("--dry-run", action="store_true", help="只打印结果，不写文件")
    a = ap.parse_args(argv)
    data_dir = a.data.expanduser()
    name = a.name or a.sheet.name
    label = sheet_label(name)
    try:
        parsed = tracker.parse_tracker(a.sheet.expanduser().read_bytes())
    except tracker.TrackerError as e:
        print(f"读不了：{e}", file=sys.stderr)
        return 2
    orders_path = data_dir / "orders.json"
    try:
        old = json.loads(orders_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        old = {}
    # 邮件整理的那份：第一次导入时另存成 orders.mail.json，以后再导入都从它拿（总表来的不能当邮件 PO）
    mail_path = data_dir / "orders.mail.json"
    if old.get("base") == "tracker":
        try:
            mail_doc = json.loads(mail_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            mail_doc = {"orders": [o for o in old.get("orders", []) if isinstance(o, dict) and o.get("source") == "mail"]}
    else:
        mail_doc = old
    mail_orders = [o for o in mail_doc.get("orders", []) if isinstance(o, dict) and o.get("source") in (None, "mail")]
    orders, report = build(parsed, mail_orders, label)

    try:
        ed = json.loads((data_dir / "edits.json").read_text(encoding="utf-8"))
        patch_keys = set((ed.get("patches") or {}).keys())
    except (OSError, ValueError, AttributeError):
        patch_keys = set()
    keys = {order_key(o) for o in orders}
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    summary = {
        "sheet": name,
        "label": label,
        "sheet_note": parsed["note"],
        "rows": parsed["rows"],
        "orders_total": len(orders),
        "from_sheet": len(parsed["orders"]),
        "open": sum(1 for o in orders if o["status"] not in ("已发货", "已完成", "已取消")),
        "by_status": {s: sum(1 for o in orders if o["status"] == s) for s in ("未定", "已下单", "已确认", "已发货", "已完成", "已取消")},
        "mail_orders_before": len(mail_orders),
        "matched_count": len(report["matched"]),
        "web_edits_kept": len(patch_keys & keys),
        "web_edits_orphaned": sorted(patch_keys - keys),
        **report,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=1))
    if a.dry_run:
        return 0
    if orders_path.exists():
        backup = data_dir / f"orders.before-import-{dt.datetime.now():%Y%m%d-%H%M%S}.json"
        shutil.copy2(orders_path, backup)
        print(f"原 orders.json 备份到 {backup}", file=sys.stderr)
        if old.get("base") != "tracker":
            shutil.copy2(orders_path, mail_path)
    doc = {
        "version": 1,
        "generated_at": now,
        "base": "tracker",
        "sheet_file": name,
        "sheet_label": label,
        "sheet_note": parsed["note"],
        "mail_generated_at": mail_doc.get("generated_at"),
        "orders": orders,
    }
    write_atomic(orders_path, json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"已写 {orders_path}：{len(orders)} 个 PO", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

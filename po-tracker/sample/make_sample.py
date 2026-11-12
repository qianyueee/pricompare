#!/usr/bin/env python3
"""生成假的 orders.json（日期相对今天），本地看页面效果用。里面的号码、人名、金额全是编的。

  python3 sample/make_sample.py /tmp/po-data/orders.json
"""
import datetime as dt
import json
import sys
from pathlib import Path

today = dt.date.today()
now = dt.datetime.now().astimezone()


def d(days):
    return (today + dt.timedelta(days=days)).isoformat()


def t(days, hour=10):
    return (now.replace(hour=hour, minute=12, second=0, microsecond=0) + dt.timedelta(days=days)).isoformat()


def mails(*items):
    return [{"folder": f, "uid": u, "date": t(day, h), "from": who, "subject": s} for f, u, day, h, who, s in items]


def line(pn, rev, desc, qty, price):
    return {"pn": pn, "rev": rev, "desc": desc, "qty": qty, "unit_price": price, "amount": round(qty * price, 2)}


ORDERS = [
    dict(po="90121", supplier="华晨", buyer_entity="Kavis Tech LLC", customer_po="C-700412", customer="客户 A", end_user="Alex Moreno",
         order_date=d(-18), due_date=d(-3),
         amount=16724, currency="RMB", tax="含税", status="已确认", status_note="供应商回 confirmed",
         lines=[line("9000101-000", "AB", "BRACKET, MOUNTING", 10, 512), line("9000102-001", "AA", "PLATE, COVER", 20, 280.2), line("9000103-000", "AC", "SPACER", 40, 150)],
         open_issues=["交期已过，没看到发货邮件"], tracking=""),
    dict(po="90133", supplier="凯维", buyer_entity="Kavis Tech LLC", customer_po="C-700455 / C-700456", customer="客户 A", end_user="Priya Natarajan",
         order_date=d(-12), due_date=d(0), due_text="", amount=9252, currency="RMB", tax="含税", status="已确认", status_note="凯维回「订单已收到」",
         lines=[line("9000201-000", "AA", "SHAFT, GUIDE", 6, 920), line("9000202-000", "AA", "COLLAR", 12, 311)], open_issues=[]),
    dict(po="90140", supplier="华晨", buyer_entity="Kavis Tech LLC", customer_po="C-700501", customer="客户 A", end_user="Dana Whitfield",
         order_date=d(-9), due_date=d(2), amount=17915, currency="RMB", tax="含税", status="已下单", status_note="改成 10 行重发后还没回复",
         lines=[line(f"90003{i:02d}-000", "AA", "PART", 2 + i, 100 + 37 * i) for i in range(10)],
         open_issues=["改成 10 行后没看到供应商确认", "3D 文件补发后供应商未回复"]),
    dict(po="90142A", aliases=["90139"], supplier="兴华", buyer_entity="深圳凯阔", customer_po="TBD", customer="客户 B", end_user="Marco Li",
         order_date=d(-10), due_date=d(6), due_text="", amount=8940, currency="RMB", tax="未税", status="已确认", status_note="盖章 PO 已回传",
         lines=[line("9000401-000", "AB", "CHASSIS, SHEET METAL", 3, 1650), line("9000402-000", "AA", "RAIL, SLIDE", 6, 150), line("9000403-000", "AA", "HINGE", 3, 150)],
         open_issues=["加项（导轨 6 件）报价后订单还没改"]),
    dict(po="90150", supplier="凯维", buyer_entity="Kavis Tech LLC", customer_po="C-700610", customer="客户 A", end_user="Sue Tan",
         order_date=d(-5), due_date=d(14), amount=12603, currency="RMB", tax="含税", status="已确认", status_note="凯维已收到；发往第三方仓库",
         lines=[line("9000501-000", "AA", "BLOCK, ALIGNMENT", 30, 420.1)], open_issues=[]),
    dict(po="90151", supplier="华晨", buyer_entity="Kavis Tech LLC", customer_po="C-700633", customer="客户 A", end_user="Kenji Ota",
         order_date=d(-4), due_date=d(9), amount=36680, currency="RMB", tax="含税", status="已确认", status_note="从 38,440 谈到 36,680",
         lines=[line("9000601-000", "AD", "HOUSING, CNC", 8, 3100), line("9000602-000", "AB", "LID", 8, 1485)], open_issues=[]),
    dict(po="90155", supplier="", buyer_entity="", customer_po="C-700700", customer="客户 A", end_user="Dana Whitfield",
         order_date=None, due_date=None, due_text="WO 下月初", amount=None, currency="", tax="", status="未定", status_note="两家报价都在等 Tony 定",
         lines=[line("9000701-000", "AA", "FRAME", 4, 0)], open_issues=["供应商还没定（凯维 12,150 / 华晨 13,650）"]),
    dict(po="90108", supplier="华晨", buyer_entity="Kavis Tech LLC", customer_po="C-700300", customer="客户 C", end_user="Noa Ben-David",
         order_date=d(-30), due_date=d(-12), amount=2712, currency="RMB", tax="含税", status="已发货", status_note="DHL 已发出", tracking="DHL 1234567890",
         lines=[line("9000801-000", "AA", "PIN", 20, 135.6)], open_issues=[]),
    dict(po="90099", supplier="华晨", buyer_entity="Kavis Tech LLC", customer_po="C-700201", customer="客户 A", end_user="Alex Moreno",
         order_date=d(-40), due_date=None, due_text="", amount=None, currency="", tax="", status="已下单", status_note="只在质量问题邮件里出现",
         lines=[], open_issues=["销子数量 20 还是 40 没说定"]),
    dict(po="90150", supplier="兴华", buyer_entity="深圳凯阔", customer_po="TBD", customer="客户 B", end_user="Marco Li",
         order_date=d(-2), due_date=d(18), amount=4300, currency="RMB", tax="未税", status="已下单", status_note="同号给了两家供应商",
         lines=[line("9000551-000", "AA", "PANEL", 2, 2150)], open_issues=["PO 号和凯维那张重了"],
         doubts=["标题写交期 11/28，PO 单写 11/30，取了后者"]),
    dict(po="90160", supplier="凯维", buyer_entity="Kavis Tech LLC", customer_po="C-700812", customer="客户 A", end_user="Lena Fischer",
         order_date=d(-1), due_date=d(4), amount=972, currency="RMB", tax="含税", status="已下单", status_note="", lines=[line("9000901-000", "AA", "WASHER", 3, 324)], open_issues=[]),
]

for i, o in enumerate(ORDERS):
    o.setdefault("aliases", [])
    o.setdefault("customer_due", None)
    o.setdefault("tracking", "")
    o.setdefault("due_text", "")
    o["mails"] = mails(
        ("收件箱", 900 + i * 3, -1 - i, 15, "供应商", f"Re: PO {o['po']}"),
        ("已发送", 300 + i * 2, -3 - i, 9, "Gene", f"PO {o['po']} Due {o.get('due_text') or o.get('due_date') or ''}"),
    )
    o["last_mail_at"] = o["mails"][0]["date"]
    o["updated_at"] = now.isoformat(timespec="seconds")

doc = {"version": 1, "generated_at": now.isoformat(timespec="seconds"), "source": "zill@kvstek.com（假数据）",
       "po_mail_count": 42, "orders": ORDERS}
out = Path(sys.argv[1] if len(sys.argv) > 1 else "orders.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"写了 {out}（{len(ORDERS)} 个假 PO）")

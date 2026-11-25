"""开 Invoice：勾选的 PO → 按供应商等级算服务费 → 记下来（data/invoices.json）→ 导出 Excel（invoice_xlsx.py）。只用标准库。

Zane 2026-11-15：
- 费率按三个服务等级：3 级凯维 5%，2 级华晨 25%，其他供应商 1 级 40%。先按这个默认，预览里可以改。
- 每一行可以选收不收订单金额：2、3 级默认是美方直接付供应商，只收服务费；1 级是我们自己付，订单金额也收。
抬头、电话、邮箱、地址、联系人放 data/invoice.json（只在 Mac 上，不进公开仓库），没写的用下面的默认值。
"""
from __future__ import annotations

import copy
import json
import re
import threading
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from edits import EditError, _clean, clean_amount, clean_date, write_atomic

DEFAULT_CONFIG: dict = {
    "company": "",  # 抬头公司名
    "phone": "",
    "email": "",
    "contact": "",  # 客户联系人（默认值，预览里可改）
    "ship_to": [],  # 每行一段，如 ["Attn: …", "（公司）", "（地址）", …]
    "bill_to": [],
    "number_suffix": "K",  # 发票号默认 = 发票日期 yymmdd + 这个
    "footer": ["如有任何问题或疑虑，请致电{phone}联系我们。", "感谢您的惠顾！"],
    "tiers": {
        "3": {"rate": 5, "with_amount": False},
        "2": {"rate": 25, "with_amount": False},
        "1": {"rate": 40, "with_amount": True},
    },
    "default_tier": 1,
    "vendors": {
        "凯维": {"en": "Shenzhen Kaiwei", "tier": 3},
        "华晨": {"en": "Huachen", "tier": 2},
        "兴华": {"en": "Xinghua"},
        # Vendor 写 Kaikuo（凯阔，就是我们）= 我们自己付订单金额；invoice 上写真正做的下级 vendor（邮件正文里有就带上，没有就手填）
        "凯阔": {"en": "", "tier": 1, "with_amount": True},
    },
}
MAX_ROWS = 300
NO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$")
CLOSED = ("已发货", "已完成")
CENT = Decimal("0.01")


def load_config(data: Path) -> dict:
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    try:
        mine = json.loads((data / "invoice.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        mine = {}
    if not isinstance(mine, dict):
        return cfg
    for k, v in mine.items():
        if k.startswith("_") or k not in cfg:
            continue
        if isinstance(cfg[k], dict) and isinstance(v, dict):
            for kk, vv in v.items():
                cfg[k][str(kk)] = {**cfg[k].get(str(kk), {}), **vv} if isinstance(vv, dict) else vv
        elif type(v) is type(cfg[k]) or (k == "default_tier" and isinstance(v, int)):
            cfg[k] = v
    return cfg


def vendor_defaults(cfg: dict, supplier: str | None, sub_vendor: str | None = None) -> dict:
    """invoice 一行的默认值：Vendor 显示名、等级、费率、收不收订单金额。等级按供应商（凯阔按 1 级），显示名优先用下级 vendor。"""
    v = cfg["vendors"].get(supplier or "", {})
    tier = v.get("tier", cfg["default_tier"])
    t = cfg["tiers"].get(str(tier), cfg["tiers"].get(str(cfg["default_tier"]), {}))
    return {
        "vendor": sub_vendor or (v["en"] if "en" in v else supplier) or "",
        "tier": tier,
        "rate": v.get("rate", t.get("rate", 0)),
        "with_amount": bool(v.get("with_amount", t.get("with_amount", False))),
    }


def done_date(o: dict) -> str:
    """完成日期默认值：总表里最晚的发货日期；没有就取网页上最近一次改成已发货/已完成的日子；都没有为空。"""
    ds = [str(d) for d in o.get("shipped") or [] if d]
    ds += [str(ln.get("shipped")) for ln in o.get("lines") or [] if isinstance(ln, dict) and ln.get("shipped")]
    ds = [d[:10] for d in ds if re.match(r"^\d{4}-\d{2}-\d{2}", d)]
    if ds:
        return max(ds)
    for h in o.get("history") or []:  # 新的在前
        st = (h.get("changes") or {}).get("status") if isinstance(h, dict) else None
        if isinstance(st, list) and len(st) == 2 and st[1] in CLOSED:
            return str(h.get("at") or "")[:10]
    return ""


def money(x) -> float:
    d = Decimal(str(x)).quantize(CENT, ROUND_HALF_UP)
    return int(d) if d == d.to_integral_value() else float(d)


def _rate(v) -> float:
    try:
        n = float(str(v).replace("%", "").strip())
    except ValueError:
        raise EditError("服务费 % 要是数字") from None
    if not 0 <= n <= 100:
        raise EditError("服务费 % 要在 0 到 100 之间")
    return int(n) if n.is_integer() else round(n, 4)


def _tier(v, cfg: dict, default) -> int:
    if v in (None, ""):
        return default
    try:
        t = int(str(v).strip())
    except ValueError:
        t = None
    if t is None or str(t) not in cfg["tiers"]:
        raise EditError("Service Tier 只能是 " + " / ".join(sorted(cfg["tiers"], reverse=True)))
    return t


def build(payload, orders_by_key: dict[str, dict], cfg: dict) -> dict:
    """检查网页发来的 invoice，按服务器的数据补上 PO 号、供应商，重新算钱。"""
    if not isinstance(payload, dict):
        raise EditError("请求不对")
    no = _clean(payload.get("no"), 30, "发票号")
    if not NO_RE.match(no):
        raise EditError("发票号只能用字母、数字、- 和 _（最多 30 个）")
    date = clean_date(payload.get("date"), "发票日期")
    if not date:
        raise EditError("请填发票日期")
    contact = _clean(payload.get("contact"), 40, "客户联系人")
    usd_rate = payload.get("usd_rate")
    if usd_rate in (None, ""):
        usd_rate = None
    else:
        try:
            usd_rate = float(usd_rate)
        except (TypeError, ValueError):
            raise EditError("汇率要是数字") from None
        if not 0.01 <= usd_rate <= 100:
            raise EditError("汇率不对（人民币兑 1 美元，例如 7.1）")
    rows_in = payload.get("rows")
    if not isinstance(rows_in, list) or not rows_in:
        raise EditError("还没选 PO")
    if len(rows_in) > MAX_ROWS:
        raise EditError(f"一张 invoice 最多 {MAX_ROWS} 个 PO")
    rows, seen = [], set()
    for r in rows_in:
        if not isinstance(r, dict):
            raise EditError("请求不对")
        key = str(r.get("key") or "")
        o = orders_by_key.get(key)
        if o is None:
            raise EditError(f"找不到 {key.replace('|', ' ')}（可能刚被删了），请刷新", 404)
        if key in seen:
            raise EditError(f"{o.get('po')} 选了两次")
        seen.add(key)
        amount = clean_amount(r.get("amount"))
        if amount is None:
            raise EditError(f"{o.get('po')} 没填订单金额")
        rate = _rate(r.get("rate"))
        d = vendor_defaults(cfg, o.get("supplier"), o.get("sub_vendor"))
        tier = _tier(r.get("tier"), cfg, d["tier"])
        with_amount = r.get("with_amount") is True
        fee = Decimal(str(amount)) * Decimal(str(rate)) / 100
        fee = fee.quantize(CENT, ROUND_HALF_UP)
        due = fee + (Decimal(str(amount)) if with_amount else 0)
        vendor = _clean(r.get("vendor"), 40, f"{o.get('po')} 的 Vendor")
        if not vendor:
            raise EditError(f"{o.get('po')} 的 Vendor 没填（Kaikuo 的单请写下级 vendor）")
        rows.append({
            "key": key, "po": str(o.get("po") or ""), "supplier": o.get("supplier") or "", "vendor": vendor,
            "done": clean_date(r.get("done"), f"{o.get('po')} 的完成日期"),
            "amount": amount, "tier": tier, "rate": rate, "with_amount": with_amount, "fee": money(fee), "due": money(due),
        })
    vendors: dict[str, dict] = {}
    for r in rows:
        v = vendors.setdefault(r["vendor"], {"vendor": r["vendor"], "count": 0, "amount": Decimal(0), "fee": Decimal(0),
                                             "due": Decimal(0), "rates": [], "tiers": []})
        v["count"] += 1
        for k in ("amount", "fee", "due"):
            v[k] += Decimal(str(r[k]))
        for k in ("rate", "tier"):
            if r[k] not in v[k + "s"]:
                v[k + "s"].append(r[k])
    vend = [{**v, "amount": money(v["amount"]), "fee": money(v["fee"]), "due": money(v["due"]),
             "rate": v["rates"][0] if len(v["rates"]) == 1 else None,
             "tier": v["tiers"][0] if len(v["tiers"]) == 1 else None} for v in vendors.values()]
    for v in vend:
        del v["rates"], v["tiers"]
    total = sum((Decimal(str(r["due"])) for r in rows), Decimal(0))
    return {
        "no": no, "date": date, "contact": contact, "usd_rate": usd_rate,
        "rows": rows, "vendors": vend,
        "fee_total": money(sum((Decimal(str(r["fee"])) for r in rows), Decimal(0))),
        "amount_billed": money(sum((Decimal(str(r["amount"])) for r in rows if r["with_amount"]), Decimal(0))),
        "total": money(total),
        "usd": money(total / Decimal(str(usd_rate))) if usd_rate else None,
        "with_amount": any(r["with_amount"] for r in rows),
    }


def fill_tiers(inv: dict, cfg: dict) -> dict:
    """加 Service Tier 之前存的 invoice 没有等级：按费率对回等级（5% → 3、25% → 2、40% → 1），对不上就空着。"""
    by_rate = {}
    for k, t in cfg["tiers"].items():
        by_rate.setdefault(t.get("rate"), int(k))
    rows = [{**r, "tier": r.get("tier") or by_rate.get(r.get("rate"))} for r in inv.get("rows") or []]
    vendors = []
    for v in inv.get("vendors") or []:
        ts = {r["tier"] for r in rows if r.get("vendor") == v.get("vendor")}
        vendors.append({**v, "tier": v.get("tier") or (ts.pop() if len(ts) == 1 else None)})
    return {**inv, "rows": rows, "vendors": vendors}


class InvoiceStore:
    """开过的 invoice：data/invoices.json，按发票号存（同号再存就是改这张）。"""

    def __init__(self, data: Path):
        self.path = data / "invoices.json"
        self.lock = threading.Lock()

    def load(self) -> dict[str, dict]:
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {}
        except (OSError, ValueError) as e:
            raise EditError(f"invoices.json 读不了（{e.__class__.__name__}），请 Zane 在 Mac 上看一下", 500) from None
        inv = doc.get("invoices") if isinstance(doc, dict) else None
        return {str(k): v for k, v in inv.items() if isinstance(v, dict)} if isinstance(inv, dict) else {}

    def save(self, invoices: dict[str, dict]) -> None:
        write_atomic(self.path, json.dumps({"version": 1, "invoices": invoices}, ensure_ascii=False, indent=1))

    def summary(self) -> tuple[list[dict], dict[str, list[dict]]]:
        """(列表：新的在前, 每个 PO 开进过哪些 invoice)。文件坏了就当没有，不影响看页面。"""
        try:
            invoices = self.load()
        except EditError:
            return [], {}
        listing, marks = [], {}
        for no, inv in invoices.items():
            listing.append({"no": no, "date": inv.get("date"), "count": len(inv.get("rows") or []), "total": inv.get("total"),
                            "saved_at": inv.get("saved_at"), "saved_by": inv.get("saved_by")})
            for r in inv.get("rows") or []:
                if isinstance(r, dict) and r.get("key"):
                    marks.setdefault(str(r["key"]), []).append({"no": no, "date": inv.get("date")})
        listing.sort(key=lambda x: (str(x.get("date") or ""), str(x.get("saved_at") or "")), reverse=True)
        return listing, marks

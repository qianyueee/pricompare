"""做采购订单（凯阔 → 供方），版式照 Zane 11-15 给的采购订单样张。只用标准库。

Zane 2026-11-15：「po网页增加制作采购订单的功能，格式按照这个pdf，内容根据po内容填充，tony的po都是税后价格」。所以：
- 订单编号 PO-<PO 号>、交付日期 = 供应商交期、客户订单号 = 客户 PO（没有就写「待定 (TBD)」），
  零件行（行号、P/N、版本、描述、数量）从这个 PO 带出来；
- 单价按未税填：PO 上的单价是含税价，÷ (1 + 税率) 四舍五入到分；预览里都能改；
- 小计 = 数量 × 单价，含税总计 = 总计 × (1 + 税率)，跟样张一样。
抬头、收货信息、条款放 data/purchase.json；供方（全称 + 地址、电话、税号这些行）存 data/purchase_vendors.json，
保存一次下次同一家自动带出。都只在 Mac 上，不进公开仓库。做过的采购订单存 data/purchases.json（按订单编号）。
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
    "buyer": {"name": "", "lines": []},  # 抬头：公司名 + 下面几行（地址、电话邮箱）
    "ship_to": {"name": "", "lines": []},  # 收货信息：公司名 + 地址、联系人电话
    "tax_rate": 13,  # %
    "number_prefix": "PO-",
    "tbd": "待定 (TBD)",  # 没有客户 PO 时客户订单号写这个
    # 每条「标题：正文」，标题打印成粗体；{no} 换成订单编号
    "terms": [
        "交货地点与方式：供方负责将货物运送至需方指定收货地址。",
        "质量与验收标准：所有产品须严格按照图纸、版本号（Rev）及双方确认的技术规范生产，随货附带出厂检验合格报告及送货单（需注明订单编号 {no}）。",
        "包装要求：防潮、防震、防刮花妥善包装，确保运输过程完好无损。",
        "联络与咨询：如有任何疑问或交期异常，请及时联系需方。",
    ],
}
SELF = {"凯阔", "kaikuo"}  # 供应商写凯阔 = 我们自己下给下级 vendor
NO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
MAX_LINES = 100
MAX_PARTY_LINES = 6
MAX_TERMS = 12
CENT = Decimal("0.01")
DIGITS = "零壹贰叁肆伍陆柒捌玖"


def load_config(data: Path) -> dict:
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    try:
        mine = json.loads((data / "purchase.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        mine = {}
    if not isinstance(mine, dict):
        return cfg
    for k, v in mine.items():
        if k.startswith("_") or k not in cfg:
            continue
        if isinstance(cfg[k], dict) and isinstance(v, dict):
            cfg[k] = {"name": str(v.get("name") or ""), "lines": [str(x) for x in v.get("lines") or [] if str(x).strip()]}
        elif k == "terms" and isinstance(v, list):
            cfg[k] = [str(x) for x in v if str(x).strip()]
        elif isinstance(v, type(cfg[k])) or (k == "tax_rate" and isinstance(v, (int, float)) and not isinstance(v, bool)):
            cfg[k] = v
    return cfg


def money(x) -> float:
    d = Decimal(str(x)).quantize(CENT, ROUND_HALF_UP)
    return int(d) if d == d.to_integral_value() else float(d)


def _four(n: int) -> str:
    s, zero = "", False
    for i, u in zip((1000, 100, 10, 1), ("仟", "佰", "拾", "")):
        d = n // i % 10
        if d == 0:
            zero = zero or bool(s)
        else:
            if zero:
                s += "零"
                zero = False
            s += DIGITS[d] + u
    return s


def rmb_upper(amount) -> str:
    """金额大写：2400 → 人民币贰仟肆佰元整，18260.8 → 人民币壹万捌仟贰佰陆拾元捌角。"""
    a = Decimal(str(amount)).quantize(CENT, ROUND_HALF_UP)
    if a < 0:
        raise ValueError("金额不能是负数")
    cents = int(a * 100)
    yuan, jiao, fen = cents // 100, cents // 10 % 10, cents % 10
    out, need_zero = "", False
    for n, u in ((yuan // 10**12, "万亿"), (yuan // 10**8 % 10**4, "亿"), (yuan // 10**4 % 10**4, "万"), (yuan % 10**4, "")):
        if n == 0:
            need_zero = need_zero or bool(out)
            continue
        if out and (need_zero or n < 1000):
            out += "零"
        out += _four(n) + u
        need_zero = False
    if not jiao and not fen:
        return "人民币" + (out or "零") + "元整"
    s = out + "元" if out else ""
    if jiao:
        s += DIGITS[jiao] + "角"
    elif out:
        s += "零"
    if fen:
        s += DIGITS[fen] + "分"
    return "人民币" + s


def seller_short(o: dict) -> str:
    """这张采购订单下给谁：有下级 vendor 用下级 vendor，否则用供应商；供应商是凯阔自己又没写下级的，空着让人填。"""
    sub = str(o.get("sub_vendor") or "").strip()
    if sub:
        return sub
    sup = str(o.get("supplier") or "").strip()
    return "" if sup.lower() in SELF else sup


def find_vendor(vendors: list[dict], short: str) -> dict | None:
    """在存过的供方里找：简称记过的、全称一样的、或者简称（两个字以上）是全称的一部分。"""
    s = short.strip().lower()
    if not s:
        return None
    for v in vendors:
        if s in [str(x).lower() for x in v.get("names") or []] or s == str(v.get("name") or "").lower():
            return v
    if len(s) >= 2:
        for v in vendors:
            if s in str(v.get("name") or "").lower():
                return v
    return None


def customer_po_text(o: dict, tbd: str) -> str:
    """客户订单号：没有、或者只写了 TBD 之类（没有一个像样的单号）的，写「待定 (TBD)」。"""
    raw = str(o.get("customer_po") or "").strip()
    toks = [t for t in re.split(r"[\s/,，、;；]+", raw.upper()) if len(t) >= 5 and "TBD" not in t]
    return raw if toks else tbd


def price_ex_tax(price_incl, rate) -> float | None:
    if price_incl in (None, ""):
        return None
    try:
        p = Decimal(str(price_incl))
    except ArithmeticError:
        return None
    return money(p / (1 + Decimal(str(rate)) / 100))


def _num_text(v) -> str:
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return "" if v is None else str(v)


def draft(o: dict, cfg: dict, vendors: list[dict], today: str) -> dict:
    """新做一张时预览里的默认内容。"""
    short = seller_short(o)
    v = find_vendor(vendors, short)
    rate = cfg["tax_rate"]
    lines = []
    for ln in o.get("lines") or []:
        if not isinstance(ln, dict):
            continue
        incl = ln.get("unit_price")
        if incl in (None, "") and ln.get("amount") not in (None, "") and ln.get("qty"):
            try:
                incl = money(Decimal(str(ln["amount"])) / Decimal(str(ln["qty"])))
            except ArithmeticError:
                incl = None
        lines.append({
            "line": _num_text(ln.get("customer_line")), "pn": str(ln.get("pn") or ""), "rev": str(ln.get("rev") or ""),
            "desc": str(ln.get("desc") or ""), "qty": _num_text(ln.get("qty")),
            "price": _num_text(price_ex_tax(incl, rate)), "price_incl": incl if incl not in (None, "") else None,
        })
    po = str(o.get("po") or "")
    return {
        "key": f"{po}|{o.get('supplier') or ''}", "po": po,
        "no": f"{cfg['number_prefix']}{po}", "date": today, "due": str(o.get("due_date") or "")[:10],
        "customer_po": customer_po_text(o, cfg["tbd"]),
        "seller": {"name": v["name"], "lines": list(v.get("lines") or [])} if v else {"name": "", "lines": []},
        "seller_short": short,
        "ship_to": copy.deepcopy(cfg["ship_to"]),
        "tax_rate": rate,
        "lines": lines or [{"line": "", "pn": "", "rev": "", "desc": "", "qty": "", "price": "", "price_incl": None}],
        "terms": [t.replace("{no}", f"{cfg['number_prefix']}{po}") for t in cfg["terms"]],
        "po_amount": o.get("amount"),  # PO 上的含税合计，预览里对照用
    }


def _party(v, what: str, need_name: bool) -> dict:
    if not isinstance(v, dict):
        v = {}
    name = _clean(v.get("name"), 80, f"{what}名称")
    if need_name and not name:
        raise EditError(f"请填{what}名称")
    raw = v.get("lines") or []
    if isinstance(raw, str):
        raw = raw.split("\n")
    if not isinstance(raw, list):
        raise EditError(f"{what}格式不对")
    lines = [s for s in (_clean(x, 160, what) for x in raw) if s]
    if len(lines) > MAX_PARTY_LINES:
        raise EditError(f"{what}最多 {MAX_PARTY_LINES} 行")
    return {"name": name, "lines": lines}


def _qty(v, what: str):
    s = str(v if v is not None else "").replace(",", "").strip()
    try:
        n = float(s)
    except ValueError:
        raise EditError(f"{what}的数量要是数字") from None
    if not 0 < n < 1e7:
        raise EditError(f"{what}的数量不对")
    return int(n) if n.is_integer() else round(n, 4)


def build(payload, orders_by_key: dict[str, dict], cfg: dict) -> dict:
    """检查网页发来的采购订单，重新算小计、总计、含税总计和大写。"""
    if not isinstance(payload, dict):
        raise EditError("请求不对")
    key = str(payload.get("key") or "")
    o = orders_by_key.get(key)
    if o is None:
        raise EditError(f"找不到 {key.replace('|', ' ')}（可能刚被删了），请刷新", 404)
    no = _clean(payload.get("no"), 40, "订单编号")
    if not NO_RE.match(no):
        raise EditError("订单编号只能用字母、数字、- 和 _（最多 40 个）")
    date = clean_date(payload.get("date"), "订单日期")
    if not date:
        raise EditError("请填订单日期")
    due = clean_date(payload.get("due"), "交付日期")
    try:
        rate = float(str(payload.get("tax_rate")).replace("%", "").strip())
    except ValueError:
        raise EditError("税率要是数字") from None
    if not 0 <= rate <= 100:
        raise EditError("税率要在 0 到 100 之间")
    rate = int(rate) if rate.is_integer() else round(rate, 2)
    rows_in = payload.get("lines")
    if not isinstance(rows_in, list) or not rows_in:
        raise EditError("至少要有一行零件")
    if len(rows_in) > MAX_LINES:
        raise EditError(f"一张采购订单最多 {MAX_LINES} 行")
    lines, total, qty_total = [], Decimal(0), Decimal(0)
    for i, r in enumerate(rows_in, 1):
        if not isinstance(r, dict):
            raise EditError("请求不对")
        what = f"第 {i} 行"
        pn = _clean(r.get("pn"), 40, f"{what}的物料编码")
        desc = _clean(r.get("desc"), 200, f"{what}的描述")
        if not pn and not desc:
            raise EditError(f"{what}没填物料编码")
        qty = _qty(r.get("qty"), what)
        try:
            price = clean_amount(r.get("price"))
        except EditError:
            raise EditError(f"{what}的单价要是数字") from None
        if price is None:
            raise EditError(f"{what}没填单价")
        sub = (Decimal(str(qty)) * Decimal(str(price))).quantize(CENT, ROUND_HALF_UP)
        total += sub
        qty_total += Decimal(str(qty))
        lines.append({"line": _clean(r.get("line"), 12, f"{what}的行号"), "pn": pn, "rev": _clean(r.get("rev"), 12, f"{what}的版本"),
                      "desc": desc, "qty": qty, "price": price, "amount": money(sub)})
    terms_in = payload.get("terms") or []
    if isinstance(terms_in, str):
        terms_in = terms_in.split("\n")
    if not isinstance(terms_in, list):
        raise EditError("条款格式不对")
    terms = [s for s in (_clean(t, 400, "条款") for t in terms_in) if s]
    if len(terms) > MAX_TERMS:
        raise EditError(f"条款最多 {MAX_TERMS} 条")
    taxed = (total * (1 + Decimal(str(rate)) / 100)).quantize(CENT, ROUND_HALF_UP)
    q = int(qty_total) if qty_total == qty_total.to_integral_value() else float(qty_total)
    return {
        "key": key, "po": str(o.get("po") or ""), "supplier": o.get("supplier") or "",
        "no": no, "date": date, "due": due, "customer_po": _clean(payload.get("customer_po"), 80, "客户订单号"),
        "seller": _party(payload.get("seller"), "供方", True), "ship_to": _party(payload.get("ship_to"), "收货信息", False),
        "tax_rate": rate, "lines": lines, "qty_total": q,
        "total": money(total), "total_upper": rmb_upper(total), "taxed": money(taxed), "taxed_upper": rmb_upper(taxed),
        "terms": terms,
    }


def cn_date(iso: str) -> str:
    """2026-11-07 → 2026年11月7日（样张的写法）。"""
    return f"{iso[:4]}年{int(iso[5:7])}月{int(iso[8:10])}日" if iso and len(iso) >= 10 else ""


class PurchaseStore:
    """做过的采购订单 data/purchases.json（按订单编号，同号再存就是改这张）+ 供方资料 data/purchase_vendors.json。"""

    def __init__(self, data: Path):
        self.path = data / "purchases.json"
        self.vendor_path = data / "purchase_vendors.json"
        self.lock = threading.Lock()

    def _read(self, path: Path, field: str, kind: type):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return kind()
        except (OSError, ValueError) as e:
            raise EditError(f"{path.name} 读不了（{e.__class__.__name__}），请 Zane 在 Mac 上看一下", 500) from None
        v = doc.get(field) if isinstance(doc, dict) else None
        return v if isinstance(v, kind) else kind()

    def load(self) -> dict[str, dict]:
        return {str(k): v for k, v in self._read(self.path, "purchases", dict).items() if isinstance(v, dict)}

    def save(self, docs: dict[str, dict]) -> None:
        write_atomic(self.path, json.dumps({"version": 1, "purchases": docs}, ensure_ascii=False, indent=1))

    def vendors(self) -> list[dict]:
        try:
            return [v for v in self._read(self.vendor_path, "vendors", list) if isinstance(v, dict) and v.get("name")]
        except EditError:
            return []

    def remember_vendor(self, seller: dict, short: str) -> None:
        """存采购订单时顺便记下供方（同全称覆盖成这次的写法），简称记进 names，下次同一家自动带出。"""
        vendors = self._read(self.vendor_path, "vendors", list)
        vendors = [v for v in vendors if isinstance(v, dict) and v.get("name")]
        cur = next((v for v in vendors if v["name"] == seller["name"]), None)
        if cur is None:
            cur = {"name": seller["name"], "names": []}
            vendors.append(cur)
        cur["lines"] = list(seller["lines"])
        names = [str(x) for x in cur.get("names") or []]
        if short and short != seller["name"] and short not in names:
            names.append(short)
        cur["names"] = names
        for v in vendors:  # 同一个简称只指一家：以最近这次选的为准
            if v is not cur and short in (v.get("names") or []):
                v["names"] = [x for x in v["names"] if x != short]
        write_atomic(self.vendor_path, json.dumps({"version": 1, "vendors": vendors}, ensure_ascii=False, indent=1))

    def summary(self) -> tuple[list[dict], dict[str, list[dict]]]:
        """(列表：新的在前, 每个 PO 做过哪些采购订单)。文件坏了就当没有，不影响看页面。"""
        try:
            docs = self.load()
        except EditError:
            return [], {}
        listing, marks = [], {}
        for no, d in docs.items():
            item = {"no": no, "key": d.get("key"), "po": d.get("po"), "date": d.get("date"), "seller": (d.get("seller") or {}).get("name"),
                    "taxed": d.get("taxed"), "saved_at": d.get("saved_at"), "saved_by": d.get("saved_by")}
            listing.append(item)
            if d.get("key"):
                marks.setdefault(str(d["key"]), []).append({"no": no, "date": d.get("date")})
        listing.sort(key=lambda x: (str(x.get("date") or ""), str(x.get("saved_at") or "")), reverse=True)
        for v in marks.values():
            v.sort(key=lambda x: str(x.get("date") or ""), reverse=True)
        return listing, marks

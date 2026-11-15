"""把 po_sync.py 每小时从 zill@ 邮件抓到的 PO（data/mail_orders.json）合进页面数据。只用 Python 标准库。

Zane 2026-11-15：自动抓取只记录邮件里的原始信息，不自动加备注，不判断状态。所以这里：
- 页面上已经有的 PO（总表导入的、手动加的、以前邮件来的）：只把新的相关邮件挂上去，别的字段一律不动；
- 都没有的 PO：用邮件里的原始字段加成新的一行，状态先记「已下单」，不带任何备注、待跟进、运单号；
- 网页上人改的内容（edits.json）在这之后才盖上去，所以永远以人填的为准。
"""
from __future__ import annotations

import re

# 新单只收这些原始字段；status_note / open_issues / doubts / tracking 之类的判断一律不要
RAW_FIELDS = ("po", "aliases", "supplier", "buyer_entity", "customer", "customer_po", "end_user", "order_date",
              "due_date", "due_text", "customer_due", "amount", "currency", "tax", "mails", "last_mail_at")
LINE_FIELDS = ("pn", "rev", "desc", "qty", "unit_price", "amount")
MAIL_FIELDS = ("folder", "uid", "date", "from", "subject")
NEW_STATUS = "已下单"


def _nums(o: dict) -> set[str]:
    return {str(x) for x in [o.get("po"), *(o.get("aliases") or [])] if x}


def _plus_letter(short: set[str], po: str) -> bool:
    """44278A 是不是 44278 后面加了一个字母（总表把重号的这样改）。"""
    return any(re.fullmatch(re.escape(n) + r"[A-Za-z]", po) for n in short)


def find_matches(m: dict, orders: list[dict]) -> list[dict]:
    """邮件里的 PO 对页面上哪几行。
    1) 同号同供应商；2) 同供应商，号对得上（加了一个字母、旧号）；3) 有一边供应商没定，号对得上。
    对不上就是空列表（= 新单）。"""
    po, sup = str(m.get("po") or ""), m.get("supplier") or ""
    exact = [o for o in orders if str(o.get("po") or "") == po and (o.get("supplier") or "") == sup]
    if exact:
        return exact
    nums = _nums(m)

    def related(o: dict) -> bool:
        return bool(nums & _nums(o)) or _plus_letter(nums, str(o.get("po") or ""))

    same_sup = [o for o in orders if sup and (o.get("supplier") or "") == sup and related(o)]
    if same_sup:
        return same_sup
    return [o for o in orders if (not sup or not o.get("supplier")) and related(o)]


def _mail_ids(m: dict) -> set[tuple]:
    ids = {("d", str(m.get("date") or ""), str(m.get("subject") or ""))}
    if m.get("uid"):
        ids.add(("u", str(m.get("folder") or ""), str(m.get("uid"))))
    return ids


def _attach(o: dict, mails: list[dict]) -> None:
    have: set[tuple] = set()
    for x in o.get("mails") or []:
        if isinstance(x, dict):
            have |= _mail_ids(x)
    extra = []
    for x in mails:
        ids = _mail_ids(x)
        if not ids & have:
            extra.append(x)
            have |= ids
    if not extra:
        return
    o["mails"] = sorted([*(o.get("mails") or []), *extra], key=lambda x: str(x.get("date") or ""), reverse=True)
    o["last_mail_at"] = max([str(o.get("last_mail_at") or ""), *(str(x.get("date") or "") for x in extra)]) or None


def _clean_mails(m: dict) -> list[dict]:
    return [{k: x[k] for k in MAIL_FIELDS if x.get(k) not in (None, "")} for x in m.get("mails") or [] if isinstance(x, dict)]


def merge(orders: list[dict], mail_orders: list[dict]) -> tuple[list[dict], int]:
    """返回 (合并后的列表, 新加了几行)。不改传进来的 dict。"""
    out = [dict(o) for o in orders]
    added = 0
    for m in mail_orders:
        if not isinstance(m, dict) or not str(m.get("po") or "").strip():
            continue
        mails = _clean_mails(m)
        hits = find_matches(m, out)
        for o in hits:
            _attach(o, mails)
        if hits:
            continue
        new = {k: m[k] for k in RAW_FIELDS if m.get(k) not in (None, "", [])}
        new["po"] = str(new["po"]).strip()
        new["mails"] = sorted(mails, key=lambda x: str(x.get("date") or ""), reverse=True)
        new["lines"] = [{k: ln[k] for k in LINE_FIELDS if ln.get(k) not in (None, "")}
                        for ln in m.get("lines") or [] if isinstance(ln, dict)]
        new.update(status=NEW_STATUS, source="mail", mail_new=True)
        out.append(new)
        added += 1
    return out, added

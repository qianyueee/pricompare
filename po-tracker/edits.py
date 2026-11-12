"""跟单的人在网页上做的改动。只用 Python 标准库。

- data/edits.json：当前值。{"patches": {"PO|供应商": {字段: 值}}, "added": [手动新增的 PO]}
- data/history.jsonl：每次改动一行（谁、什么时候、改了什么、跟进备注），页面上显示成「跟进记录」。

合并顺序：orders.json（邮件整理的起点）+ 手动新增 → overrides.json（Zane 手工更正）→ edits.json（网页上的改动，最后生效）。
"""
from __future__ import annotations

import datetime as dt
import json
import os
import secrets
import threading
from pathlib import Path

STATUSES = ("未定", "已下单", "已确认", "已发货", "已完成", "已取消")
TEXT_LIMITS = {"eta": 40, "tracking": 80}  # 可直接改的文字字段及长度上限
NOTE_MAX = 500
NAME_MAX = 20
MAX_LINES = 50
HISTORY_PER_ORDER = 100


class EditError(ValueError):
    """改动不合规；消息直接给用户看。"""

    def __init__(self, msg: str, status: int = 400):
        super().__init__(msg)
        self.status = status


def order_key(o: dict) -> str:
    return f"{o.get('po', '')}|{o.get('supplier') or ''}"


def write_atomic(path: Path, text: str, mode: int = 0o644) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(6)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- 输入检查

def _clean(v, limit: int, what: str) -> str:
    if v is None:
        return ""
    if not isinstance(v, (str, int, float)) or isinstance(v, bool):
        raise EditError(f"{what}格式不对")
    s = " ".join(str(v).split()) if limit <= 80 else str(v).strip()
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in s):
        raise EditError(f"{what}里有不可见字符")
    if len(s) > limit:
        raise EditError(f"{what}太长了（最多 {limit} 个字）")
    return s


def clean_name(v) -> str:
    s = _clean(v, NAME_MAX, "名字")
    if not s:
        raise EditError("请先填你的名字（记在跟进记录里）")
    return s


def clean_date(v, what: str) -> str:
    s = _clean(v, 10, what)
    if not s:
        return ""
    try:
        return dt.date.fromisoformat(s).isoformat()
    except ValueError:
        raise EditError(f"{what}不是有效日期") from None


def clean_status(v) -> str:
    if v not in STATUSES:
        raise EditError("状态只能是：" + "、".join(STATUSES))
    return v


def clean_amount(v):
    if v in (None, ""):
        return None
    try:
        n = float(str(v).replace(",", "").replace("¥", "").strip())
    except ValueError:
        raise EditError("金额要是数字") from None
    if not (0 <= n < 1e10):
        raise EditError("金额不对")
    return int(n) if n.is_integer() else round(n, 2)


def clean_id(v, what: str, required: bool) -> str:
    s = _clean(v, 30, what)
    if "|" in s:
        raise EditError(f"{what}里不能有 |")
    if required and not s:
        raise EditError(f"请填{what}")
    return s


# ---------------------------------------------------------------- 存取

class Store:
    def __init__(self, data: Path):
        self.path = data / "edits.json"
        self.hist_path = data / "history.jsonl"
        self.lock = threading.Lock()

    def load(self) -> dict:
        try:
            doc = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            doc = {}
        except (OSError, ValueError) as e:
            # 坏了就别再写，免得把人填的东西冲掉；读的时候当没有改动
            raise EditError(f"edits.json 读不了（{e.__class__.__name__}），请 Zane 在 Mac 上看一下", 500) from None
        patches = doc.get("patches") if isinstance(doc, dict) else None
        added = doc.get("added") if isinstance(doc, dict) else None
        return {
            "version": 1,
            "patches": {str(k): v for k, v in patches.items() if isinstance(v, dict)} if isinstance(patches, dict) else {},
            "added": [o for o in added if isinstance(o, dict) and o.get("po")] if isinstance(added, list) else [],
        }

    def save(self, doc: dict) -> None:
        write_atomic(self.path, json.dumps(doc, ensure_ascii=False, indent=1))

    def history(self) -> dict[str, list[dict]]:
        out: dict[str, list[dict]] = {}
        try:
            text = self.hist_path.read_text(encoding="utf-8")
        except OSError:
            return out
        for line in text.splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict) and isinstance(rec.get("key"), str):
                out.setdefault(rec["key"], []).append(rec)
        for k in out:
            out[k] = out[k][::-1][:HISTORY_PER_ORDER]
        return out

    def append_history(self, rec: dict) -> None:
        with open(self.hist_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    # ---- 合并（读的时候用）
    @staticmethod
    def with_added(orders: list[dict], doc: dict) -> list[dict]:
        return orders + [dict(o) for o in doc["added"]]

    @staticmethod
    def apply_patches(orders: list[dict], doc: dict) -> list[dict]:
        out = []
        for o in orders:
            p = doc["patches"].get(order_key(o))
            if p:
                o = {**o, **p, "edited": sorted(k for k in p if k in ("status", "due_date", "eta", "tracking", "note"))}
            out.append(o)
        return out


def diff_update(current: dict, changes: dict) -> dict:
    """把网页传来的改动整理成 {字段: [旧, 新]}，只留真的变了的。"""
    if not isinstance(changes, dict):
        raise EditError("改动格式不对")
    unknown = set(changes) - {"status", "due_date", *TEXT_LIMITS}
    if unknown:
        raise EditError("不能改这些字段：" + "、".join(sorted(unknown)))
    out = {}
    for k, v in changes.items():
        if k == "status":
            new = clean_status(v)
        elif k == "due_date":
            new = clean_date(v, "交期")
        else:
            new = _clean(v, TEXT_LIMITS[k], {"eta": "预计发货", "tracking": "运单号"}[k])
        old = current.get(k) or ""
        if new != old:
            out[k] = [old, new]
    return out


def build_added(order: dict, by: str, at: str) -> dict:
    if not isinstance(order, dict):
        raise EditError("新增的 PO 格式不对")
    lines_in = order.get("lines") or []
    if not isinstance(lines_in, list) or len(lines_in) > MAX_LINES:
        raise EditError(f"零件最多 {MAX_LINES} 行")
    lines = []
    for ln in lines_in:
        if not isinstance(ln, dict):
            raise EditError("零件格式不对")
        pn = _clean(ln.get("pn"), 60, "零件号")
        if pn:
            lines.append({"pn": pn, "qty": clean_amount(ln.get("qty"))})
    o = {
        "po": clean_id(order.get("po"), "PO 号", True),
        "supplier": clean_id(order.get("supplier"), "供应商", True),
        "status": clean_status(order.get("status") or "已下单"),
        "order_date": clean_date(order.get("order_date"), "下单日期") or None,
        "due_date": clean_date(order.get("due_date"), "交期") or None,
        "customer_po": _clean(order.get("customer_po"), 60, "客户 PO"),
        "end_user": _clean(order.get("end_user"), 60, "下单人"),
        "amount": clean_amount(order.get("amount")),
        "currency": order.get("currency") if order.get("currency") in ("RMB", "USD") else "RMB",
        "lines": lines,
        "source": "manual",
        "created_at": at,
        "created_by": by,
    }
    note = _clean(order.get("note"), NOTE_MAX, "跟进备注")
    if note:
        o.update(note=note, note_at=at, note_by=by)
    return o

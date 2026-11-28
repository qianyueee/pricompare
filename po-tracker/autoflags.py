"""自动判断「已发单」「已发货」，只作提示：不改人填的状态、运单号、预计发货、备注（Zane 2026-11-28）。只用 Python 标准库。

已发单：供应商手里有没有这张 PO。
  po_sync.py 每小时把 zill@kvstek.com 里跟 PO 有关的信头记在 data/mail_index.json（文件夹、日期、发件人、收件人、标题）。
  一封信算「发单」：不在草稿箱；发件人是我们（kvstek.com）或美方（auto.json 的 us_domains）；收件人或抄送里有外面的地址
  （不是这些域名，也不在 auto.json 的 ignore_mail 里）；并且标题写了这张单的号，或者是 po_sync 归到这张单下的信
  （标题号码写错的，如 44398 的单 Gene 标题写成 44393），后一种要认得出收件人就是这张单的供应商。
  Gene 发单抄送 zill，所以在收件箱里；Zill 自己发的在已发送；凯维的单常是 Tony 直接发给凯维、抄送我们，也算。
  取不是回复的最早一封，没有才取回复里最早的。收件人认得出是哪家（auto.json 的 vendor_mail）、
  又跟这张单的供应商 / 下级 vendor 对不上的不算（同一个号给了两家时，如 44278）。
  「未见发单」：zill@ 里有这张单的信（比如 Tony 发来的 PO）却没看到发给供应商的，状态还是未定 / 已下单、也没有出货单据；
  只看 zill@ 里两边（我们、美方）都开始有发单信以后下的单（更早的单发单时没抄送 zill）。总表里有、邮件里没有的单不判断。

已发货：shipping@ 邮箱的出货单据。
  ~/agent/shippingdocs-mail/sdmail.py 每 10 分钟把出货信整理进它的 orders.json：
  {"orders": {"44368": {"ships": [{"date": "20261127", "fac": "KW", "awb": ["1234567890"], "with": [], "label": "INBOX:14655"}]}}}
  按 PO 号对（44278A 按 44278 找），发货厂商跟这张单的供应商对不上的不算：KW 只算凯维、HC 只算华晨、
  KK（凯阔自己发）算其余供应商。同一天同一家发的几封信（装箱单、发票分开发）算一批，分批发的每批一条。

配置 data/auto.json（只在 Mac 上，不进仓库；格式见 deploy/auto.example.json），没有也能跑（不认供应商、不看出货单据）。
页面拿到的每个 PO 多一个 "auto"：{"sent": {...} 或没有, "ships": [...], "flags": ["nosent" | "newship"]}。
"""
from __future__ import annotations

import datetime as dt
import email.utils
import json
import re
import threading
from pathlib import Path

OUR_DOMAINS = ("kvstek.com",)                    # 我们：Gene、Zill、Zack（美方的域名在 auto.json 的 us_domains）
SKIP_FOLDERS = {"草稿箱", "Drafts", "垃圾邮件", "已删除"}
REPLY = re.compile(r"(?i)^\s*(re|回复|答复|aw)\s*[:：]")
ACTIVE = ("未定", "已下单", "已确认")              # 还没发货的状态：出货单据来了要提醒
NOT_SENT = ("未定", "已下单")                      # 「未见发单」只看这两个（已确认 = 供应商回过了）
FAC_VENDORS = {"KW": ("凯维",), "HC": ("华晨",)}  # 出货单据的厂商代码；KK = 凯阔自己发，算其余供应商

# 标题里的我方 PO 号：PO / WO 后面 5 位数字，可带一个字母后缀（44369A），后面还可以接着列号（"PO44408+PO44395"、"PO 44408 + 44395"）。
# 跟 po_sync 不同的是号后面紧跟英文单词也认（"PO 44401Due December 5"），8 位以上的 KLA 客户 PO 不算。
_NUM = r"(\d{5})([A-Z](?![A-Z]))?(?!\d)"
KEY_RE = re.compile(r"(?i)(?<![A-Z0-9])[PW]\.?O[\s#:：_\-]*(?:号|No\.?)?[\s#:：_\-]*" + _NUM)
MORE_RE = re.compile(r"(?i)\s*(?:[,，、/&+和]|and)?\s*(?:[PW]\.?O[\s#:：_\-]*)?" + _NUM)


def subject_keys(subject: str) -> list[str]:
    out: list[str] = []
    s = subject or ""
    for m in KEY_RE.finditer(s):
        ks = [m.group(1) + (m.group(2) or "").upper()]
        pos = m.end()
        while (n := MORE_RE.match(s, pos)) and n.end() > pos:
            ks.append(n.group(1) + (n.group(2) or "").upper())
            pos = n.end()
        out += [k for k in ks if k not in out]
    return out


def _addrs(header: str) -> list[str]:
    return [a.strip().lower() for _n, a in email.utils.getaddresses([header or ""]) if a and "@" in a]


def _dom_in(addr: str, doms) -> bool:
    d = addr.rpartition("@")[2]
    return any(d == x or d.endswith("." + x) for x in doms)


def _name(header: str) -> str:
    pairs = email.utils.getaddresses([header or ""])
    if not pairs:
        return ""
    n, a = pairs[0]
    return (n or a.split("@")[0]).strip()


def _day(s: str) -> str:
    """'20261127' / '2026-11-27T…' → '2026-11-27'；认不出就空。"""
    s = str(s or "")
    m = re.match(r"(\d{4})-?(\d{2})-?(\d{2})", s)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else ""


def _when(s: str) -> dt.datetime:
    try:
        d = dt.datetime.fromisoformat(str(s))
    except ValueError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def _cn_day(s: str) -> str:
    """信的日期换成中国时间那天（Tony 在美国写的信按北京时间算）。"""
    d = _when(s)
    if d.year < 1900:
        return _day(s)
    return d.astimezone(dt.timezone(dt.timedelta(hours=8))).date().isoformat()


def _doms(v) -> list[str]:
    return [str(x).strip().lower().lstrip("@") for x in v or [] if isinstance(x, str) and x.strip()] if isinstance(v, list) else []


class Config:
    def __init__(self, raw: dict | None = None):
        raw = raw if isinstance(raw, dict) else {}
        self.vendor_of: dict[str, str] = {}  # 地址或域名（小写）→ 供应商名
        for vendor, addrs in (raw.get("vendor_mail") or {}).items():
            for a in addrs if isinstance(addrs, list) else [addrs]:
                if isinstance(a, str) and a.strip():
                    self.vendor_of[a.strip().lower()] = str(vendor)
        self.ignore = {str(a).strip().lower() for a in raw.get("ignore_mail") or [] if isinstance(a, str)}
        sd = raw.get("shipdocs")
        self.shipdocs = Path(sd).expanduser() if isinstance(sd, str) and sd.strip() else None
        self.ours = tuple(_doms(raw.get("our_domains")) or OUR_DOMAINS)
        self.us = tuple(_doms(raw.get("us_domains")))  # 美方（Tony、Sarah）
        self.internal = self.ours + self.us
        self.aliases: dict[str, set[str]] = {}  # 同一家的几个叫法（"凯阔": ["Kaikuo"]）
        for vendor, names in (raw.get("vendor_alias") or {}).items():
            self.aliases[str(vendor)] = {str(vendor), *(str(n) for n in names or [])}

    def vendor(self, addr: str) -> str:
        if addr in self.vendor_of:
            return self.vendor_of[addr]
        d = addr.rpartition("@")[2]
        while d:
            if d in self.vendor_of:
                return self.vendor_of[d]
            d = d.partition(".")[2]
        return ""

    def same(self, a: str, b: str) -> bool:
        a, b = (a or "").strip(), (b or "").strip()
        if not a or not b:
            return False
        if a.lower() == b.lower():
            return True
        return any(a in names and b in names for names in self.aliases.values())


# ---------------------------------------------------------------- 发单

def sent_hits(index: dict, cfg: Config) -> dict:
    """mail_index.json → {"by_key": {标题里的号: [发单信]}, "by_id": {(文件夹, uid): 发单信}}。"""
    by_key: dict[str, list[dict]] = {}
    by_id: dict[tuple, dict] = {}
    for m in (index or {}).values():
        if not isinstance(m, dict) or m.get("folder") in SKIP_FOLDERS:
            continue
        frm = _addrs(m.get("from") or "")
        if not frm or not _dom_in(frm[0], cfg.internal):
            continue
        to = [a for a in _addrs(m.get("to") or "") if not _dom_in(a, cfg.internal) and a not in cfg.ignore]
        cc = [a for a in _addrs(m.get("cc") or "") if not _dom_in(a, cfg.internal) and a not in cfg.ignore]
        if not to and not cc:
            continue
        ext = to or cc
        hit = {
            "date": m.get("date") or "", "folder": m.get("folder") or "", "uid": m.get("uid"),
            "from": _name(m.get("from") or ""), "side": "我们" if _dom_in(frm[0], cfg.ours) else "美方",
            "to": ext[0].rpartition("@")[2], "vendors": sorted({cfg.vendor(a) for a in to + cc} - {""}),
            "subject": re.sub(r"\s+", " ", m.get("subject") or "").strip(),
            "reply": bool(REPLY.match(m.get("subject") or "")), "cc": not to,
        }
        by_id[(hit["folder"], str(hit["uid"]))] = hit
        for k in subject_keys(m.get("subject") or ""):
            by_key.setdefault(k, []).append(hit)
    return {"by_key": by_key, "by_id": by_id}


def coverage_since(hits: dict) -> str:
    """zill@ 里我们和美方两边都开始有发单信的那天（取两边最早一封里晚的那个）。"""
    first: dict[str, str] = {}
    for h in hits.get("by_id", {}).values():
        if not h["reply"]:
            d = _cn_day(h["date"])
            if d and (h["side"] not in first or d < first[h["side"]]):
                first[h["side"]] = d
    return max(first.values()) if first else ""


def _vendor_ok(hit_vendors: list[str], order: dict, cfg: Config) -> bool | None:
    """收件人那家跟这张单的供应商：True 对上、False 对不上、None 没法比。"""
    mine = [x for x in (order.get("supplier"), order.get("sub_vendor")) if x]
    if not hit_vendors or not mine:
        return None
    return any(cfg.same(v, s) for v in hit_vendors for s in mine)


def match_sent(order: dict, hits: dict, cfg: Config) -> dict | None:
    by_key = hits.get("by_key") or {}
    po = str(order.get("po") or "").strip().upper()
    nums = {po, *(str(a).strip().upper() for a in order.get("aliases") or [] if a)} - {""}
    cands = []
    for n in nums:
        cands += [h for h in by_key.get(n, []) if _vendor_ok(h["vendors"], order, cfg) is not False]
    base = re.fullmatch(r"(\d{5})[A-Z]", po)
    if base:  # 总表把重号改成 44278A：信里写的是 44278，收件人认得出、又正好是这家的才算
        cands += [h for h in by_key.get(base.group(1), []) if _vendor_ok(h["vendors"], order, cfg) is True]
    for x in order.get("mails") or []:  # po_sync 归到这张单下的信（标题号码写错的）：收件人得认得出是这家
        h = (hits.get("by_id") or {}).get((str(x.get("folder") or ""), str(x.get("uid")))) if isinstance(x, dict) else None
        if h and _vendor_ok(h["vendors"], order, cfg) is True:
            cands.append(h)
    if not cands:
        return None
    best = min(cands, key=lambda h: (h["reply"], _when(h["date"])))
    out = {k: best[k] for k in ("date", "folder", "uid", "from", "side", "to", "subject", "reply", "cc") if best.get(k) not in (None, "", False)}
    out["day"] = _cn_day(best["date"])
    if best["vendors"]:
        out["vendor"] = "、".join(best["vendors"])
    return out


# ---------------------------------------------------------------- 发货

def _fac_ok(fac: str, order: dict) -> bool:
    mine = [x for x in (order.get("supplier"), order.get("sub_vendor")) if x]
    if not mine:
        return True
    named = {v for vs in FAC_VENDORS.values() for v in vs}
    for code in str(fac or "").split("+"):
        code = code.strip().upper()
        if not code:
            return True  # 不知道哪家发的：不拦
        if code in FAC_VENDORS:
            if any(s in FAC_VENDORS[code] for s in mine):
                return True
        elif not any(s in named for s in mine):
            return True
    return False


def match_ships(order: dict, shipdocs: dict) -> list[dict]:
    """这张单的出货，一天一家一批：{"day", "fac", "awb": [...], "with": [...], "labels": [...]}，按日期排。"""
    nums = [str(order.get("po") or ""), *(str(a) for a in order.get("aliases") or [])]
    seen: set = set()
    batches: dict[tuple, dict] = {}
    for n in nums:
        m = re.match(r"\d{5}", n.strip())
        if not m:
            continue
        rec = shipdocs.get(m.group(0))
        if not isinstance(rec, dict):
            continue
        for s in rec.get("ships") or []:
            if not isinstance(s, dict) or s.get("label") in seen or not _fac_ok(s.get("fac") or "", order):
                continue
            seen.add(s.get("label"))
            day = _day(s.get("date"))
            if not day:
                continue
            b = batches.setdefault((day, s.get("fac") or ""), {"day": day, "fac": s.get("fac") or "", "awb": [], "with": [], "labels": []})
            for k, vals in (("awb", s.get("awb")), ("with", s.get("with")), ("labels", [s.get("label")])):
                b[k] += [str(v) for v in vals or [] if v and str(v) not in b[k]]
    return sorted(batches.values(), key=lambda b: (b["day"], b["fac"]))


# ---------------------------------------------------------------- 合到页面

def _touched(order: dict) -> str:
    """人最后一次碰这张单的日期：网页上改过 / 写过跟进，或总表里记的发货日期。"""
    days = [_day(order.get("updated_at")), _day(order.get("note_at")),
            *(_day(x) for x in order.get("shipped") or [] if isinstance(x, str))]
    return max([d for d in days if d] or [""])


def sheet_day(meta: dict) -> str:
    """起点是跟单总表时，总表是哪天的（文件名里的 20261111；没有就用导入那天）。总表里的单，这天以前的出货算总表已经知道了。"""
    if not isinstance(meta, dict) or meta.get("base") != "tracker":
        return ""
    m = re.search(r"20\d{6}", str(meta.get("sheet_file") or ""))
    return _day(m.group(0)) if m else _day(meta.get("generated_at"))


def annotate(orders: list[dict], data: dict, cfg: Config, baseline: str = "") -> dict:
    """给每个 PO 加 "auto"，返回给 meta 的说明。不改别的字段。baseline：总表的日期（见 sheet_day）。"""
    hits = data.get("hits") or {}
    ships_doc = data.get("shipdocs") or {}
    since = data.get("since") or ""
    counts = {"sent": 0, "ships": 0, "nosent": 0, "newship": 0}
    for o in orders:
        sent = match_sent(o, hits, cfg) if hits else None
        ships = match_ships(o, ships_doc) if ships_doc else []
        flags = []
        status = o.get("status") or ""
        if (status in NOT_SENT and not sent and not ships and hits and o.get("mails")
                and since and str(o.get("order_date") or "") >= since):
            flags.append("nosent")
        touched = max(_touched(o), baseline if o.get("source") == "tracker" else "")
        if status in ACTIVE and ships and ships[-1]["day"] > touched:
            flags.append("newship")
        auto: dict = {}
        if sent:
            auto["sent"] = sent
            counts["sent"] += 1
        if ships:
            auto["ships"] = ships
            counts["ships"] += 1
        if flags:
            auto["flags"] = flags
            for f in flags:
                counts[f] += 1
        if auto:
            o["auto"] = auto
    return {**counts, "since": since, **{k: data[k] for k in ("mail_at", "shipdocs_at", "error") if data.get(k)}}


class Source:
    """读 auto.json、mail_index.json、出货单据 orders.json；文件没变就用上次读的。"""

    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.lock = threading.Lock()
        self._cache: dict[str, tuple] = {}

    def _read(self, path: Path | None):
        """(内容, 改动时间 iso) ；文件不在 → (None, "")；坏了抛 ValueError / OSError。"""
        if path is None:
            return None, ""
        try:
            st = path.stat()
        except FileNotFoundError:
            return None, ""
        sig = (st.st_mtime_ns, st.st_size)
        with self.lock:
            hit = self._cache.get(str(path))
            if hit and hit[0] == sig:
                return hit[1], hit[2]
        doc = json.loads(path.read_text(encoding="utf-8"))
        at = dt.datetime.fromtimestamp(st.st_mtime).astimezone().isoformat(timespec="seconds")
        with self.lock:
            self._cache[str(path)] = (sig, doc, at)
        return doc, at

    def load(self) -> tuple[Config, dict]:
        errors = []
        try:
            raw, _ = self._read(self.data_dir / "auto.json")
        except (OSError, ValueError) as e:
            raw = None
            errors.append(f"auto.json 读不了：{e.__class__.__name__}")
        cfg = Config(raw)
        out: dict = {}
        try:
            index, at = self._read(self.data_dir / "mail_index.json")
        except (OSError, ValueError) as e:
            index, at = None, ""
            errors.append(f"mail_index.json 读不了：{e.__class__.__name__}")
        if isinstance(index, dict):
            key = (at, json.dumps(sorted(cfg.vendor_of.items())), tuple(sorted(cfg.ignore)), cfg.internal)
            with self.lock:
                cached = self._cache.get("__hits")
            if cached and cached[0] == key:
                out["hits"] = cached[1]
            else:
                out["hits"] = sent_hits(index, cfg)
                with self.lock:
                    self._cache["__hits"] = (key, out["hits"])
            out["mail_at"] = at
            out["since"] = coverage_since(out["hits"])
        try:
            sd, sat = self._read(cfg.shipdocs)
        except (OSError, ValueError) as e:
            sd, sat = None, ""
            errors.append(f"出货单据 orders.json 读不了：{e.__class__.__name__}")
        if isinstance(sd, dict) and isinstance(sd.get("orders"), dict):
            out["shipdocs"] = sd["orders"]
            out["shipdocs_at"] = sat
        if errors:
            out["error"] = "；".join(errors)
        return cfg, out

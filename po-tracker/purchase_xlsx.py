"""把一张采购订单（purchase.build 的结果）写成 .xlsx，版式照 Zane 11-15 晚上定稿的正式单据（跟网页打印的一样）。只用标准库。

只用黑白灰：左上 logo、右边「采 购 订 单」和地址、电话邮箱两行，下面一粗一细双线；信息表、明细表外框粗、里面浅灰细线；
底部需方、供方各只有「盖章」和「日期」，需方日期 = 订单日期，默认盖公章（40 mm）。正文等线，标题和双方名称用宋体
（Excel 里没法带思源宋体，宋体 Windows 和 Mac 版 Office 都有）。logo、公章图片从 Mac 的 data/assets/ 来，不进仓库。
小计、合计、含税总计、金额大写都是公式（带算好的值）：在 Excel 里改数量或单价会跟着变；大写用 TEXT 的 [DBNum2]。
"""
from __future__ import annotations

import math

from invoice_xlsx import Sheet, Styles, col, image_size, package
from purchase import cn_date

INK = "FF111111"
SUB = "FF333333"
GREY = "FF555555"
SHADE = "FFF3F3F3"
OUT = ("medium", INK)  # 表格外框
IN = ("thin", "FF8C8C8C")  # 表格里面的线
SERIF = "宋体"
MONEY_FMT = '"¥"#,##0.00'
# A–K。明细：序号 A、行号 B、P/N C:D、版本 E、描述 F:H、数量 I、单价 J、小计 K；信息表：标签 A:C、内容 D:F、标签 G、内容 H:K
WIDTHS = [5.8, 5.8, 4.0, 8.6, 5.8, 17.5, 12.6, 5.9, 6.8, 10.7, 13.6]
LAST = len(WIDTHS) - 1
PT_PER_UNIT = 5.25  # 列宽 1 个单位大约 7 像素 = 5.25 磅（等线 11 号）
SEAL_PT = 113.4  # 40 mm
LOGO_PT = 42  # logo 高


def _vis(text: str) -> int:
    """大致的显示宽度：中文算 2，其他算 1。"""
    return sum(2 if ord(ch) > 0x2E7F else 1 for ch in text)


def _lines(text: str, width_units: float, size: float) -> int:
    """估这段字在这么宽的格子里折成几行（Excel 不会给合并格自动调行高）。"""
    per = max(8.0, width_units * 11 / size * 0.95)  # 每行能放的半角字数
    return sum(max(1, math.ceil(_vis(part) / per)) for part in (text.split("\n") or [""]))


def upper_formula(ref: str) -> str:
    c = f"ROUND({ref}*100,0)"
    y, j, f = f"INT({c}/100)", f"MOD(INT({c}/10),10)", f"MOD({c},10)"

    def t(x: str) -> str:
        return f'TEXT({x},"[DBNum2][$-804]General")'

    return (f'"人民币"&IF({c}=0,"零元整",IF({y}>0,{t(y)}&"元","")'
            f'&IF({j}>0,{t(j)}&"角",IF(AND({y}>0,{f}>0),"零",""))'
            f'&IF({f}>0,{t(f)}&"分",IF({j}>0,"","整")))')


def _at(x_pt: float) -> tuple[int, float]:
    """离 A 列左边 x 磅的地方落在哪一列、在那列里偏多少磅。"""
    for c, w in enumerate(WIDTHS):
        if x_pt < w * PT_PER_UNIT or c == LAST:
            return c, x_pt
        x_pt -= w * PT_PER_UNIT
    return LAST, 0


def render(doc: dict, cfg: dict, images: dict | None = None) -> bytes:
    """images：{"logo": PNG/JPG 字节, "seal": …}，没有就不放（没 logo 时左上写公司名）。"""
    images = images or {}
    st = Styles()
    sh = Sheet()
    pics: list[dict] = []

    def style(size=9, bold=False, h="left", v="center", border=None, fmt=None, wrap=True, color=INK, fill=None, font=None, indent=None):
        if indent is None:
            indent = 0 if h == "center" else 1
        return st.get(size=size, bold=bold, color=color, h=h, v=v, border=border or False, fmt=fmt, wrap=wrap,
                      indent=indent, fill=fill, font=font)

    def box(r1, c1, r2, c2, value=None, formula=None, sides=None, **kw):
        """写一个（合并）格子；sides 给外框，如 {"l": OUT, "t": IN}，每个小格只画落在外边上的那几条。"""
        sides = sides or {}
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                edge = {k: s for k, s in sides.items()
                        if (k == "l" and c == c1) or (k == "r" and c == c2) or (k == "t" and r == r1) or (k == "b" and r == r2)}
                sh.put(r, c, value if (r, c) == (r1, c1) else None, style(border=edge, **kw),
                       formula if (r, c) == (r1, c1) else None)
        if (r1, c1) != (r2, c2):
            sh.merges.append(_ref(r1, c1, r2, c2))

    def cell(table, r1, c1, r2, c2, value=None, formula=None, open_side="", **kw):
        """表格里的一格：落在表格外边的那几条用粗线，里面浅灰细线。table = (首行, 末行)；open_side 里的边不画（"l"/"r"）。"""
        sides = {"l": OUT if c1 == 0 else IN, "r": OUT if c2 == LAST else IN,
                 "t": OUT if r1 == table[0] else IN, "b": OUT if r2 == table[1] else IN}
        for k in open_side:
            sides[k] = None
        box(r1, c1, r2, c2, value, formula, sides, **kw)

    # 页眉：左上 logo（没有就写公司名），右边「采 购 订 单」+ 地址、电话邮箱；下面一粗一细双线
    buyer = cfg.get("buyer") or {}
    blines = [str(x) for x in buyer.get("lines") or []][:3]
    if images.get("logo"):
        w, h = image_size(images["logo"])
        pics.append({"name": "logo", "data": images["logo"], "col": 0, "row": 0, "w": LOGO_PT * w / max(h, 1), "h": LOGO_PT})
    else:
        box(1, 0, 1, 4, buyer.get("name") or "", size=16, bold=True, font=SERIF, wrap=False, v="top", indent=0)
    box(1, 5, 1, LAST, "采 购 订 单", size=20, bold=True, font=SERIF, h="right", v="top", wrap=False, indent=0)
    sh.heights[1] = 28
    r = 2
    for line in blines:
        box(r, 3, r, LAST, line, size=7.5, color=GREY, h="right", wrap=False, indent=0)
        sh.heights[r] = 12.5
        r += 1
    if len(blines) < 2:  # logo 有 42 磅高，至少留够
        sh.heights[r] = 12.5 * (2 - len(blines))
        r += 1
    box(r, 0, r, LAST, sides={"b": ("medium", INK)})
    sh.heights[r] = 8
    box(r + 1, 0, r + 1, LAST, sides={"b": ("thin", INK)})
    sh.heights[r + 1] = 2
    r += 3
    sh.heights[r - 1] = 14

    # 订单信息
    info = (r, r + 2)
    for a, b, c, d in (("订单编号", doc["no"], "订单日期", cn_date(doc["date"])),
                       ("交付日期", cn_date(doc.get("due") or ""), "客户订单号", doc.get("customer_po") or "")):
        cell(info, r, 0, r, 2, a, fill=SHADE, color=SUB, wrap=False)
        cell(info, r, 3, r, 5, b)
        cell(info, r, 6, r, 6, c, fill=SHADE, color=SUB, wrap=False)
        cell(info, r, 7, r, LAST, d)
        sh.heights[r] = 23
        r += 1
    seller = "\n".join([doc["seller"]["name"], *doc["seller"]["lines"]])
    ship = "\n".join([x for x in [doc["ship_to"]["name"], *doc["ship_to"]["lines"]] if x])
    cell(info, r, 0, r, 2, "供方（卖方）", fill=SHADE, color=SUB, v="top", wrap=False)
    cell(info, r, 3, r, 5, _named(doc["seller"]), v="top")
    cell(info, r, 6, r, 6, "收货信息", fill=SHADE, color=SUB, v="top", wrap=False)
    cell(info, r, 7, r, LAST, _named(doc["ship_to"]), v="top")
    n = max(_lines(seller, sum(WIDTHS[3:6]), 8.5), _lines(ship, sum(WIDTHS[7:]), 8.5), 3)
    sh.heights[r] = round(n * 14 + 9, 1)
    r += 2
    sh.heights[r - 1] = 12

    # 明细
    cols = [((0, 0), "序号"), ((1, 1), "行号"), ((2, 3), "物料编码\n(P/N)"), ((4, 4), "版本"), ((5, 7), "产品描述 (Description)"),
            ((8, 8), "数量"), ((9, 9), "单价 (RMB)"), ((10, 10), "小计 (RMB)")]
    items = (r, r + len(doc["lines"]) + 2)
    for (c1, c2), text in cols:
        cell(items, r, c1, r, c2, text, size=8, bold=True, h="center", fill=SHADE)
    sh.heights[r] = 32
    r += 1
    first = r
    for i, ln in enumerate(doc["lines"], 1):
        vals = {0: i, 1: ln.get("line") or "", 2: ln["pn"], 4: ln.get("rev") or "", 5: ln.get("desc") or "", 8: ln["qty"], 9: ln["price"]}
        for (c1, c2), _t in cols:
            h = "left" if c1 == 5 else ("right" if c1 in (9, 10) else "center")
            fmt = MONEY_FMT if c1 in (9, 10) else None
            if c1 == 10:
                cell(items, r, c1, r, c2, ln["amount"], f"ROUND(I{r}*J{r},2)", size=8.5, h=h, fmt=fmt)
            else:
                cell(items, r, c1, r, c2, vals[c1], size=8.5, h=h, fmt=fmt)
        sh.heights[r] = max(28, _lines(str(ln.get("desc") or ""), sum(WIDTHS[5:8]), 8.5) * 12.5 + 14)
        r += 1
    last = r - 1
    tot = r
    # 「合计金额（大写）：」粗体放 A:C（靠右），大写金额是公式，接着放 D 起（靠左），看起来是一句
    cap = {"size": 8.5, "wrap": False}
    cell(items, r, 0, r, 2, "合计金额（大写）：", bold=True, h="right", indent=0, open_side="r", **cap)
    cell(items, r, 3, r, 7, doc["total_upper"], upper_formula(f"K{r}"), indent=0, open_side="l", **cap)
    cell(items, r, 8, r, 8, doc["qty_total"], f"SUM(I{first}:I{last})", size=8.5, bold=True, h="center")
    cell(items, r, 9, r, 9, "总计", size=8, bold=True, h="center", fill=SHADE)
    cell(items, r, 10, r, 10, doc["total"], f"SUM(K{first}:K{last})", size=10, bold=True, h="right", fmt=MONEY_FMT)
    sh.heights[r] = 30
    r += 1
    rate = doc["tax_rate"]
    cell(items, r, 0, r, 2, "含税金额（大写）：", bold=True, h="right", indent=0, open_side="r", **cap)
    cell(items, r, 3, r, 8, doc["taxed_upper"], upper_formula(f"K{r}"), indent=0, open_side="l", **cap)
    cell(items, r, 9, r, 9, f"含税总计\n(含{rate}%税)", size=8, bold=True, h="center", fill=SHADE)
    cell(items, r, 10, r, 10, doc["taxed"], f"ROUND(K{tot}*(1+{rate}/100),2)", size=10, bold=True, h="right", fmt=MONEY_FMT)
    sh.heights[r] = 36
    r += 2
    sh.heights[r - 1] = 16

    # 条款（不画框，「标题：」粗体）
    box(r, 0, r, LAST, "订单条款与备注说明", size=8.5, bold=True, indent=0)
    sh.heights[r] = 15
    r += 1
    for i, t in enumerate(doc.get("terms") or [], 1):
        box(r, 0, r, LAST, _term(i, t), size=8, color=SUB, v="top", indent=0)
        sh.heights[r] = _lines(f"{i}. {t}", sum(WIDTHS), 8) * 14 + 1
        r += 1
    r += 1
    sh.heights[r - 1] = 24

    # 签章：需方、供方各只有「盖章」和「日期」；需方日期 = 订单日期，供方空着；需方默认盖公章
    sign = r
    box(r, 0, r, 5, f"需方：{buyer.get('name') or ''}", size=8.5, bold=True, font=SERIF, v="top", wrap=False, indent=0)
    box(r, 6, r, LAST, f"供方：{doc['seller']['name']}", size=8.5, bold=True, font=SERIF, v="top", wrap=False, indent=0)
    sh.heights[r] = 24
    r += 1
    box(r, 0, r, 5, "盖章：", size=8.5, color=SUB, v="top", indent=0)
    box(r, 6, r, LAST, "盖章：", size=8.5, color=SUB, v="top", indent=0)
    sh.heights[r] = 78
    r += 1
    line = {"b": ("thin", GREY)}
    box(r, 0, r, 4, f"日期：{cn_date(doc['date'])}", size=8.5, v="bottom", wrap=False, indent=0, sides=line)
    box(r, 6, r, 9, "日期：", size=8.5, color=SUB, v="bottom", wrap=False, indent=0, sides=line)
    sh.heights[r] = 18
    if doc.get("seal", True) and images.get("seal"):
        w, h = image_size(images["seal"])
        c, dx = _at(46)
        pics.append({"name": "公章", "data": images["seal"], "col": c, "row": sign - 1, "dx": dx, "dy": 0,
                     "w": SEAL_PT * min(1, w / max(h, 1)), "h": SEAL_PT * min(1, h / max(w, 1)), "alpha": 0.92})

    fit_height = 1 if len(doc["lines"]) <= 20 else 0
    return package(sh.xml(WIDTHS, fit_height, (0.67, 0.67, 0.64, 0.69), footer="&C&7第 &P 页  共 &N 页", drawing=bool(pics)),
                   st.xml(), doc["no"][:31], pics)


def _term(i: int, t: str) -> list:
    """「标题：正文」→ 标题粗体（黑），正文灰。"""
    k = next((j for j, ch in enumerate(t[:21]) if ch in "：:"), -1)
    head, body = (t[:k + 1], t[k + 1:]) if k > 0 else ("", t)
    runs = [(f"{i}. ", {"sz": 8, "color": SUB})]
    if head:
        runs.append((head, {"b": 1, "sz": 8, "color": INK}))
    runs.append((body, {"sz": 8, "color": SUB}))
    return runs


def _named(party: dict) -> list:
    """公司名粗体，下面几行正常（跟样张一样）。"""
    runs = [(party.get("name") or "", {"b": 1, "sz": 9, "color": INK})]
    if party.get("lines"):
        runs.append(("\n" + "\n".join(party["lines"]), {"sz": 8.5, "color": SUB}))
    return runs


def _ref(r1: int, c1: int, r2: int, c2: int) -> str:
    return f"{col(c1)}{r1}:{col(c2)}{r2}"

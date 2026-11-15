"""把一张采购订单（purchase.build 的结果）写成 .xlsx，格子照 Zane 11-15 给的采购订单样张。只用标准库，字体全用等线（Zane 11-15）。

小计、合计、含税总计、金额大写都是公式（带算好的值）：在 Excel 里改数量或单价会跟着变；大写用 TEXT 的 [DBNum2]。
"""
from __future__ import annotations

import math

from invoice_xlsx import Sheet, Styles, col, package
from purchase import cn_date

INK = "FF111111"
LINE = "FF333333"
MONEY_FMT = '"¥"#,##0.00'
WIDTHS = [5.8, 5.8, 1.9, 9.6, 5.8, 17.2, 13.4, 7.7, 5.8, 11.6, 12.6]  # A–K
LAST = len(WIDTHS) - 1


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


def render(doc: dict, cfg: dict) -> bytes:
    st = Styles()
    sh = Sheet()

    def style(size=9.5, bold=False, h="left", v="center", border=None, fmt=None, wrap=True):
        return st.get(size=size, bold=bold, color=INK, h=h, v=v, border=border or False, fmt=fmt, wrap=wrap,
                      indent=0 if h == "center" else 1, line=LINE)

    def box(r1, c1, r2, c2, value=None, formula=None, sides=None, **kw):
        """写一个（合并）格子；sides 给外框，如 {"l": "thin", "t": "medium"}，每个小格只画落在外边上的那几条。"""
        sides = sides or {}
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                edge = {k: s for k, s in sides.items()
                        if (k == "l" and c == c1) or (k == "r" and c == c2) or (k == "t" and r == r1) or (k == "b" and r == r2)}
                sh.put(r, c, value if (r, c) == (r1, c1) else None, style(border=edge, **kw),
                       formula if (r, c) == (r1, c1) else None)
        if (r1, c1) != (r2, c2):
            sh.merges.append(_ref(r1, c1, r2, c2))

    thin = {k: "thin" for k in "lrtb"}

    # 抬头
    buyer = cfg.get("buyer") or {}
    head = [(buyer.get("name") or "", 17, True)] + [(line, 8, False) for line in buyer.get("lines") or []]
    for r, (text, size, bold) in enumerate(head, 1):  # 抬头最后一行下面一条粗线
        box(r, 0, r, LAST, text, size=size, bold=bold, wrap=False, sides={"b": "medium"} if r == len(head) else None)
        sh.heights[r] = 26 if r == 1 else 13
    r = len(head) + 2
    box(r, 0, r, LAST, "采 购 订 单", size=15, bold=True, h="center", wrap=False)
    sh.heights[r] = 24
    r += 2

    # 订单信息
    for a, b, c, d in (("订单编号", doc["no"], "订单日期", cn_date(doc["date"])),
                       ("交付日期", cn_date(doc.get("due") or ""), "客户订单号", doc.get("customer_po") or "")):
        box(r, 0, r, 2, a, sides=thin)
        box(r, 3, r, 5, b, sides=thin)
        box(r, 6, r, 6, c, sides=thin)
        box(r, 7, r, LAST, d, sides=thin)
        sh.heights[r] = 23
        r += 1
    seller = "\n".join([doc["seller"]["name"], *doc["seller"]["lines"]])
    ship = "\n".join([x for x in [doc["ship_to"]["name"], *doc["ship_to"]["lines"]] if x])
    box(r, 0, r, 2, "供方（卖方）", sides=thin, v="top")
    box(r, 3, r, 5, _named(doc["seller"]), sides=thin, v="top")
    box(r, 6, r, 6, "收货信息", sides=thin, v="top")
    box(r, 7, r, LAST, _named(doc["ship_to"]), sides=thin, v="top")
    n = max(_lines(seller, sum(WIDTHS[3:6]), 9.5), _lines(ship, sum(WIDTHS[7:]), 9.5), 3)
    sh.heights[r] = round(n * 15.5 + 6, 1)
    r += 2

    # 明细
    cols = [((0, 0), "序号"), ((1, 1), "行号"), ((2, 3), "物料编码\n(P/N)"), ((4, 4), "版本"), ((5, 7), "产品描述 (Description)"),
            ((8, 8), "数量"), ((9, 9), "单价 (RMB)"), ((10, 10), "小计 (RMB)")]

    def outer(c1, c2, **extra):
        s = {"l": "medium" if c1 == 0 else "thin", "r": "medium" if c2 == LAST else "thin", "t": "thin", "b": "thin"}
        s.update(extra)
        return s

    for (c1, c2), text in cols:
        box(r, c1, r, c2, text, size=9, h="center", sides=outer(c1, c2, t="medium"))
    sh.heights[r] = 36
    r += 1
    first = r
    for i, ln in enumerate(doc["lines"], 1):
        vals = {0: i, 1: ln.get("line") or "", 2: ln["pn"], 4: ln.get("rev") or "", 5: ln.get("desc") or "", 8: ln["qty"], 9: ln["price"]}
        for (c1, c2), _t in cols:
            h = "left" if c1 == 5 else ("right" if c1 in (9, 10) else "center")
            fmt = MONEY_FMT if c1 in (9, 10) else None
            if c1 == 10:
                box(r, c1, r, c2, ln["amount"], f"ROUND(I{r}*J{r},2)", size=8, h=h, fmt=fmt, sides=outer(c1, c2))
            else:
                box(r, c1, r, c2, vals[c1], size=8, h=h, fmt=fmt, sides=outer(c1, c2))
        sh.heights[r] = max(26.6, _lines(str(ln.get("desc") or ""), sum(WIDTHS[5:8]), 8) * 12 + 4)
        r += 1
    last = r - 1
    tot = r
    box(r, 0, r, 7, "合计金额（大写）：" + doc["total_upper"], f'"合计金额（大写）："&{upper_formula(f"K{r}")}', size=9, bold=True,
        sides={"l": "medium", "t": "medium", "b": "thin"})
    box(r, 8, r, 8, doc["qty_total"], f"SUM(I{first}:I{last})", size=9, bold=True, h="center", sides={"t": "medium", "l": "thin", "b": "thin"})
    box(r, 9, r, 9, "总计\n(Total)", size=9, bold=True, h="center", sides={"t": "medium", "l": "thin", "b": "thin"})
    box(r, 10, r, 10, doc["total"], f"SUM(K{first}:K{last})", size=9, bold=True, h="right", fmt=MONEY_FMT,
        sides={"t": "medium", "l": "thin", "r": "medium", "b": "thin"})
    sh.heights[r] = 42
    r += 1
    rate = doc["tax_rate"]
    box(r, 0, r, 8, "含税金额（大写）：" + doc["taxed_upper"], f'"含税金额（大写）："&{upper_formula(f"K{r}")}', size=9, bold=True,
        sides={"l": "medium", "t": "medium", "b": "medium"})
    box(r, 9, r, 9, f"含税总计\n(含{rate}%税)", size=9, bold=True, h="center", sides={"t": "medium", "l": "thin", "b": "medium"})
    box(r, 10, r, 10, doc["taxed"], f"ROUND(K{tot}*(1+{rate}/100),2)", size=9, bold=True, h="right", fmt=MONEY_FMT,
        sides={"t": "medium", "l": "thin", "r": "medium", "b": "medium"})
    sh.heights[r] = 42
    r += 2

    # 条款
    terms = ["订单条款与备注说明："] + [f"{i}. {t}" for i, t in enumerate(doc.get("terms") or [], 1)]
    t0, t1 = r, r + len(terms) - 1
    for k, text in enumerate(terms):
        sides = {"l": "thin", "r": "thin"}
        if r == t0:
            sides["t"] = "thin"
        if r == t1:
            sides["b"] = "thin"
        box(r, 0, r, LAST, text, size=8, bold=(k == 0), v="top", sides=sides)
        sh.heights[r] = 13 if k == 0 else _lines(text, sum(WIDTHS), 8) * 12.5 + 2
        r += 1

    fit_height = 1 if len(doc["lines"]) <= 20 else 0
    return package(sh.xml(WIDTHS, fit_height, (0.6, 0.6, 0.7, 0.6)), st.xml(), doc["no"][:31])


def _named(party: dict) -> list:
    """公司名粗体，下面几行正常（跟样张一样）。"""
    runs = [(party.get("name") or "", {"b": 1, "sz": 9.5, "color": INK})]
    if party.get("lines"):
        runs.append(("\n" + "\n".join(party["lines"]), {"sz": 9.5, "color": INK}))
    return runs


def _ref(r1: int, c1: int, r2: int, c2: int) -> str:
    return f"{col(c1)}{r1}:{col(c2)}{r2}"

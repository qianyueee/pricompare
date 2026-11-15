"""把一张 invoice（invoice.build 的结果）写成 .xlsx，样子照 Zane 11-15 给的样张。只用标准库。

金额、服务费小计、合计都写成公式（带算好的值），在 Excel 里改订单金额或费率会跟着变。
"""
from __future__ import annotations

import zipfile
from io import BytesIO
from xml.sax.saxutils import escape

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
FONT = "等线"
DARK = "FF3B5163"  # 表头深蓝灰
BAND = "FFEBF1DE"  # 隔行浅绿
TOTAL = "FFEEECE1"  # 合计行
LINE = "FF7F7F7F"
MONEY_FMT = '"¥"#,##0.00'
USD_FMT = '"$"#,##0.00'


def col(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


class Styles:
    """按需登记字体/填充/边框/数字格式，返回 cellXfs 的序号。"""

    def __init__(self):
        self.fonts = [f'<font><sz val="11"/><name val="{FONT}"/><family val="2"/></font>']
        self.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>']
        self.borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>']
        self.numfmts: dict[str, int] = {}
        self.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>']
        self.cache: dict[tuple, int] = {}

    @staticmethod
    def _idx(lst: list[str], xml: str) -> int:
        if xml not in lst:
            lst.append(xml)
        return lst.index(xml)

    def get(self, size=11, bold=False, color=None, fill=None, border=False, fmt=None, h=None, v="center",
            font=None, wrap=False, indent=0, line=LINE) -> int:
        """border：True = 四边细线；或 {"l"/"r"/"t"/"b": "thin"/"medium"} 只画这几边。"""
        if isinstance(border, dict):
            border = tuple(sorted((k, v_) for k, v_ in border.items() if v_))
        key = (size, bold, color, fill, border, fmt, h, v, font, wrap, indent, line)
        if key in self.cache:
            return self.cache[key]
        b_xml = "<b/>" if bold else ""
        c_xml = '<color rgb="%s"/>' % color if color else ""
        font_xml = f'<font>{b_xml}<sz val="{size}"/>{c_xml}<name val="{font or FONT}"/><family val="2"/></font>'
        fid = self._idx(self.fonts, font_xml)
        flid = self._idx(self.fills, f'<fill><patternFill patternType="solid"><fgColor rgb="{fill}"/><bgColor indexed="64"/></patternFill></fill>') if fill else 0
        if border:
            sides = dict(border) if isinstance(border, tuple) else {k: "thin" for k in "lrtb"}
            parts = []
            for k, name in (("l", "left"), ("r", "right"), ("t", "top"), ("b", "bottom")):
                parts.append(f'<{name} style="{sides[k]}"><color rgb="{line}"/></{name}>' if sides.get(k) else f"<{name}/>")
            bid = self._idx(self.borders, "<border>" + "".join(parts) + "<diagonal/></border>")
        else:
            bid = 0
        if fmt is None:
            nid = 0
        elif fmt == "0.00%":
            nid = 10
        else:
            nid = self.numfmts.setdefault(fmt, 164 + len(self.numfmts))
        h_xml = ' horizontal="%s"' % h if h else ""
        w_xml = ' wrapText="1"' if wrap else ""
        i_xml = ' indent="%d"' % indent if indent else ""
        align = f'<alignment{h_xml} vertical="{v}"{w_xml}{i_xml}/>'
        self.xfs.append(f'<xf numFmtId="{nid}" fontId="{fid}" fillId="{flid}" borderId="{bid}" xfId="0" applyFont="1" '
                        f'applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1">{align}</xf>')
        self.cache[key] = len(self.xfs) - 1
        return self.cache[key]

    def xml(self) -> str:
        nf = "".join(f'<numFmt numFmtId="{i}" formatCode="{escape(c, {chr(34): "&quot;"})}"/>' for c, i in self.numfmts.items())
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="{MAIN}">'
                + (f'<numFmts count="{len(self.numfmts)}">{nf}</numFmts>' if nf else "")
                + f'<fonts count="{len(self.fonts)}">{"".join(self.fonts)}</fonts>'
                + f'<fills count="{len(self.fills)}">{"".join(self.fills)}</fills>'
                + f'<borders count="{len(self.borders)}">{"".join(self.borders)}</borders>'
                + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
                + f'<cellXfs count="{len(self.xfs)}">{"".join(self.xfs)}</cellXfs>'
                + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')


class Sheet:
    def __init__(self):
        self.cells: dict[tuple[int, int], tuple] = {}
        self.merges: list[str] = []
        self.heights: dict[int, float] = {}

    def put(self, r: int, c: int, value=None, style: int = 0, formula: str | None = None) -> None:
        self.cells[(r, c)] = (value, style, formula)

    def merge(self, r1: int, c1: int, r2: int, c2: int, style: int = 0) -> None:
        self.merges.append(f"{col(c1)}{r1}:{col(c2)}{r2}")
        for r in range(r1, r2 + 1):
            for c in range(c1, c2 + 1):
                if (r, c) not in self.cells:
                    self.put(r, c, None, style)

    def xml(self, widths: list[float], fit_height: int = 0, margins: tuple = (0.4, 0.4, 0.5, 0.5)) -> str:
        rows: dict[int, list] = {}
        for (r, c), v in sorted(self.cells.items()):
            rows.setdefault(r, []).append((c, v))
        out = []
        for r in sorted(rows):
            cs = []
            for c, (value, style, formula) in rows[r]:
                ref = f"{col(c)}{r}"
                s = f' s="{style}"' if style else ""
                if formula is not None:
                    if isinstance(value, str):  # 文字结果的公式（如金额大写），带上算好的文字
                        cs.append(f'<c r="{ref}"{s} t="str"><f>{escape(formula)}</f><v>{escape(value)}</v></c>')
                        continue
                    cached = f"<v>{value}</v>" if isinstance(value, (int, float)) and not isinstance(value, bool) else ""
                    cs.append(f'<c r="{ref}"{s}><f>{escape(formula)}</f>{cached}</c>')
                elif value is None or value == "":
                    cs.append(f'<c r="{ref}"{s}/>')
                elif isinstance(value, (int, float)) and not isinstance(value, bool):
                    cs.append(f'<c r="{ref}"{s}><v>{value}</v></c>')
                elif isinstance(value, list):  # 一格里几段不同字体，如 [("公司名", {"b": 1, "sz": 9.5}), ("\n地址…", {"sz": 9.5})]
                    runs = "".join(_run(t, fmt) for t, fmt in value)
                    cs.append(f'<c r="{ref}"{s} t="inlineStr"><is>{runs}</is></c>')
                else:
                    cs.append(f'<c r="{ref}"{s} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
            ht = f' ht="{self.heights[r]}" customHeight="1"' if r in self.heights else ""
            out.append(f'<row r="{r}"{ht}>{"".join(cs)}</row>')
        cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths))
        cells = "".join('<mergeCell ref="%s"/>' % m for m in self.merges)
        merges = f'<mergeCells count="{len(self.merges)}">{cells}</mergeCells>' if self.merges else ""
        return (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="{MAIN}" xmlns:r="{REL}">'
                '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
                '<sheetViews><sheetView workbookViewId="0" showGridLines="0"/></sheetViews>'
                f'<sheetFormatPr defaultRowHeight="15"/><cols>{cols}</cols><sheetData>{"".join(out)}</sheetData>{merges}'
                '<printOptions horizontalCentered="1"/>'
                + ('<pageMargins left="%s" right="%s" top="%s" bottom="%s" header="0.3" footer="0.3"/>' % margins)
                + f'<pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="{fit_height}"/></worksheet>')


def _run(text: str, fmt: dict) -> str:
    b = "<b/>" if fmt.get("b") else ""
    color = '<color rgb="%s"/>' % fmt["color"] if fmt.get("color") else ""
    rpr = f'<rPr>{b}<sz val="{fmt.get("sz", 11)}"/>{color}<rFont val="{fmt.get("font", FONT)}"/><family val="2"/></rPr>'
    return f'<r>{rpr}<t xml:space="preserve">{escape(text)}</t></r>'


def _md_y(iso: str) -> str:
    """2026-10-12 → 10/12/26（样张的写法）。"""
    return f"{iso[5:7]}/{iso[8:10]}/{iso[2:4]}" if iso and len(iso) >= 10 else ""


def render(inv: dict, cfg: dict) -> bytes:
    st = Styles()
    sh = Sheet()
    with_amount = bool(inv.get("with_amount"))
    ncol = 9 if with_amount else 8
    last = ncol - 1
    widths = [11, 12, 12, 18, 15, 12, 12, 15] + ([15] if with_amount else [])

    title = st.get(size=26, bold=True, h="right")
    company = st.get(size=18, color="FF1F3B4D")
    small = st.get(size=10, color="FF404040")
    label = st.get(size=10, bold=True, color="FF404040")
    value = st.get(size=11)
    to_label = st.get(size=11, bold=True, h="right", v="top")
    to_text = st.get(size=10)

    # 抬头
    sh.put(1, last - 2, "Invoice", title)
    sh.merge(1, last - 2, 1, last, title)
    sh.heights[1] = 34
    sh.put(2, 0, cfg.get("company") or "", company)
    sh.merge(2, 0, 2, 3, company)
    sh.heights[2] = 26
    if cfg.get("phone"):
        sh.put(4, 0, f"电话号码：{cfg['phone']}", small)
        sh.merge(4, 0, 4, 2, small)  # 合并到 C 列：有的查看器（Quick Look）不让文字溢出到右边空格子
    if cfg.get("email"):
        sh.put(5, 0, f"邮箱：{cfg['email']}", small)
        sh.merge(5, 0, 5, 2, small)
    y, m, d = inv["date"][:4], int(inv["date"][5:7]), int(inv["date"][8:10])
    for r, (k, v) in enumerate((("发票号码：", inv["no"]), ("发票日期：", f"{m}月{d}日"), ("客户联系人：", inv.get("contact") or "")), 8):
        sh.put(r, 0, k, label)
        sh.put(r, 1, v, value)
    for r0, name, key in ((3, "Ship To:", "ship_to"), (8, "Bill To:", "bill_to")):
        lines = [str(x) for x in cfg.get(key) or []][:5]
        if lines:
            sh.put(r0, 3, name, to_label)
            for i, ln in enumerate(lines):
                sh.put(r0 + i, 4, ln, to_text)

    # 明细
    head = st.get(bold=True, color="FFFFFFFF", fill=DARK, border=True, h="center")
    heads = ["序号", "完成日期", "订单号", "Vendor", "订单金额", "Service Tier", "服务费（%）", "服务费小计"] + (["应收小计"] if with_amount else [])
    hr = 13
    for c, t in enumerate(heads):
        sh.put(hr, c, t, head)
    sh.heights[hr] = 22
    first = hr + 1
    rows = inv["rows"]
    lastrow = first + len(rows) - 1
    for i, row in enumerate(rows):
        r = first + i
        fill = BAND if i % 2 == 0 else None
        txt = st.get(fill=fill, border=True, h="center")
        mon = st.get(fill=fill, border=True, h="center", fmt=MONEY_FMT)
        pct = st.get(fill=fill, border=True, h="center", fmt="0.00%")
        sh.heights[r] = 20
        sh.put(r, 0, i + 1, txt)
        sh.put(r, 1, _md_y(row.get("done") or ""), txt)
        sh.put(r, 2, row["po"], txt)
        sh.put(r, 3, row["vendor"], txt)
        sh.put(r, 4, row["amount"], mon)
        sh.put(r, 5, row.get("tier") or "", txt)
        sh.put(r, 6, round(row["rate"] / 100, 6), pct)
        sh.put(r, 7, row["fee"], mon, f"ROUND(E{r}*G{r},2)")
        if with_amount:
            sh.put(r, 8, row["due"], mon, f"H{r}+E{r}" if row["with_amount"] else f"H{r}")

    # 按 vendor 合计，再总计
    tl = st.get(bold=True, fill=TOTAL, border=True, h="center")
    tm = st.get(bold=True, fill=TOTAL, border=True, h="center", fmt=MONEY_FMT)
    tp = st.get(bold=True, fill=TOTAL, border=True, h="center", fmt="0.00%")
    tu = st.get(bold=True, fill=TOTAL, border=True, h="center", fmt=USD_FMT)
    r = lastrow
    rng = lambda c: f"${col(c)}${first}:${col(c)}${lastrow}"  # noqa: E731
    for v in inv["vendors"]:
        r += 1
        sh.heights[r] = 20
        sh.put(r, 0, "总计", tl)
        sh.put(r, 1, None, tl)
        sh.put(r, 2, None, tl)
        sh.put(r, 3, v["vendor"], tl)
        sh.put(r, 4, v["amount"], tm, f"SUMIF({rng(3)},D{r},{rng(4)})")
        sh.put(r, 5, v.get("tier") or None, tl)
        sh.put(r, 6, round(v["rate"] / 100, 6) if v.get("rate") is not None else None, tp)
        sh.put(r, 7, v["fee"], tm, f"SUMIF({rng(3)},D{r},{rng(7)})")
        if with_amount:
            sh.put(r, 8, v["due"], tm, f"SUMIF({rng(3)},D{r},{rng(8)})")
    r += 1
    total_row = r
    sh.heights[r] = 22
    sh.put(r, 0, "总计人民币", tl)
    for c in range(1, last):
        sh.put(r, c, None, tl)
    sh.put(r, last, inv["total"], tm, f"SUM({rng(last)})")
    r += 1
    sh.heights[r] = 22
    sh.put(r, 0, "折合美元", tl)
    for c in range(1, last):
        sh.put(r, c, None, tl)
    if inv.get("usd_rate"):
        sh.put(r, last - 2, f"汇率 {inv['usd_rate']}", tl)
        sh.put(r, last, inv.get("usd"), tu, f"ROUND({col(last)}{total_row}/{inv['usd_rate']},2)")
    else:
        sh.put(r, last, None, tu)

    # 页脚
    foot = st.get(size=10, h="center")
    foot_b = st.get(size=11, bold=True, h="center")
    lines = [str(x).replace("{phone}", cfg.get("phone") or "") for x in cfg.get("footer") or []]
    for i, ln in enumerate(lines):
        r += 2 if i == 0 else 1
        s = foot_b if i == len(lines) - 1 and len(lines) > 1 else foot
        sh.put(r, 0, ln, s)
        sh.merge(r, 0, r, last, s)

    return package(sh.xml(widths), st.xml(), "Invoice")


def package(sheet_xml: str, styles_xml: str, sheet_name: str) -> bytes:
    """一个工作表的 .xlsx（打开时让 Excel 重算公式）。"""
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                   '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                   '<Default Extension="xml" ContentType="application/xml"/>'
                   '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                   '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
                   '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
                   '</Types>')
        z.writestr("_rels/.rels", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{PKG}">'
                   f'<Relationship Id="rId1" Type="{REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr("xl/workbook.xml", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="{MAIN}" xmlns:r="{REL}">'
                   f'<sheets><sheet name="{escape(sheet_name, {chr(34): "&quot;"})}" sheetId="1" r:id="rId1"/></sheets>'
                   '<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels", f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="{PKG}">'
                   f'<Relationship Id="rId1" Type="{REL}/worksheet" Target="worksheets/sheet1.xml"/>'
                   f'<Relationship Id="rId2" Type="{REL}/styles" Target="styles.xml"/></Relationships>')
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)
        z.writestr("xl/styles.xml", styles_xml)
    return buf.getvalue()

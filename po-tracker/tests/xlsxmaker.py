"""测试用：拼一个最小的 .xlsx（只有文字和数字格子）。文字用共享字符串，跟 Excel 存出来的一样。"""
from __future__ import annotations

import zipfile
from io import BytesIO
from xml.sax.saxutils import escape

MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _col(i: int) -> str:
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


def make_xlsx(sheets: dict[str, list[list]], date1904: bool = False) -> bytes:
    shared: list[str] = []
    idx: dict[str, int] = {}

    def sst(text: str) -> int:
        if text not in idx:
            idx[text] = len(shared)
            shared.append(text)
        return idx[text]

    sheet_xml = []
    for rows in sheets.values():
        out = []
        for r, row in enumerate(rows, 1):
            cells = []
            for c, v in enumerate(row):
                ref = f"{_col(c)}{r}"
                if v is None:
                    continue
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    cells.append(f'<c r="{ref}"><v>{v}</v></c>')
                else:
                    cells.append(f'<c r="{ref}" t="s"><v>{sst(str(v))}</v></c>')
            out.append(f'<row r="{r}">{"".join(cells)}</row>')
        sheet_xml.append(f'<worksheet xmlns="{MAIN}"><sheetData>{"".join(out)}</sheetData></worksheet>')

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        pr = '<workbookPr date1904="1"/>' if date1904 else ""
        sh = "".join(f'<sheet name="{escape(n)}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(sheets, 1))
        z.writestr("xl/workbook.xml", f'<workbook xmlns="{MAIN}" xmlns:r="{REL}">{pr}<sheets>{sh}</sheets></workbook>')
        rels = "".join(
            f'<Relationship Id="rId{i}" Type="{REL}/worksheet" Target="worksheets/sheet{i}.xml"/>'
            for i in range(1, len(sheets) + 1))
        z.writestr("xl/_rels/workbook.xml.rels",
                   f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>')
        for i, x in enumerate(sheet_xml, 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", x)
        si = "".join(f"<si><t>{escape(s)}</t></si>" for s in shared)
        z.writestr("xl/sharedStrings.xml", f'<sst xmlns="{MAIN}">{si}</sst>')
    return buf.getvalue()


HEADER = ["Item #", "PO #", "Line Item", "PO Date", "Due Date", "End User", "Invoice #", "WO#", "WO Date", "WO Due",
          "Vendor", "P/N", "Rev", "Description", "WO Q'ty", "WO RMB", "WO Sub", "Next Step", "清洗单号", "物流状态",
          "发货日期", "预计发货日期", "备注"]


def row(**kw) -> list:
    """按列名给值，其余空着。列名里的特殊字符用下划线代替：WO_ → WO#，PO_ → PO #，qty → WO Q'ty。"""
    alias = {"WO_": "WO#", "PO_": "PO #", "qty": "WO Q'ty", "WO_Due": "WO Due", "WO_Date": "WO Date", "PN": "P/N",
             "WO_Sub": "WO Sub", "WO_RMB": "WO RMB", "End_User": "End User", "Due_Date": "Due Date",
             "Line_Item": "Line Item"}
    vals = {alias.get(k, k): v for k, v in kw.items()}
    unknown = set(vals) - set(HEADER)
    assert not unknown, unknown
    return [vals.get(h) for h in HEADER]


def sample_tracker() -> bytes:
    """三个 WO：90101 华晨 两行一行已发一行没发；90102 凯维 全部完成；90103 兴华 取消。"""
    return make_xlsx({
        "跟单进展": [["最后更新时间 2026/11/12 09：30"], ["客户", "说明"]],
        "订单明细": [
            HEADER,
            row(WO_="90101", Vendor="Huachen", PN="A-1", qty=2, WO_RMB=100, WO_Sub=200, WO_Due=46350, WO_Date=46330,
                PO_="C-1", End_User="Ann", 发货日期=46340, 备注="已发 DHL"),
            row(WO_="90101", Vendor="Huachen", PN="A-2", qty=1, WO_RMB=50.5, WO_Sub=50.5, WO_Due=46345, WO_Date=46331,
                PO_="C-1", End_User="Ann", 预计发货日期="随时", 发货日期=36526, 备注="等电镀"),
            row(WO_="90102", Vendor="Shenzhen Kaiwei", PN="B-1", WO_Due="2026/11/20", 备注="完成"),
            row(WO_="90103", Vendor="Xinghua", PN="C-1", WO_Due="11/25/2026", 备注="客户取消"),
            row(WO_=None, Vendor="Huachen", PN="空行"),
        ],
    })

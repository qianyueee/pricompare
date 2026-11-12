"""tracker.py（读跟单总表）的测试。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_tracker  # noqa: E402
import tracker  # noqa: E402
from xlsxmaker import HEADER, make_xlsx, row, sample_tracker  # noqa: E402


class TrackerTest(unittest.TestCase):
    def setUp(self):
        self.doc = tracker.parse_tracker(sample_tracker())
        self.by = {(o["po"], o["supplier"]): o for o in self.doc["orders"]}

    def test_groups_and_vendor_names(self):
        self.assertEqual(sorted(self.by), [("90101", "华晨"), ("90102", "凯维"), ("90103", "兴华")])
        self.assertEqual(self.doc["rows"], 4)  # 没有 WO# 的行不算
        self.assertEqual(self.doc["note"], "最后更新时间 2026/11/12 09：30")

    def test_open_order_uses_open_lines(self):
        o = self.by[("90101", "华晨")]
        self.assertFalse(o["closed"])
        self.assertEqual(o["status"], "")
        self.assertEqual(o["open_lines"], 1)
        self.assertEqual(o["due_date"], "2026-11-19")  # 只看没结束的那行
        self.assertEqual(o["due_text"], "11/19、11/24")  # 交期不止一个时都列出来
        self.assertEqual(o["notes"], ["等电镀"])
        self.assertEqual(o["eta"], ["随时"])
        self.assertEqual(o["shipped"], ["2026-11-14"])
        self.assertEqual(o["order_date"], "2026-11-04")
        self.assertEqual(o["amount"], 250.5)
        self.assertEqual(o["customer_po"], "C-1")
        self.assertEqual(o["end_user"], "Ann")
        a1, a2 = o["lines"]
        self.assertTrue(a1["closed"])  # 填了发货日期
        self.assertFalse(a2["closed"])  # 1/1/2000 是占位，不算发货
        self.assertIsNone(a2["shipped"])
        self.assertEqual((a2["qty"], a2["unit_price"]), (1, 50.5))

    def test_closed_orders(self):
        done = self.by[("90102", "凯维")]
        self.assertEqual((done["closed"], done["status"], done["due_date"]), (True, "已完成", "2026-11-20"))
        cancelled = self.by[("90103", "兴华")]
        self.assertEqual((cancelled["closed"], cancelled["status"], cancelled["due_date"]), (True, "已取消", "2026-11-25"))

    def test_same_wo_two_vendors_stay_apart(self):
        data = make_xlsx({"订单明细": [HEADER, row(WO_="44278", Vendor="Kaiwei", 备注="a"),
                                        row(WO_="44278", Vendor="Xinghua", 备注="b")]})
        orders = tracker.parse_tracker(data)["orders"]
        self.assertEqual(sorted((o["po"], o["supplier"]) for o in orders), [("44278", "兴华"), ("44278", "凯维")])

    def test_dates(self):
        self.assertEqual(str(tracker.to_date(46350)), "2026-11-24")
        self.assertEqual(str(tracker.to_date(46350.75)), "2026-11-24")
        self.assertEqual(str(tracker.to_date(44888, date1904=True)), "2026-11-24")
        self.assertEqual(str(tracker.to_date("2026-11-24 00:00:00")), "2026-11-24")
        self.assertEqual(str(tracker.to_date("11/24/26")), "2026-11-24")
        for v in (None, "", "随时", 12, "13/40/2026", True):
            self.assertIsNone(tracker.to_date(v), v)

    def test_header_not_on_first_row(self):
        data = make_xlsx({"订单明细": [["跟单明细"], [], HEADER, row(WO_="1", Vendor="Huachen", 备注="x")]})
        self.assertEqual(len(tracker.parse_tracker(data)["orders"]), 1)

    def test_errors_are_readable(self):
        cases = [
            (b"not a zip", "不是 .xlsx"),
            (make_xlsx({"Sheet1": [["a"]]}), "找不到「订单明细」"),
            (make_xlsx({"订单明细": [["a", "b"]]}), "找不到表头"),
            (make_xlsx({"订单明细": [["WO#", "WO Due", "Vendor"]]}), "缺少这些列：P/N、备注"),
        ]
        for data, msg in cases:
            with self.assertRaises(tracker.TrackerError) as cm:
                tracker.parse_tracker(data)
            self.assertIn(msg, str(cm.exception))


class ImportTest(unittest.TestCase):
    """import_tracker：总表为准，邮件里的 PO 不丢。"""

    def sheet(self):
        return make_xlsx({"订单明细": [
            HEADER,
            row(WO_="44278", Vendor="Kaiwei", PN="K-1", WO_Due=46340, 备注="在做"),
            row(WO_="44278A", Vendor="Xinghua", PN="X-1", WO_Due=46342, 预计发货日期=46345),
            row(WO_="44100", Vendor="Huachen", PN="H-1", WO_Due=46300, 发货日期=46310, 备注="10.8发走了"),
            row(WO_="44101", Vendor="Huachen", PN="H-2", WO_Due=46301, 备注="完成"),
        ]})

    def mail(self):
        return [
            {"po": "44278", "supplier": "凯维", "status": "已发货", "mails": [{"subject": "a"}]},
            {"po": "44278", "supplier": "兴华", "status": "已确认", "due_date": "2026-11-12"},
            {"po": "44242", "supplier": "凯维", "status": "已下单"},
        ]

    def test_build(self):
        parsed = tracker.parse_tracker(self.sheet())
        orders, rep = import_tracker.build(parsed, self.mail(), "跟单总表 11/11")
        by = {import_tracker.order_key(o): o for o in orders}
        self.assertEqual(sorted(by), ["44100|华晨", "44101|华晨", "44242|凯维", "44278A|兴华", "44278|凯维"])
        k = by["44278|凯维"]
        self.assertEqual((k["status"], k["note"], k["note_by"], k["mails"], k["mail_status"]),
                         ("已下单", "在做", "跟单总表 11/11", [{"subject": "a"}], "已发货"))  # 总表说没结束，就不算已发货
        x = by["44278A|兴华"]
        self.assertEqual((x["status"], x["aliases"], x["eta"], x["source"]), ("已确认", ["44278"], "2026-11-19", "tracker"))
        self.assertEqual(by["44100|华晨"]["status"], "已发货")  # 只填了发货日期
        self.assertEqual(by["44101|华晨"]["status"], "已完成")
        self.assertNotIn("note", by["44101|华晨"])
        self.assertEqual(by["44242|凯维"]["source"], "mail")
        self.assertEqual([m["key"] for m in rep["mail_only"]], ["44242|凯维"])
        self.assertEqual([d["key"] for d in rep["status_differs"]], ["44278|凯维"])

    def test_main_writes_backup_and_reimport_keeps_mail(self):
        import json
        import shutil
        import tempfile
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / "orders.json").write_text(json.dumps({"generated_at": "2026-11-12T13:37:00+09:00", "orders": self.mail()}),
                                             encoding="utf-8")
            xl = tmp / "跟单总表20261111 1.xlsx"
            xl.write_bytes(self.sheet())
            with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(import_tracker.main([str(xl), "--data", str(tmp), "--dry-run"]), 0)
            self.assertEqual(len(list(tmp.glob("orders.before-import-*"))), 0)
            for _ in range(2):  # 第二次导入：总表来的不能被当成邮件 PO 再留一份
                with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                    self.assertEqual(import_tracker.main([str(xl), "--data", str(tmp)]), 0)
                doc = json.loads((tmp / "orders.json").read_text(encoding="utf-8"))
                self.assertEqual(len(doc["orders"]), 5)
                self.assertEqual((doc["base"], doc["sheet_label"], doc["mail_generated_at"]),
                                 ("tracker", "跟单总表 11/11", "2026-11-12T13:37:00+09:00"))
                self.assertEqual(next(o for o in doc["orders"] if o["po"] == "44278A")["aliases"], ["44278"])
            self.assertTrue(list(tmp.glob("orders.before-import-*")))
            self.assertEqual(len(json.loads((tmp / "orders.mail.json").read_text(encoding="utf-8"))["orders"]), 3)
        finally:
            shutil.rmtree(tmp)


if __name__ == "__main__":
    unittest.main()

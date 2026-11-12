"""tracker.py（读跟单总表）的测试。"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
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
        self.assertEqual((done["closed"], done["status"], done["due_date"]), (True, "完成", "2026-11-20"))
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


if __name__ == "__main__":
    unittest.main()

"""autoflags.py 的测试（自动判断已发单 / 已发货）：python3 -m unittest discover -s tests（在 po-tracker/ 里跑）。
地址都是假的（example.* / 测试用域名），不放真实邮件内容。"""
import json
import shutil
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import autoflags  # noqa: E402
import po_server  # noqa: E402

CFG = autoflags.Config({
    "vendor_mail": {"华晨": ["hc.example.com", "hc2.example.com"], "凯维": ["kw.example.cn"], "兴华": ["xh@qq.example.com"]},
    "ignore_mail": ["me@gmail.example.com"],
    "us_domains": ["us.example.com"],
})


def mail(i, frm, to, subject, folder="收件箱", date="2026-11-23T17:51:41+08:00", cc=""):
    return f"{folder}:{i}", {"folder": folder, "uid": i, "date": date, "from": frm, "to": to, "cc": cc, "subject": subject}


GENE = "Gene <buyer@kvstek.com>"
ZILL = "Zill <office@kvstek.com>"
TONY = "Tony <sales@us.example.com>"
US = "buyer@kvstek.com, office@kvstek.com"


class SubjectKeysTest(unittest.TestCase):
    def test_keys(self):
        k = autoflags.subject_keys
        self.assertEqual(k("PO 44401Due December 5，2026"), ["44401"])  # 号后面紧跟 Due
        self.assertEqual(k("PO44408+PO44395 Due December 4，2026"), ["44408", "44395"])
        self.assertEqual(k("PO 44408 + 44395 合并下单 华晨"), ["44408", "44395"])
        self.assertEqual(k("PO 44369A Due November 28，2026"), ["44369A"])
        self.assertEqual(k("采购表_凯阔_PO44369 交期 11.28，2026"), ["44369"])
        self.assertEqual(k("采购订单-PO-44403 交期 12.5，2026"), ["44403"])
        self.assertEqual(k("PO  44319 Due November 25，2026"), ["44319"])
        self.assertEqual(k("FW: PO #0012345678"), [])  # KLA 客户 PO 不算
        self.assertEqual(k("REPORT 44123"), [])


class SentTest(unittest.TestCase):
    def hits(self, *mails):
        return autoflags.sent_hits(dict(mails), CFG)

    def test_gene_to_supplier_counts(self):
        h = self.hits(mail(1, GENE, "a@hc.example.com, b@hc2.example.com", "PO44408+PO44395 Due December 4，2026"))
        s = autoflags.match_sent({"po": "44408", "supplier": "华晨"}, h, CFG)
        self.assertEqual((s["day"], s["side"], s["vendor"], s["from"]), ("2026-11-23", "我们", "华晨", "Gene"))
        self.assertTrue(autoflags.match_sent({"po": "44395", "supplier": "华晨"}, h, CFG))
        self.assertEqual(s["to"], "hc.example.com")  # 只给域名，不给完整地址

    def test_internal_draft_and_unknown_sender_do_not_count(self):
        h = self.hits(
            mail(1, ZILL, "buyer@kvstek.com", "PO44344", folder="已发送"),  # 只发给 Gene
            mail(2, ZILL, "a@hc.example.com", "PO 44344 Due", folder="草稿箱"),  # 草稿
            mail(3, "x <a@hc.example.com>", "office@kvstek.com", "Re: PO 44344"),  # 供应商发来的
            mail(4, GENE, "me@gmail.example.com", "PO 44344"),  # 不算供应商的地址
            mail(5, TONY, US, "PO 44344"),  # Tony 只发给我们
        )
        self.assertIsNone(autoflags.match_sent({"po": "44344", "supplier": "华晨"}, h, CFG))

    def test_tony_direct_and_cc(self):
        h = self.hits(
            mail(1, TONY, "a@kw.example.cn", "PO 44418", date="2026-11-24T15:39:58-08:00"),
            mail(2, TONY, US, "PO 44350", cc="a@kw.example.cn"),
        )
        s = autoflags.match_sent({"po": "44418", "supplier": "凯维"}, h, CFG)
        self.assertEqual((s["side"], s["day"]), ("美方", "2026-11-25"))  # 按北京时间算哪天
        s = autoflags.match_sent({"po": "44350", "supplier": "凯维"}, h, CFG)
        self.assertTrue(s["cc"])

    def test_prefers_first_non_reply(self):
        h = self.hits(
            mail(1, GENE, "a@hc.example.com", "Re: PO 44319", date="2026-11-13T10:00:00+08:00"),
            mail(2, GENE, "a@hc.example.com", "PO 44319 Due November 25，2026", date="2026-11-14T19:14:00+08:00"),
            mail(3, GENE, "a@hc.example.com", "PO 44319 Due November 26，2026", date="2026-11-15T19:14:00+08:00"),
        )
        s = autoflags.match_sent({"po": "44319", "supplier": "华晨"}, h, CFG)
        self.assertEqual((s["day"], s.get("reply")), ("2026-11-14", None))
        h = self.hits(mail(1, GENE, "a@hc.example.com", "回复：PO 44319"))
        self.assertTrue(autoflags.match_sent({"po": "44319", "supplier": "华晨"}, h, CFG)["reply"])

    def test_same_number_two_suppliers(self):
        # 44278 给了凯维，兴华那张总表改成 44278A；Zill 发兴华的信标题写的 44278
        h = self.hits(mail(1, ZILL, "xh@qq.example.com", "PO44278-Oframe", folder="已发送", date="2026-10-31T11:20:00+08:00"))
        self.assertIsNone(autoflags.match_sent({"po": "44278", "supplier": "凯维"}, h, CFG))
        self.assertEqual(autoflags.match_sent({"po": "44278A", "supplier": "兴华"}, h, CFG)["vendor"], "兴华")
        # 收件人认不出是哪家：只按号码完全一样的算
        h = self.hits(mail(1, GENE, "y@other.example.org", "PO 44278"))
        self.assertTrue(autoflags.match_sent({"po": "44278", "supplier": "凯维"}, h, CFG))
        self.assertIsNone(autoflags.match_sent({"po": "44278A", "supplier": "兴华"}, h, CFG))

    def test_us_side_needs_config(self):
        # 没配 us_domains：美方的地址算外面的，美方发来的信也不算我们这边发的
        h = autoflags.sent_hits(dict([mail(1, TONY, "a@kw.example.cn", "PO 44418")]), autoflags.Config())
        self.assertIsNone(autoflags.match_sent({"po": "44418", "supplier": "凯维"}, h, autoflags.Config()))

    def test_sub_vendor_counts(self):
        h = self.hits(mail(1, GENE, "xh@qq.example.com", "PO 44338"))
        self.assertTrue(autoflags.match_sent({"po": "44338", "supplier": "凯阔", "sub_vendor": "兴华"}, h, CFG))

    def test_attached_mail_with_wrong_number(self):
        # 44398 的单 Gene 标题写成 44393；po_sync 把信归到了 44398 下面。收件人要认得出就是这家
        h = self.hits(mail(7, GENE, "xh@qq.example.com", "PO 44393 交期 12.4，2026"))
        o = {"po": "44398", "supplier": "兴华", "mails": [{"folder": "收件箱", "uid": 7}]}
        self.assertEqual(autoflags.match_sent(o, h, CFG)["subject"], "PO 44393 交期 12.4，2026")
        o["supplier"] = "凯维"
        self.assertIsNone(autoflags.match_sent(o, h, CFG))
        # 44393 本身是凯维的单：发给兴华的不算
        self.assertIsNone(autoflags.match_sent({"po": "44393", "supplier": "凯维"}, h, CFG))

    def test_coverage_since(self):
        h = self.hits(
            mail(1, GENE, "a@hc.example.com", "PO 44001", date="2026-10-14T10:00:00+08:00"),
            mail(2, TONY, "a@kw.example.cn", "RE: PO 44002", date="2026-10-01T10:00:00+08:00"),  # 回复不算
            mail(3, TONY, "a@kw.example.cn", "PO 44003", date="2026-11-07T10:00:00+08:00"),
        )
        self.assertEqual(autoflags.coverage_since(h), "2026-11-07")


SHIPDOCS = {
    "44408": {"ships": [
        {"date": "20261201", "fac": "HC", "awb": ["111"], "with": ["44395"], "label": "INBOX:1"},
        {"date": "20261202", "fac": "KW", "awb": ["222"], "with": [], "label": "INBOX:2"},
        {"date": "20261202", "fac": "KW", "awb": [], "with": [], "label": "INBOX:3"},  # 同一天又一封：同一批
        {"date": "20261205", "fac": "KW", "awb": ["333"], "with": [], "label": "INBOX:4"},
    ]},
    "44369": {"ships": [{"date": "20261127", "fac": "KK", "awb": ["444"], "with": [], "label": "INBOX:5"}]},
}


class ShipTest(unittest.TestCase):
    def test_factory_must_fit_supplier(self):
        hc = autoflags.match_ships({"po": "44408", "supplier": "华晨"}, SHIPDOCS)
        self.assertEqual([(s["day"], s["awb"], s["with"]) for s in hc], [("2026-12-01", ["111"], ["44395"])])
        kw = autoflags.match_ships({"po": "44408A", "supplier": "凯维"}, SHIPDOCS)
        self.assertEqual([(s["day"], s["awb"], len(s["labels"])) for s in kw], [("2026-12-02", ["222"], 2), ("2026-12-05", ["333"], 1)])
        self.assertEqual(len(autoflags.match_ships({"po": "44408"}, SHIPDOCS)), 3)  # 供应商没定：都算
        self.assertEqual(len(autoflags.match_ships({"po": "44369", "supplier": "兴华"}, SHIPDOCS)), 1)  # KK = 凯阔自己发
        self.assertEqual(autoflags.match_ships({"po": "44369A", "supplier": "凯维"}, SHIPDOCS), [])
        self.assertEqual(autoflags.match_ships({"po": "44370", "supplier": "兴华"}, SHIPDOCS), [])


class AnnotateTest(unittest.TestCase):
    def setUp(self):
        hits = autoflags.sent_hits(dict([
            mail(1, GENE, "a@hc.example.com", "PO 44408 Due December 4，2026", date="2026-11-23T17:51:41+08:00"),
            mail(2, TONY, "a@kw.example.cn", "PO 44100", date="2026-11-07T10:00:00+08:00"),
        ]), CFG)
        self.data = {"hits": hits, "since": autoflags.coverage_since(hits), "shipdocs": SHIPDOCS}

    def test_flags(self):
        orders = [
            {"po": "44408", "supplier": "华晨", "status": "已下单", "order_date": "2026-11-23"},  # 发了、出货了
            {"po": "44408A", "supplier": "凯维", "status": "已确认", "order_date": "2026-11-23",
             "updated_at": "2026-12-03T10:00:00+09:00"},  # 12-02 那批人看过了，12-05 又来一批
            {"po": "44456", "supplier": "ZTL", "status": "已下单", "order_date": "2026-11-27", "mails": [{"folder": "收件箱", "uid": 9}]},
            {"po": "44457", "supplier": "ZTL", "status": "已下单", "order_date": "2026-11-27"},  # zill@ 里没这张单的信：不判断
            {"po": "44001", "supplier": "ZTL", "status": "已下单", "order_date": "2026-10-01", "mails": [{"folder": "收件箱", "uid": 9}]},  # 太早
            {"po": "44458", "supplier": "ZTL", "status": "已确认", "order_date": "2026-11-27", "mails": [{"folder": "收件箱", "uid": 9}]},
            {"po": "44369", "supplier": "兴华", "status": "已发货", "order_date": "2026-11-20"},  # 已发货：出货照记，不提醒
        ]
        info = autoflags.annotate(orders, self.data, CFG)
        a = {o["po"]: o.get("auto", {}) for o in orders}
        self.assertEqual(a["44408"]["sent"]["day"], "2026-11-23")
        self.assertEqual(a["44408"]["flags"], ["newship"])
        self.assertEqual(a["44408A"]["flags"], ["newship"])
        self.assertEqual(a["44456"]["flags"], ["nosent"])
        self.assertNotIn("flags", a["44457"])
        self.assertNotIn("flags", a["44001"])
        self.assertEqual(a["44458"], {})
        self.assertEqual(len(a["44369"]["ships"]), 1)
        self.assertNotIn("flags", a["44369"])
        self.assertEqual((info["nosent"], info["newship"], info["since"]), (1, 2, "2026-11-23"))
        # 原有字段一个不动
        self.assertEqual(orders[1]["status"], "已确认")
        self.assertNotIn("tracking", orders[0])

    def test_human_touch_and_sheet_baseline(self):
        o = {"po": "44408A", "supplier": "凯维", "status": "已下单", "updated_at": "2026-12-05T18:00:00+09:00"}
        autoflags.annotate([o], self.data, CFG)
        self.assertNotIn("flags", o["auto"])  # 12-05 那批出货以后人改过
        o = {"po": "44408A", "supplier": "凯维", "status": "已下单", "source": "tracker"}
        autoflags.annotate([o], self.data, CFG, baseline="2026-12-05")
        self.assertNotIn("flags", o["auto"])  # 总表是 12-05 的，那时已经知道
        self.assertEqual(autoflags.sheet_day({"base": "tracker", "sheet_file": "跟单总表20261111 1.xlsx"}), "2026-11-11")
        self.assertEqual(autoflags.sheet_day({"base": "mail"}), "")

    def test_nothing_configured(self):
        o = {"po": "44408", "supplier": "华晨", "status": "已下单"}
        info = autoflags.annotate([o], {}, autoflags.Config())
        self.assertNotIn("auto", o)
        self.assertEqual(info["sent"], 0)


class ServerAutoTest(unittest.TestCase):
    """/api/orders 带上 auto，读不了的文件不耽误列表。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.data.mkdir()
        (self.data / "orders.json").write_text(json.dumps({"orders": [
            {"po": "44408", "supplier": "华晨", "status": "已下单", "order_date": "2026-11-23"}]}), encoding="utf-8")
        (self.data / "mail_index.json").write_text(json.dumps(dict([
            mail(1, GENE, "a@hc.example.com", "PO 44408 Due December 4，2026")])), encoding="utf-8")
        ship = self.tmp / "shipdocs.json"
        ship.write_text(json.dumps({"orders": SHIPDOCS}), encoding="utf-8")
        (self.data / "auto.json").write_text(json.dumps({"shipdocs": str(ship), "vendor_mail": {"华晨": ["hc.example.com"]},
                                                         "us_domains": ["us.example.com"]}),
                                             encoding="utf-8")
        self.app = po_server.App(self.data, self.tmp / "nopw.json", [])

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_orders_have_auto(self):
        doc = self.app.orders()
        o = doc["orders"][0]
        self.assertEqual(o["auto"]["sent"]["vendor"], "华晨")
        self.assertEqual(o["auto"]["ships"][0]["awb"], ["111"])
        self.assertEqual(doc["meta"]["auto"]["sent"], 1)
        self.assertIn("shipdocs_at", doc["meta"]["auto"])
        self.assertEqual(o["status"], "已下单")

    def test_broken_files_do_not_break_list(self):
        (self.data / "mail_index.json").write_text("{坏", encoding="utf-8")
        (self.data / "auto.json").write_text("[]", encoding="utf-8")  # 格式不对：当没配
        doc = self.app.orders()
        self.assertEqual(len(doc["orders"]), 1)
        self.assertIn("mail_index.json 读不了", doc["meta"]["auto"]["error"])
        self.assertNotIn("auto", doc["orders"][0])
        self.assertNotIn("failed", doc["meta"]["auto"])  # 只是部分文件读不了：出货那边照样判断
        with unittest.mock.patch.object(autoflags, "annotate", side_effect=RuntimeError("x")):
            doc = self.app.orders()
        self.assertEqual(doc["meta"]["auto"], {"error": "自动判断出错：RuntimeError", "failed": True})
        self.assertNotIn("auto", doc["orders"][0])

    def test_cache_follows_file_changes(self):
        self.assertIn("sent", self.app.orders()["orders"][0]["auto"])
        p = self.data / "mail_index.json"
        p.write_text(json.dumps({}), encoding="utf-8")
        import os
        st = p.stat()
        os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 5_000_000_000))
        self.assertNotIn("sent", self.app.orders()["orders"][0].get("auto", {}))


if __name__ == "__main__":
    unittest.main()

"""开 Invoice（invoice.py、invoice_xlsx.py、po_server 的接口）的测试。数据都是假的。"""
import http.client
import io
import json
import shutil
import sys
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import invoice  # noqa: E402
import invoice_xlsx  # noqa: E402
import po_server  # noqa: E402
from edits import EditError  # noqa: E402
import test_server as ts  # noqa: E402  （不直接 import ServerTest，免得它在这里再跑一遍）

CF, HOST, PW = ts.CF, ts.HOST, ts.PW

CFG = invoice.load_config(Path("/nonexistent"))
ORDERS = {
    "90001|凯维": {"po": "90001", "supplier": "凯维"},
    "90002|华晨": {"po": "90002", "supplier": "华晨"},
    "90003|凯阔": {"po": "90003", "supplier": "凯阔", "sub_vendor": "ABC"},
    "90004|迈诺": {"po": "90004", "supplier": "迈诺"},
}


def row(key, amount, rate, with_amount=False, vendor="V", done="", tier=None):
    out = {"key": key, "amount": amount, "rate": rate, "with_amount": with_amount, "vendor": vendor, "done": done}
    return out if tier is None else {**out, "tier": tier}


class DefaultsTest(unittest.TestCase):
    def test_tiers(self):
        d = {k: invoice.vendor_defaults(CFG, o["supplier"], o.get("sub_vendor")) for k, o in ORDERS.items()}
        self.assertEqual(d["90001|凯维"], {"vendor": "Shenzhen Kaiwei", "tier": 3, "rate": 5, "with_amount": False})
        self.assertEqual(d["90002|华晨"], {"vendor": "Huachen", "tier": 2, "rate": 25, "with_amount": False})
        # Kaikuo = 我们付订单金额，Vendor 写下级（邮件里有就带上）
        self.assertEqual(d["90003|凯阔"], {"vendor": "ABC", "tier": 1, "rate": 40, "with_amount": True})
        self.assertEqual(invoice.vendor_defaults(CFG, "凯阔")["vendor"], "")
        self.assertEqual(d["90004|迈诺"], {"vendor": "迈诺", "tier": 1, "rate": 40, "with_amount": True})

    def test_config_file_overrides(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            (tmp / "invoice.json").write_text(json.dumps({"company": "示例公司", "tiers": {"2": {"rate": 20}},
                                                          "vendors": {"兴华": {"tier": 2}}, "junk": 1}), encoding="utf-8")
            cfg = invoice.load_config(tmp)
            self.assertEqual(cfg["company"], "示例公司")
            self.assertNotIn("junk", cfg)
            self.assertEqual(invoice.vendor_defaults(cfg, "华晨")["rate"], 20)
            self.assertEqual(invoice.vendor_defaults(cfg, "兴华"), {"vendor": "Xinghua", "tier": 2, "rate": 20, "with_amount": False})
            self.assertEqual(invoice.DEFAULT_CONFIG["tiers"]["2"]["rate"], 25)  # 默认值没被改
        finally:
            shutil.rmtree(tmp)

    def test_done_date(self):
        self.assertEqual(invoice.done_date({"shipped": ["2026-10-02"], "lines": [{"shipped": "2026-10-09"}]}), "2026-10-09")
        hist = [{"at": "2026-11-03T10:00:00+09:00", "changes": {"status": ["已下单", "已发货"]}}]
        self.assertEqual(invoice.done_date({"history": hist}), "2026-11-03")
        self.assertEqual(invoice.done_date({}), "")


class BuildTest(unittest.TestCase):
    def test_money(self):
        inv = invoice.build({"no": "261115K", "date": "2026-11-15", "contact": "张三", "usd_rate": "7.1", "rows": [
            row("90001|凯维", 27000, 5, vendor="Shenzhen Kaiwei", done="2026-10-12"),
            row("90002|华晨", 2769, 25, vendor="Huachen"),
            row("90003|凯阔", "1,000.5", 40, True, vendor="ABC"),
            row("90004|迈诺", 101, 2.5, False, vendor="ABC"),
        ]}, ORDERS, CFG)
        fees = [r["fee"] for r in inv["rows"]]
        self.assertEqual(fees, [1350, 692.25, 400.2, 2.53])  # 2.525 四舍五入成 2.53
        self.assertEqual([r["due"] for r in inv["rows"]], [1350, 692.25, 1400.7, 2.53])
        self.assertEqual([r["po"] for r in inv["rows"]], ["90001", "90002", "90003", "90004"])  # 号从服务器的数据拿
        self.assertEqual([r["tier"] for r in inv["rows"]], [3, 2, 1, 1])  # 没给就按供应商的默认等级
        hx = next(v for v in inv["vendors"] if v["vendor"] == "ABC")
        self.assertEqual((hx["count"], hx["amount"], hx["fee"], hx["due"], hx["rate"], hx["tier"]), (2, 1101.5, 402.73, 1403.23, None, 1))
        self.assertEqual((inv["fee_total"], inv["amount_billed"], inv["total"]), (2444.98, 1000.5, 3445.48))
        self.assertEqual(inv["usd"], 485.28)
        self.assertTrue(inv["with_amount"])

    def test_validation(self):
        good = {"no": "261115K", "date": "2026-11-15", "rows": [row("90001|凯维", 100, 5)]}
        cases = [
            ({"no": "26/11"}, "发票号"),
            ({"date": ""}, "发票日期"),
            ({"rows": []}, "还没选"),
            ({"rows": [row("nope|", 1, 1)]}, "找不到"),
            ({"rows": [row("90001|凯维", 1, 1)] * 2}, "选了两次"),
            ({"rows": [row("90001|凯维", None, 1)]}, "没填订单金额"),
            ({"rows": [row("90001|凯维", 1, 120)]}, "0 到 100"),
            ({"rows": [row("90001|凯维", 1, 1, vendor="")]}, "Vendor 没填"),
            ({"usd_rate": "abc"}, "汇率"),
            ({"rows": [row("90001|凯维", 1, 1, tier=7)]}, "Service Tier"),
        ]
        for patch, msg in cases:
            with self.assertRaises(EditError) as cm:
                invoice.build({**good, **patch}, ORDERS, CFG)
            self.assertIn(msg, str(cm.exception), patch)


class FillTiersTest(unittest.TestCase):
    def test_old_records_get_tier_from_rate(self):
        old = {"rows": [{"vendor": "A", "rate": 5}, {"vendor": "A", "rate": 5}, {"vendor": "B", "rate": 25},
                        {"vendor": "B", "rate": 40}, {"vendor": "C", "rate": 12, "tier": 2}],
               "vendors": [{"vendor": "A"}, {"vendor": "B"}, {"vendor": "C"}]}
        inv = invoice.fill_tiers(old, CFG)
        self.assertEqual([r["tier"] for r in inv["rows"]], [3, 3, 2, 1, 2])
        self.assertEqual([v["tier"] for v in inv["vendors"]], [3, None, 2])
        self.assertNotIn("tier", old["rows"][0])  # 不改原来的


class XlsxTest(unittest.TestCase):
    def test_render_opens_and_has_formulas(self):
        inv = invoice.build({"no": "261115K", "date": "2026-11-15", "contact": "张三", "rows": [
            row("90001|凯维", 27000, 5, vendor="Shenzhen Kaiwei", done="2026-10-12"),
            row("90003|凯阔", 1000, 40, True, vendor='H"X<&>'),
        ]}, ORDERS, CFG)
        data = invoice_xlsx.render(inv, {**CFG, "company": "示例公司", "phone": "+86 1", "bill_to": ["Attn: A", "B LLC"]})
        z = zipfile.ZipFile(io.BytesIO(data))
        sheet = z.read("xl/worksheets/sheet1.xml").decode()
        for s in ("示例公司", "10/12/26", "ROUND(E14*G14,2)", "H15+E15", "应收小计", "Service Tier", 'H"X&lt;&amp;&gt;', "11月15日", "Bill To:"):
            self.assertIn(s, sheet)
        self.assertIn('"¥"#,##0.00'.replace('"', "&quot;"), z.read("xl/styles.xml").decode())
        try:
            import openpyxl  # 有就顺便用它打开一次，没有就算了
        except ImportError:
            return
        ws = openpyxl.load_workbook(io.BytesIO(data)).active
        self.assertEqual(ws["A13"].value, "序号")
        self.assertEqual((ws["C14"].value, ws["E14"].value, ws["F14"].value, ws["G14"].value), ("90001", 27000, 3, 0.05))


class InvoiceApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"password": po_server.hash_password(PW)}), encoding="utf-8")
        self.data.mkdir()
        (self.data / "orders.json").write_text(json.dumps({"orders": [
            {"po": "90001", "supplier": "凯维", "status": "已完成", "amount": 27000, "shipped": ["2026-10-12"]},
            {"po": "90002", "supplier": "华晨", "status": "已发货", "amount": 2769},
        ]}), encoding="utf-8")
        self.app = po_server.App(self.data, self.cfg, [HOST])
        self.srv = po_server.make_server(self.app, 0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp)

    def post(self, obj, headers=None):
        h = {"Host": "localhost", **(headers or {}), "Content-Type": "application/json"}
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/api/invoice/save", body=json.dumps(obj).encode(), headers=h)
        r = c.getresponse()
        doc = json.loads(r.read() or b"{}")
        c.close()
        return r, doc

    def payload(self, no="261115K", keys=("90001|凯维", "90002|华晨")):
        return {"by": "小王", "invoice": {"no": no, "date": "2026-11-15", "contact": "张三", "rows": [
            {"key": k, "vendor": "V" + k[:5], "amount": 1000, "rate": 5, "with_amount": False, "done": ""} for k in keys]}}

    def get(self, headers=None):
        r, body = ts.ServerTest.req(self, "GET", "/api/orders", headers or {"Host": "localhost"})
        doc = json.loads(body)
        return doc["meta"], {o["key"]: o for o in doc["orders"]}

    def test_save_marks_and_download(self):
        meta, orders = self.get()
        self.assertEqual(meta["invoice"]["list"], [])
        self.assertEqual(orders["90001|凯维"]["inv"], {"vendor": "Shenzhen Kaiwei", "tier": 3, "rate": 5, "with_amount": False,
                                                      "done": "2026-10-12"})
        r, doc = self.post(self.payload())
        self.assertEqual(r.status, 200, doc)
        self.assertEqual((doc["invoice"]["total"], doc["invoice"]["saved_by"]), (100, "小王"))
        meta, orders = self.get()
        self.assertEqual([x["no"] for x in meta["invoice"]["list"]], ["261115K"])
        self.assertEqual(orders["90002|华晨"]["invoiced"], [{"no": "261115K", "date": "2026-11-15"}])
        self.assertEqual(orders["90002|华晨"]["history"][0]["action"], "invoice")
        # 同号再存 = 改这张；去掉的 PO 不再标已开票，留下的不重复记跟进
        r, doc = self.post(self.payload(keys=("90001|凯维",)))
        self.assertEqual(r.status, 200, doc)
        meta, orders = self.get()
        self.assertNotIn("invoiced", orders["90002|华晨"])
        self.assertEqual(len(orders["90001|凯维"]["history"]), 1)
        r, body = ts.ServerTest.req(self, "GET", "/api/invoice/xlsx?no=261115K", {"Host": "localhost"})
        self.assertEqual(r.status, 200)
        self.assertIn("Invoice_261115K.xlsx", r.getheader("Content-Disposition"))
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(body)))
        r, _ = ts.ServerTest.req(self, "GET", "/api/invoice/xlsx?no=nope", {"Host": "localhost"})
        self.assertEqual(r.status, 404)

    def test_bad_input_and_viewers(self):
        bad = self.payload()
        bad["invoice"]["rows"][0]["rate"] = "x"
        r, doc = self.post(bad)
        self.assertEqual(r.status, 400)
        self.assertIn("服务费", doc["error"])
        self.assertFalse((self.data / "invoices.json").exists())
        # 只有查看密码的人（经 Cloudflare 登录、没输编辑密码）：看不到 invoice 信息，也不能存、不能下载
        r, _ = ts.ServerTest.req(self, "POST", "/login", CF, urlencode({"password": PW}))
        view = {**CF, "Cookie": ts.ServerTest.cookie_from(self, r)}
        meta, orders = self.get(view)
        self.assertNotIn("invoice", meta)
        self.assertNotIn("inv", orders["90001|凯维"])
        r, doc = self.post(self.payload(), {**view, "Origin": f"https://{HOST}"})
        self.assertEqual(r.status, 403)
        r, _ = ts.ServerTest.req(self, "GET", "/api/invoice/xlsx?no=261115K", view)
        self.assertEqual(r.status, 403)


if __name__ == "__main__":
    unittest.main()

"""做采购订单（purchase.py、purchase_xlsx.py、po_server 的接口）的测试。数据都是假的。"""
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
from urllib.parse import quote, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import po_server  # noqa: E402
import purchase  # noqa: E402
import purchase_xlsx  # noqa: E402
from edits import EditError  # noqa: E402
import test_server as ts  # noqa: E402

CF, HOST, PW = ts.CF, ts.HOST, ts.PW
CFG = {**purchase.load_config(Path("/nonexistent")),
       "buyer": {"name": "测试买方公司", "lines": ["地址：某路 1 号", "电话：000"]},
       "ship_to": {"name": "测试买方公司", "lines": ["地址：某路 1 号"]}}
ORDER = {"po": "90010", "supplier": "凯阔", "sub_vendor": "甲厂", "due_date": "2026-12-01", "customer_po": "", "amount": 678,
         "lines": [{"pn": "P-1", "rev": "A", "desc": "PART ONE", "qty": 2, "unit_price": 226, "customer_line": "10"},
                   {"pn": "P-2", "qty": 1, "amount": 226}]}
VENDORS = [{"name": "某某甲厂精密有限公司", "lines": ["地址：甲路 2 号", "税号：TEST123"], "names": []}]


class UpperTest(unittest.TestCase):
    def test_amount_in_words(self):
        cases = {2400: "人民币贰仟肆佰元整", 2712: "人民币贰仟柒佰壹拾贰元整", 18260.8: "人民币壹万捌仟贰佰陆拾元捌角",
                 10010: "人民币壹万零壹拾元整", 100.05: "人民币壹佰元零伍分", 0: "人民币零元整", 0.5: "人民币伍角",
                 100000001: "人民币壹亿零壹元整", 1000100: "人民币壹佰万零壹佰元整", 1010.1: "人民币壹仟零壹拾元壹角"}
        for x, want in cases.items():
            self.assertEqual(purchase.rmb_upper(x), want, x)


class DraftTest(unittest.TestCase):
    def test_draft_from_order(self):
        d = purchase.draft(ORDER, CFG, VENDORS, "2026-11-16")
        self.assertEqual((d["key"], d["no"], d["date"], d["due"], d["customer_po"]),
                         ("90010|凯阔", "PO-90010", "2026-11-16", "2026-12-01", "待定 (TBD)"))
        self.assertEqual(d["seller"]["name"], "某某甲厂精密有限公司")  # 简称是全称的一部分 → 带出存过的供方
        self.assertEqual(d["seller_short"], "甲厂")
        # 含税单价 ÷ 1.13：226 → 200；没有单价的用金额 ÷ 数量
        self.assertEqual([(ln["line"], ln["pn"], ln["qty"], ln["price"]) for ln in d["lines"]],
                         [("10", "P-1", "2", "200"), ("", "P-2", "1", "200")])
        self.assertIn("PO-90010", " ".join(d["terms"]))

    def test_seller_short(self):
        self.assertEqual(purchase.seller_short({"supplier": "凯阔"}), "")
        self.assertEqual(purchase.seller_short({"supplier": "兴华"}), "兴华")
        self.assertIsNone(purchase.find_vendor(VENDORS, ""))
        self.assertIsNone(purchase.find_vendor(VENDORS, "乙"))


def payload(**kw):
    p = {"key": "90010|凯阔", "no": "PO-90010", "date": "2026-11-16", "due": "2026-12-01", "customer_po": "待定 (TBD)",
         "seller": {"name": "某某甲厂精密有限公司", "lines": ["地址：甲路 2 号", ""]}, "ship_to": CFG["ship_to"], "tax_rate": "13",
         "lines": [{"line": "10", "pn": "P-1", "rev": "A", "desc": "PART ONE", "qty": "3", "price": "500"},
                   {"pn": "P-2", "qty": "3", "price": "200"}, {"pn": "P-3", "qty": "3", "price": "100"}],
         "terms": ["包装要求：防潮。", ""]}
    p.update(kw)
    return p


class BuildTest(unittest.TestCase):
    def test_amounts(self):
        doc = purchase.build(payload(), {"90010|凯阔": ORDER}, CFG)
        self.assertEqual((doc["total"], doc["taxed"], doc["qty_total"]), (2400, 2712, 9))
        self.assertEqual((doc["total_upper"], doc["taxed_upper"]), ("人民币贰仟肆佰元整", "人民币贰仟柒佰壹拾贰元整"))
        self.assertEqual([ln["amount"] for ln in doc["lines"]], [1500, 600, 300])
        self.assertEqual(doc["seller"]["lines"], ["地址：甲路 2 号"])
        self.assertEqual(doc["terms"], ["包装要求：防潮。"])

    def test_bad_input(self):
        orders = {"90010|凯阔": ORDER}
        for kw, msg in ((dict(key="nope|x"), "找不到"), (dict(no="PO 1"), "订单编号"), (dict(date=""), "订单日期"),
                        (dict(seller={"name": ""}), "供方"), (dict(lines=[]), "至少"), (dict(tax_rate="x"), "税率"),
                        (dict(lines=[{"pn": "P", "qty": "0", "price": "1"}]), "数量"),
                        (dict(lines=[{"pn": "P", "qty": "1", "price": ""}]), "单价"),
                        (dict(lines=[{"pn": "", "desc": "", "qty": "1", "price": "1"}]), "物料编码")):
            with self.assertRaises(EditError) as cm:
                purchase.build(payload(**kw), orders, CFG)
            self.assertIn(msg, str(cm.exception), kw)


class XlsxTest(unittest.TestCase):
    def test_render(self):
        doc = purchase.build(payload(), {"90010|凯阔": ORDER}, CFG)
        data = purchase_xlsx.render(doc, CFG)
        z = zipfile.ZipFile(io.BytesIO(data))
        sheet = z.read("xl/worksheets/sheet1.xml").decode()
        self.assertIn("采 购 订 单", sheet)
        self.assertIn("ROUND(I", sheet)
        self.assertIn("人民币贰仟柒佰壹拾贰元整", sheet)  # 大写公式带着算好的值
        self.assertIn("[DBNum2]", sheet)
        self.assertIn("<b/>", sheet)  # 供方名称粗体
        self.assertIn('name="PO-90010"', z.read("xl/workbook.xml").decode())
        self.assertIn("等线", z.read("xl/styles.xml").decode())


class PurchaseApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"password": po_server.hash_password(PW)}), encoding="utf-8")
        self.data.mkdir()
        (self.data / "orders.json").write_text(json.dumps({"orders": [ORDER]}, ensure_ascii=False), encoding="utf-8")
        (self.data / "purchase.json").write_text(json.dumps({"buyer": CFG["buyer"], "ship_to": CFG["ship_to"]}, ensure_ascii=False),
                                                 encoding="utf-8")
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
        c.request("POST", "/api/purchase/save", body=json.dumps(obj).encode(), headers=h)
        r = c.getresponse()
        doc = json.loads(r.read() or b"{}")
        c.close()
        return r, doc

    def get_json(self, path, headers=None):
        r, body = ts.ServerTest.req(self, "GET", path, headers or {"Host": "localhost"})
        return r, json.loads(body or b"{}")

    def test_draft_save_download(self):
        key = quote("90010|凯阔")
        r, d = self.get_json(f"/api/purchase/draft?key={key}")
        self.assertEqual(r.status, 200, d)
        self.assertFalse(d["saved"])
        self.assertEqual(d["doc"]["seller"]["name"], "")  # 还没记过这家
        r, doc = self.post({"by": "小王", "purchase": payload()})
        self.assertEqual(r.status, 200, doc)
        self.assertEqual((doc["purchase"]["taxed"], doc["purchase"]["saved_by"], doc["purchase"]["seller_short"]), (2712, "小王", "甲厂"))
        # 记下了供方；再打开就是存过的这张，带着含税单价对照
        r, d = self.get_json(f"/api/purchase/draft?key={key}")
        self.assertTrue(d["saved"])
        self.assertEqual(d["doc"]["lines"][0]["price_incl"], 226)
        vend = json.loads((self.data / "purchase_vendors.json").read_text(encoding="utf-8"))["vendors"]
        self.assertEqual(vend, [{"name": "某某甲厂精密有限公司", "names": ["甲厂"], "lines": ["地址：甲路 2 号"]}])
        r, orders_doc = self.get_json("/api/orders")
        o = orders_doc["orders"][0]
        self.assertEqual(o["purchased"], [{"no": "PO-90010", "date": "2026-11-16"}])
        self.assertEqual(o["history"][0]["action"], "purchase")
        self.assertEqual(orders_doc["meta"]["purchase"]["vendors"][0]["name"], "某某甲厂精密有限公司")
        # 同号再存不重复记跟进
        r, doc = self.post({"by": "小王", "purchase": payload(date="2026-11-17")})
        self.assertEqual(r.status, 200, doc)
        r, orders_doc = self.get_json("/api/orders")
        self.assertEqual(len(orders_doc["orders"][0]["history"]), 1)
        r, body = ts.ServerTest.req(self, "GET", "/api/purchase/xlsx?no=PO-90010", {"Host": "localhost"})
        self.assertEqual(r.status, 200)
        self.assertIn("filename*=UTF-8''", r.getheader("Content-Disposition"))
        self.assertIn(quote("采购订单-PO-90010-甲厂.xlsx"), r.getheader("Content-Disposition"))
        self.assertTrue(zipfile.is_zipfile(io.BytesIO(body)))
        r, _ = ts.ServerTest.req(self, "GET", "/api/purchase/xlsx?no=nope", {"Host": "localhost"})
        self.assertEqual(r.status, 404)

    def test_font_only_from_data_dir(self):
        r, _ = ts.ServerTest.req(self, "GET", "/fonts/Deng.ttf", {"Host": "localhost"})
        self.assertEqual(r.status, 404)
        (self.data / "fonts").mkdir()
        (self.data / "fonts" / "Deng.ttf").write_bytes(b"fake-font")
        r, body = ts.ServerTest.req(self, "GET", "/fonts/Deng.ttf", {"Host": "localhost"})
        self.assertEqual((r.status, body, r.getheader("Content-Type")), (200, b"fake-font", "font/ttf"))
        self.assertIn("max-age", r.getheader("Cache-Control"))
        r, _ = ts.ServerTest.req(self, "GET", "/fonts/../orders.json", {"Host": "localhost"})
        self.assertEqual(r.status, 404)
        r, _ = ts.ServerTest.req(self, "GET", "/fonts/Deng.ttf", CF)  # 经 Cloudflare 没登录的不给
        self.assertNotEqual(r.status, 200)

    def test_viewers_cannot(self):
        r, _ = ts.ServerTest.req(self, "POST", "/login", CF, urlencode({"password": PW}))
        view = {**CF, "Cookie": ts.ServerTest.cookie_from(self, r)}
        r, doc = self.get_json("/api/orders", view)
        self.assertNotIn("purchase", doc["meta"])
        r, _ = self.get_json(f"/api/purchase/draft?key={quote('90010|凯阔')}", view)
        self.assertEqual(r.status, 403)
        r, _ = self.post({"by": "x", "purchase": payload()}, {**view, "Origin": f"https://{HOST}"})
        self.assertEqual(r.status, 403)
        self.assertFalse((self.data / "purchases.json").exists())


if __name__ == "__main__":
    unittest.main()

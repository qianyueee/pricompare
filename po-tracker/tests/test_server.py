"""po_server.py 的测试：python3 -m unittest discover -s tests（在 po-tracker/ 里跑）。"""
import http.client
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import po_server  # noqa: E402

PW = "测试 password-123"
HOST = "po.kvstek.com"
CF = {"Host": HOST, "Cf-Ray": "8abc-NRT", "Cf-Connecting-Ip": "203.0.113.9", "X-Forwarded-Proto": "https"}


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.data = cls.tmp / "data"
        cls.cfg = cls.tmp / "config.json"
        cls.cfg.write_text(json.dumps({"password": po_server.hash_password(PW), "editors": ["x"]}), encoding="utf-8")
        cls.data.mkdir()
        (cls.data / "orders.json").write_text(json.dumps({
            "version": 1, "generated_at": "2026-11-12T13:00:00+09:00",
            "orders": [{"po": "90001", "status": "已下单"}, {"po": "90002", "status": "已确认"}, {"po": "90003"},
                       {"po": "90004", "supplier": "华晨", "status": "已下单"}, {"po": "90004", "supplier": "兴华", "status": "已下单"}],
        }), encoding="utf-8")
        (cls.data / "overrides.json").write_text(json.dumps({
            "_说明": "以下划线开头的键忽略",
            "90001": {"status": "已完成", "status_note": "手工"},
            "90003": {"hidden": True},
            "90004|兴华": {"status": "已发货"},
        }), encoding="utf-8")
        cls.app = po_server.App(cls.data, cls.cfg, [HOST])
        cls.srv = po_server.make_server(cls.app, 0)
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        shutil.rmtree(cls.tmp)

    def setUp(self):
        self.app.fails.clear()

    def req(self, method, path, headers=None, body=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": "localhost"} if headers is None else dict(headers)
        if body is not None:
            h["Content-Type"] = "application/x-www-form-urlencoded"
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r, data

    def login(self, pw=PW, headers=CF):
        return self.req("POST", "/login", headers, urlencode({"password": pw}))

    def cookie_from(self, r):
        sc = r.getheader("Set-Cookie") or ""
        return sc.split(";", 1)[0]

    # ---- 本机
    def test_local_needs_no_password(self):
        r, body = self.req("GET", "/")
        self.assertEqual(r.status, 200)
        self.assertIn(b"PO", body)
        r, body = self.req("GET", "/api/orders")
        self.assertEqual(r.status, 200)
        doc = json.loads(body)
        self.assertFalse(doc["meta"]["can_logout"])

    def test_health(self):
        r, body = self.req("GET", "/healthz", {"Host": "anything"})
        self.assertEqual((r.status, body), (200, b"ok"))

    # ---- 经 Cloudflare
    def test_public_requires_login(self):
        r, _ = self.req("GET", "/", CF)
        self.assertEqual(r.status, 303)
        self.assertEqual(r.getheader("Location"), "/login")
        r, _ = self.req("GET", "/api/orders", CF)
        self.assertEqual(r.status, 401)
        r, _ = self.req("GET", "/static/app.js", CF)
        self.assertEqual(r.status, 303)
        r, body = self.req("GET", "/login", CF)
        self.assertEqual(r.status, 200)
        self.assertIn("和报价页同一个密码".encode(), body)

    def test_localhost_host_with_cf_header_still_public(self):
        r, _ = self.req("GET", "/api/orders", {"Host": "localhost", "Cf-Ray": "x"})
        self.assertEqual(r.status, 421)  # 带 cf 头就当公网；localhost 不在允许的域名里

    def test_unknown_host_refused(self):
        r, _ = self.req("GET", "/", {**CF, "Host": "evil.example.com"})
        self.assertEqual(r.status, 421)
        r, _ = self.req("GET", "/", {"Host": "quote.kvstek.com"})
        self.assertEqual(r.status, 421)

    def test_http_redirects_to_https(self):
        r, _ = self.req("GET", "/login?x=1", {**CF, "X-Forwarded-Proto": "http"})
        self.assertEqual(r.status, 308)
        self.assertEqual(r.getheader("Location"), "https://po.kvstek.com/login?x=1")

    def test_wrong_then_right_password(self):
        r, body = self.login("nope")
        self.assertEqual(r.status, 401)
        self.assertIn("密码不对".encode(), body)
        self.assertIsNone(r.getheader("Set-Cookie"))
        r, _ = self.login()
        self.assertEqual(r.status, 303)
        sc = r.getheader("Set-Cookie")
        for part in ("po_auth=", "HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000"):
            self.assertIn(part, sc)
        cookie = self.cookie_from(r)
        r, body = self.req("GET", "/api/orders", {**CF, "Cookie": cookie})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Cache-Control"), "private, no-store")
        doc = json.loads(body)
        self.assertTrue(doc["meta"]["can_logout"])
        pos = {o["po"]: o for o in doc["orders"]}
        self.assertEqual(sorted(pos), ["90001", "90002", "90004"])  # 90003 被 hidden
        by_sup = {o.get("supplier"): o["status"] for o in doc["orders"] if o["po"] == "90004"}
        self.assertEqual(by_sup, {"华晨": "已下单", "兴华": "已发货"})  # 「PO|供应商」只改那一条
        self.assertEqual(pos["90001"]["status"], "已完成")
        self.assertEqual(pos["90001"]["overridden"], ["status", "status_note"])
        r, _ = self.req("GET", "/", {**CF, "Cookie": cookie})
        self.assertEqual(r.status, 200)
        r, _ = self.req("GET", "/static/app.css", {**CF, "Cookie": cookie})
        self.assertEqual(r.status, 200)
        self.assertEqual(r.getheader("Content-Type"), "text/css; charset=utf-8")
        r, _ = self.req("GET", "/login", {**CF, "Cookie": cookie})
        self.assertEqual(r.status, 303)  # 已登录就回首页

    def test_forged_and_expired_cookies(self):
        stored = self.app.password_hash()
        for bad in ("", "123.abc", f"{int(time.time()*1000)+10**7}.{'A'*43}",
                    po_server.make_session(b"k" * 32, stored),
                    po_server.make_session(self.app.key, stored, now=time.time() - 31 * 24 * 3600)):
            r, _ = self.req("GET", "/api/orders", {**CF, "Cookie": f"po_auth={bad}"})
            self.assertEqual(r.status, 401, bad)

    def test_password_change_logs_everyone_out(self):
        r, _ = self.login()
        cookie = self.cookie_from(r)
        old = self.cfg.read_text(encoding="utf-8")
        try:
            self.cfg.write_text(json.dumps({"password": po_server.hash_password("new one")}), encoding="utf-8")
            r, _ = self.req("GET", "/api/orders", {**CF, "Cookie": cookie})
            self.assertEqual(r.status, 401)
            r, _ = self.login()
            self.assertEqual(r.status, 401)
            r, _ = self.login("new one")
            self.assertEqual(r.status, 303)
        finally:
            self.cfg.write_text(old, encoding="utf-8")

    def test_rate_limit(self):
        for _ in range(po_server.FAIL_LIMIT):
            r, _ = self.login("bad")
            self.assertEqual(r.status, 401)
        r, body = self.login()  # 连对的密码也先拦下
        self.assertEqual(r.status, 429)
        self.assertIn("10 分钟".encode(), body)

    def test_logout_clears_cookie(self):
        r, _ = self.req("GET", "/logout", CF)
        self.assertEqual(r.status, 303)
        self.assertIn("Max-Age=0", r.getheader("Set-Cookie"))

    def test_static_traversal(self):
        for p in ("/static/../po_server.py", "/static/%2e%2e/po_server.py", "/static/nope.js", "/po_server.py"):
            r, _ = self.req("GET", p)
            self.assertEqual(r.status, 404, p)

    def test_security_headers(self):
        r, _ = self.req("GET", "/login", CF)
        self.assertIn("frame-ancestors 'none'", r.getheader("Content-Security-Policy"))
        self.assertEqual(r.getheader("X-Robots-Tag"), "noindex, nofollow")
        r, body = self.req("GET", "/robots.txt", CF)
        self.assertIn(b"Disallow: /", body)

    def test_access_log(self):
        self.login("bad")
        self.login()
        logs = list((self.data / "access").glob("*.jsonl"))
        self.assertTrue(logs)
        events = [json.loads(x)["event"] for x in logs[0].read_text(encoding="utf-8").splitlines()]
        self.assertIn("login_fail", events)
        self.assertIn("login_ok", events)
        rec = json.loads(logs[0].read_text(encoding="utf-8").splitlines()[-1])
        self.assertEqual(rec["ip"], "203.0.113.9")

    def test_missing_orders_file(self):
        app = po_server.App(self.tmp / "empty", self.cfg, [HOST])
        doc = app.orders()
        self.assertEqual(doc, {"meta": {"missing": True}, "orders": []})


class EditTest(unittest.TestCase):
    """在网页上改状态：本机直接能改；经 Cloudflare 要先登录、再输编辑密码。"""

    EPW = "编辑 pass-456"
    LOCAL = {"Host": "localhost"}

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"password": po_server.hash_password(PW)}), encoding="utf-8")
        self.data.mkdir()
        (self.data / "orders.json").write_text(json.dumps({"orders": [
            {"po": "90001", "supplier": "华晨", "status": "已下单", "due_date": "2026-11-20"},
            {"po": "90002", "supplier": "凯维", "status": "已确认"},
        ]}), encoding="utf-8")
        (self.data / "overrides.json").write_text(json.dumps({"90002": {"status": "已发货"}}), encoding="utf-8")
        self.app = po_server.App(self.data, self.cfg, [HOST])
        self.srv = po_server.make_server(self.app, 0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        r, _ = ServerTest.req(self, "POST", "/login", CF, urlencode({"password": PW}))
        self.view = ServerTest.cookie_from(self, r)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp)

    def post(self, path, obj, headers=None, raw=None, ctype="application/json"):
        h = dict(self.LOCAL if headers is None else headers)
        h["Content-Type"] = ctype
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", path, body=raw if raw is not None else json.dumps(obj).encode(), headers=h)
        r = c.getresponse()
        doc = json.loads(r.read() or b"{}")
        c.close()
        return r, doc

    def get(self, headers=None):
        r, body = ServerTest.req(self, "GET", "/api/orders", dict(self.LOCAL if headers is None else headers))
        self.assertEqual(r.status, 200)
        doc = json.loads(body)
        return doc["meta"], {o["key"]: o for o in doc["orders"]}

    def update(self, key="90001|华晨", by="小王", changes=None, note="", headers=None):
        return self.post("/api/order/update", {"key": key, "by": by, "changes": changes or {}, "note": note}, headers)

    def test_local_edit_and_history(self):
        meta, orders = self.get()
        self.assertTrue(meta["can_edit"])
        self.assertFalse(meta["edit_ready"])  # 没设编辑密码，本机照样能改
        r, doc = self.update(changes={"status": "已确认", "due_date": "2026-11-25", "eta": "11/22"}, note="供应商回复 11/22 发")
        self.assertEqual(r.status, 200, doc)
        self.assertEqual(doc["record"]["changes"], {"status": ["已下单", "已确认"], "due_date": ["2026-11-20", "2026-11-25"],
                                                    "eta": ["", "11/22"]})
        r, doc = self.update(by="小李", changes={"status": "已确认", "tracking": "1234567890"})
        self.assertEqual(doc["record"]["changes"], {"tracking": ["", "1234567890"]})  # 没变的不记
        meta, orders = self.get()
        o = orders["90001|华晨"]
        self.assertEqual((o["status"], o["due_date"], o["eta"], o["tracking"]), ("已确认", "2026-11-25", "11/22", "1234567890"))
        self.assertEqual((o["note"], o["note_by"], o["updated_by"]), ("供应商回复 11/22 发", "小王", "小李"))
        self.assertEqual(o["edited"], ["due_date", "eta", "note", "status", "tracking"])
        self.assertEqual([h["by"] for h in o["history"]], ["小李", "小王"])  # 新的在前
        self.assertEqual(meta["last_edit"]["by"], "小李")
        self.assertEqual(orders["90002|凯维"]["history"], [])
        lines = (self.data / "history.jsonl").read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 2)

    def test_web_edit_beats_overrides(self):
        _, orders = self.get()
        self.assertEqual(orders["90002|凯维"]["status"], "已发货")
        self.update(key="90002|凯维", changes={"status": "已完成"})
        _, orders = self.get()
        self.assertEqual(orders["90002|凯维"]["status"], "已完成")

    def test_validation(self):
        cases = [
            ({"changes": {"status": "飞了"}}, 400, "状态只能是"),
            ({"changes": {"due_date": "2026-13-01"}}, 400, "不是有效日期"),
            ({"changes": {"amount": 1}}, 400, "不能改这些字段"),
            ({"changes": {"status": "已下单"}}, 400, "没有改动"),
            ({"by": "", "note": "x"}, 400, "名字"),
            ({"note": "x" * 501}, 400, "太长"),
            ({"key": "nope|", "note": "x"}, 404, "找不到"),
        ]
        for kw, status, msg in cases:
            r, doc = self.update(**kw)
            self.assertEqual(r.status, status, kw)
            self.assertIn(msg, doc["error"], kw)
        self.assertFalse((self.data / "history.jsonl").exists())

    def test_add_and_delete(self):
        new = {"po": "90150", "supplier": "兴华", "due_date": "2026-12-01", "amount": "1,200", "status": "已下单",
               "lines": [{"pn": "0123-001", "qty": 4}, {"pn": " "}], "note": "电话下的单"}
        r, doc = self.post("/api/order/add", {"by": "小王", "order": new})
        self.assertEqual(r.status, 200, doc)
        r, doc = self.post("/api/order/add", {"by": "小王", "order": new})
        self.assertEqual(r.status, 409)
        r, doc = self.post("/api/order/add", {"by": "小王", "order": {**new, "po": ""}})
        self.assertEqual(r.status, 400)
        _, orders = self.get()
        o = orders["90150|兴华"]
        self.assertEqual((o["source"], o["amount"], o["lines"], o["note"]), ("manual", 1200, [{"pn": "0123-001", "qty": 4}], "电话下的单"))
        self.assertEqual(o["history"][0]["action"], "add")
        r, doc = self.post("/api/order/delete", {"key": "90001|华晨", "by": "小王"})
        self.assertEqual(r.status, 403)  # 邮件里来的不能删
        r, doc = self.post("/api/order/delete", {"key": "90150|兴华", "by": "小王"})
        self.assertEqual(r.status, 200, doc)
        _, orders = self.get()
        self.assertNotIn("90150|兴华", orders)

    def test_public_needs_edit_password(self):
        pub = {**CF, "Cookie": self.view, "Origin": "https://po.kvstek.com"}
        meta, _ = self.get(pub)
        self.assertFalse(meta["can_edit"])
        r, doc = self.update(note="x", headers=pub)
        self.assertEqual(r.status, 403)
        r, doc = self.post("/api/edit-login", {"password": self.EPW}, pub)
        self.assertEqual(r.status, 503)
        self.app.set_edit_password(self.EPW)
        self.assertEqual((self.data / "config.json").stat().st_mode & 0o777, 0o600)
        r, doc = self.post("/api/edit-login", {"password": PW}, pub)  # 查看密码不能拿来改
        self.assertEqual((r.status, doc["error"]), (403, "编辑密码不对"))
        r, doc = self.post("/api/edit-login", {"password": self.EPW}, {**CF, "Origin": "https://po.kvstek.com"})
        self.assertEqual(r.status, 401)  # 没登录查看也不行
        r, doc = self.post("/api/edit-login", {"password": self.EPW}, pub)
        self.assertEqual(r.status, 200, doc)
        sc = r.getheader("Set-Cookie")
        self.assertIn("po_edit=", sc)
        self.assertIn("HttpOnly", sc)
        edit = sc.split(";", 1)[0]
        both = {**pub, "Cookie": f"{self.view}; {edit}"}
        meta, _ = self.get(both)
        self.assertTrue(meta["can_edit"])
        r, doc = self.update(note="催了", headers=both)
        self.assertEqual(r.status, 200, doc)
        r, doc = self.update(note="催了", headers={**both, "Cookie": edit})  # 只有编辑 cookie 不够
        self.assertEqual(r.status, 401)
        self.app.set_edit_password("another one")  # 换编辑密码后旧的编辑 cookie 作废
        r, doc = self.update(note="再催", headers=both)
        self.assertEqual(r.status, 403)
        events = [json.loads(x)["event"] for f in (self.data / "access").glob("*.jsonl")
                  for x in f.read_text(encoding="utf-8").splitlines()]
        for e in ("edit_login_fail", "edit_login_ok", "edit_update"):
            self.assertIn(e, events)

    def test_cross_site_and_wrong_type_refused(self):
        r, doc = self.update(note="x", headers={"Host": "localhost", "Origin": "https://evil.example.com"})
        self.assertEqual(r.status, 403)
        r, doc = self.post("/api/order/update", None, raw=b"key=1", ctype="application/x-www-form-urlencoded")
        self.assertEqual(r.status, 415)
        r, doc = self.post("/api/order/update", None, raw=b"[1]")
        self.assertEqual(r.status, 400)

    def test_edit_login_counts_toward_lockout(self):
        self.app.set_edit_password(self.EPW)
        pub = {**CF, "Cookie": self.view}
        for _ in range(po_server.FAIL_LIMIT):
            self.assertEqual(self.post("/api/edit-login", {"password": "bad"}, pub)[0].status, 403)
        self.assertEqual(self.post("/api/edit-login", {"password": self.EPW}, pub)[0].status, 429)

    def test_logout_clears_both_cookies(self):
        r, _ = ServerTest.req(self, "GET", "/logout", CF)
        cookies = r.headers.get_all("Set-Cookie")
        self.assertEqual(sorted(c.split("=", 1)[0] for c in cookies), ["po_auth", "po_edit"])

    def test_corrupt_edits_file_is_left_alone(self):
        (self.data / "edits.json").write_text("{oops", encoding="utf-8")
        meta, orders = self.get()
        self.assertIn("edits.json 读不了", meta["edit_error"])
        self.assertEqual(len(orders), 2)
        r, doc = self.update(note="x")
        self.assertEqual(r.status, 500)
        self.assertEqual((self.data / "edits.json").read_text(encoding="utf-8"), "{oops")

    def test_cli_sets_hash_only(self):
        answers = iter([self.EPW, self.EPW])
        with mock.patch.object(po_server.getpass, "getpass", lambda prompt="": next(answers)), \
                mock.patch("builtins.print"):
            po_server.main(["set-edit-password", "--data", str(self.data)])
        cfg = json.loads((self.data / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn(self.EPW, json.dumps(cfg, ensure_ascii=False))
        self.assertTrue(po_server.verify_password(self.EPW, cfg["edit_password"]))
        answers = iter(["short"])
        with mock.patch.object(po_server.getpass, "getpass", lambda prompt="": next(answers)):
            with self.assertRaises(SystemExit):
                po_server.main(["set-edit-password", "--data", str(self.data)])


class NodeCompatTest(unittest.TestCase):
    """pricompare 用 Node 的 crypto.scrypt 生成哈希；确认 Python 这边认得。"""

    @unittest.skipUnless(shutil.which("node"), "没有 node")
    def test_node_hash_verifies(self):
        js = (
            "const c=require('crypto');const s=c.randomBytes(16);"
            "const h=c.scryptSync(process.argv[1].normalize('NFC'),s,32);"
            "console.log(`scrypt$${s.toString('base64')}$${h.toString('base64')}`)"
        )
        stored = subprocess.run(["node", "-e", js, PW], capture_output=True, text=True, check=True).stdout.strip()
        self.assertTrue(po_server.verify_password(PW, stored))
        self.assertFalse(po_server.verify_password(PW + "x", stored))
        self.assertFalse(po_server.verify_password(PW, "plain"))


if __name__ == "__main__":
    unittest.main()

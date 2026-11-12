"""po_server.py 的测试：python3 -m unittest discover -s tests（在 po-tracker/ 里跑）。"""
import base64
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
from urllib.parse import quote, urlencode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import po_server  # noqa: E402
from xlsxmaker import sample_tracker  # noqa: E402

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


class UploadTest(unittest.TestCase):
    """上传跟单总表：登录之外还要上传密码；上传后页面改用总表。"""

    UPW = "上传 pass-456"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        self.cfg = self.tmp / "config.json"
        self.cfg.write_text(json.dumps({"password": po_server.hash_password(PW)}), encoding="utf-8")
        self.data.mkdir()
        (self.data / "orders.json").write_text(json.dumps({"orders": [{"po": "1", "status": "已下单"}]}), encoding="utf-8")
        (self.data / "overrides.json").write_text(json.dumps({"90101|华晨": {"hidden": True}, "90102": {"note": "x"}}),
                                                  encoding="utf-8")
        self.app = po_server.App(self.data, self.cfg, [HOST])
        self.srv = po_server.make_server(self.app, 0)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        r, _ = ServerTest.req(self, "POST", "/login", CF, urlencode({"password": PW}))
        self.cookie = ServerTest.cookie_from(self, r)

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        shutil.rmtree(self.tmp)

    def post(self, body, key=None, headers=None, filename="跟单总表 1112.xlsx"):
        h = {**CF, "Cookie": self.cookie, "Content-Type": "application/octet-stream",
             "X-Filename": quote(filename)} if headers is None else dict(headers)
        if key is not None:
            h["X-Upload-Key"] = base64.b64encode(key.encode()).decode()
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("POST", "/api/upload", body=body, headers=h)
        r = c.getresponse()
        doc = json.loads(r.read() or b"{}")
        c.close()
        return r.status, doc

    def get_orders(self):
        r, body = ServerTest.req(self, "GET", "/api/orders", {**CF, "Cookie": self.cookie})
        self.assertEqual(r.status, 200)
        return json.loads(body)

    def events(self):
        logs = list((self.data / "access").glob("*.jsonl"))
        return [json.loads(x)["event"] for f in logs for x in f.read_text(encoding="utf-8").splitlines()]

    def test_no_upload_password_yet(self):
        self.assertFalse(self.get_orders()["meta"]["upload_ready"])
        status, doc = self.post(sample_tracker(), "whatever")
        self.assertEqual(status, 503)
        self.assertIn("上传密码", doc["error"])

    def test_upload_flow(self):
        self.app.set_upload_password(self.UPW)
        self.assertEqual((self.data / "config.json").stat().st_mode & 0o777, 0o600)
        self.assertTrue(self.get_orders()["meta"]["upload_ready"])

        status, _ = self.post(sample_tracker(), self.UPW, headers={**CF, "X-Upload-Key": ""})
        self.assertEqual(status, 401)  # 没登录
        status, doc = self.post(sample_tracker(), PW)  # 查看密码不能拿来上传
        self.assertEqual((status, doc["error"]), (403, "上传密码不对"))
        status, doc = self.post(b"PK not really", self.UPW)
        self.assertEqual(status, 422)
        self.assertIn(".xlsx", doc["error"])
        self.assertEqual(self.get_orders()["orders"][0]["po"], "1")  # 失败时页面不变

        status, doc = self.post(sample_tracker(), self.UPW)
        self.assertEqual(status, 200, doc)
        self.assertEqual((doc["wo_count"], doc["open_count"], doc["rows"]), (3, 1, 4))
        saved = list((self.data / "tracker").iterdir())
        self.assertEqual(len(saved), 1)
        self.assertTrue(saved[0].name.endswith("-跟单总表_1112.xlsx"), saved[0].name)
        self.assertEqual(saved[0].read_bytes(), sample_tracker())

        got = self.get_orders()
        self.assertEqual(got["meta"]["source"], "tracker")
        self.assertEqual(got["meta"]["filename"], "跟单总表 1112.xlsx")
        self.assertEqual(got["meta"]["sheet_note"], "最后更新时间 2026/11/12 09：30")
        self.assertNotIn("uploaded_from", got["meta"])
        keys = sorted((o["po"], o["supplier"]) for o in got["orders"])
        self.assertEqual(keys, [("90102", "凯维"), ("90103", "兴华")])  # 90101|华晨 被 overrides 隐藏
        self.assertEqual([o.get("note") for o in got["orders"] if o["po"] == "90102"], ["x"])
        ev = self.events()
        for e in ("upload_fail", "upload_bad_file", "upload_ok"):
            self.assertIn(e, ev)

    def test_wrong_upload_password_counts_toward_lockout(self):
        self.app.set_upload_password(self.UPW)
        for _ in range(po_server.FAIL_LIMIT):
            self.assertEqual(self.post(b"x", "bad")[0], 403)
        self.assertEqual(self.post(sample_tracker(), self.UPW)[0], 429)

    def test_too_big(self):
        self.app.set_upload_password(self.UPW)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.putrequest("POST", "/api/upload", skip_host=True)
        for k, v in {**CF, "Cookie": self.cookie, "Content-Length": str(po_server.MAX_UPLOAD + 1)}.items():
            c.putheader(k, v)
        c.endheaders()
        r = c.getresponse()
        self.assertEqual(r.status, 413)
        c.close()

    def test_cli_sets_hash_only(self):
        answers = iter([self.UPW, self.UPW])
        with mock.patch.object(po_server.getpass, "getpass", lambda prompt="": next(answers)), \
                mock.patch("builtins.print"):
            po_server.main(["set-upload-password", "--data", str(self.data)])
        cfg = json.loads((self.data / "config.json").read_text(encoding="utf-8"))
        self.assertNotIn(self.UPW, json.dumps(cfg, ensure_ascii=False))
        self.assertTrue(po_server.verify_password(self.UPW, cfg["upload_password"]))
        answers = iter(["short"])
        with mock.patch.object(po_server.getpass, "getpass", lambda prompt="": next(answers)):
            with self.assertRaises(SystemExit):
                po_server.main(["set-upload-password", "--data", str(self.data)])


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

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
            "orders": [{"po": "90001", "status": "已下单"}, {"po": "90002", "status": "已确认"}, {"po": "90003"}],
        }), encoding="utf-8")
        (cls.data / "overrides.json").write_text(json.dumps({
            "_说明": "以下划线开头的键忽略",
            "90001": {"status": "已完成", "status_note": "手工"},
            "90003": {"hidden": True},
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
        self.assertEqual(sorted(pos), ["90001", "90002"])  # 90003 被 hidden
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

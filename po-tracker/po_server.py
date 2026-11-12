#!/usr/bin/env python3
"""PO 跟单列表页的小服务（po.kvstek.com）。只用 Python 标准库，Python 3.9+ 可跑。

  python3 po_server.py --data ~/apps/po-tracker/data \
      --password-from ~/apps/pricompare-data/config.json --host po.kvstek.com [--port 8792]

- 只监听 127.0.0.1，外面的人只能经 Cloudflare 通道（cloudflared → 127.0.0.1:8792）进来。
- 密码和报价页（quote.kvstek.com）同一个：从 pricompare 的 config.json 读 "password"（scrypt 哈希），
  每次登录都重新读，报价页换了密码这里马上跟着换，已登录的人全部作废。
- 经 Cloudflare 来的请求（带 cf-* 头，或 Host 不是 localhost）一律要密码 cookie；
  Host 必须是 --host 列出的域名，否则拒绝。本机直接访问（Host 是 localhost、没有 cf-* 头）不用密码。
- 数据：data/orders.json（po_sync.py 每小时写）+ data/overrides.json（手工更正，可选），读的时候合并。
- 访问记录：data/access/YYYY-MM.jsonl（打开页面、登录成功/失败）。
"""
from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import hmac
import html
import json
import os
import secrets
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"

COOKIE = "po_auth"
SESSION_MAX_AGE = 30 * 24 * 3600
FAIL_LIMIT, FAIL_WINDOW = 10, 600  # 全站 10 分钟内错 10 次就先停 10 分钟
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
LOOPBACK = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
       "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


# ---------------------------------------------------------------- 密码（和 pricompare 的 password.ts 同一格式）

def verify_password(password: str, stored: str) -> bool:
    """stored = scrypt$<盐 base64>$<哈希 base64>，scrypt N=16384 r=8 p=1（Node crypto.scrypt 的默认值）。"""
    parts = (stored or "").split("$")
    if len(parts) != 3 or parts[0] != "scrypt":
        return False
    try:
        salt, want = base64.b64decode(parts[1]), base64.b64decode(parts[2])
    except ValueError:
        return False
    if len(want) < 16 or not salt:
        return False
    got = hashlib.scrypt(unicodedata.normalize("NFC", password).encode("utf-8"), salt=salt,
                         n=16384, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=len(want))
    return hmac.compare_digest(got, want)


def hash_password(password: str) -> str:
    """测试和本地调试用；正式的哈希由 pricompare 的 cli.mjs hash-password 生成。"""
    salt = secrets.token_bytes(16)
    h = hashlib.scrypt(unicodedata.normalize("NFC", password).encode("utf-8"), salt=salt,
                       n=16384, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"


def _sign(key: bytes, password_hash: str, expires: int) -> str:
    mac = hmac.new(key, f"{expires}|{password_hash}".encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).decode().rstrip("=")


def make_session(key: bytes, password_hash: str, now: float | None = None) -> str:
    expires = int(((now if now is not None else time.time()) + SESSION_MAX_AGE) * 1000)
    return f"{expires}.{_sign(key, password_hash, expires)}"


def check_session(token: str, key: bytes, password_hash: str, now: float | None = None) -> bool:
    if not token or not password_hash or "." not in token:
        return False
    exp, sig = token.split(".", 1)
    if not exp.isdigit() or len(exp) > 16 or len(sig) != 43:
        return False
    if int(exp) <= (now if now is not None else time.time()) * 1000:
        return False
    return hmac.compare_digest(sig, _sign(key, password_hash, int(exp)))


# ---------------------------------------------------------------- 配置和数据

class App:
    def __init__(self, data: Path, password_from: Path, hosts: list[str]):
        self.data = data
        self.password_from = password_from
        self.hosts = {h.lower() for h in hosts}
        self.data.mkdir(parents=True, exist_ok=True)
        self.key = self._session_key()
        self.lock = threading.Lock()
        self.fails: list[float] = []

    def _session_key(self) -> bytes:
        p = self.data / "session.key"
        if not p.exists():
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(secrets.token_bytes(32))
        key = p.read_bytes()
        if len(key) < 32:
            raise SystemExit(f"{p} 太短，删掉它重启会自动重建（所有人要重新登录）")
        return key

    def password_hash(self) -> str:
        """每次都重新读：报价页换密码后这里立刻生效。读不到就当没配密码（公网一律进不来）。"""
        try:
            cfg = json.loads(self.password_from.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return ""
        pw = cfg.get("password") if isinstance(cfg, dict) else None
        return pw if isinstance(pw, str) else ""

    # 全站登录失败限速
    def locked_out(self) -> bool:
        now = time.time()
        with self.lock:
            self.fails = [t for t in self.fails if now - t < FAIL_WINDOW]
            return len(self.fails) >= FAIL_LIMIT

    def note_fail(self) -> None:
        with self.lock:
            self.fails.append(time.time())

    def orders(self) -> dict:
        p = self.data / "orders.json"
        try:
            doc = json.loads(p.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"meta": {"missing": True}, "orders": []}
        except (OSError, ValueError) as e:
            return {"meta": {"error": f"orders.json 读不了：{e.__class__.__name__}"}, "orders": []}
        orders = doc.get("orders") if isinstance(doc, dict) else None
        orders = [o for o in orders if isinstance(o, dict)] if isinstance(orders, list) else []
        meta = {k: v for k, v in doc.items() if k != "orders"} if isinstance(doc, dict) else {}
        try:
            meta["file_mtime"] = dt.datetime.fromtimestamp(p.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        except OSError:
            pass
        overrides = self._overrides()
        if overrides:
            out = []
            for o in orders:
                ov = overrides.get(str(o.get("po", "")))
                if isinstance(ov, dict):
                    if ov.get("hidden"):
                        continue
                    o = {**o, **{k: v for k, v in ov.items() if k != "hidden"}, "overridden": sorted(k for k in ov if k != "hidden")}
                out.append(o)
            orders = out
            meta["overrides"] = len(overrides)
        return {"meta": meta, "orders": orders}

    def _overrides(self) -> dict:
        try:
            ov = json.loads((self.data / "overrides.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return {str(k): v for k, v in ov.items() if not str(k).startswith("_")} if isinstance(ov, dict) else {}

    def log_access(self, event: str, req: "Handler") -> None:
        now = dt.datetime.now().astimezone()
        rec = {
            "t": now.isoformat(timespec="seconds"),
            "event": event,
            "via": "cloudflare" if req.public else "local",
            "ip": req.header("cf-connecting-ip") or req.client_address[0],
            "country": req.header("cf-ipcountry"),
            "ua": req.header("user-agent")[:300],
        }
        d = self.data / "access"
        try:
            d.mkdir(exist_ok=True)
            with self.lock, open(d / f"{now:%Y-%m}.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except OSError:
            pass


# ---------------------------------------------------------------- 登录页（服务自己出，不依赖 static/）

def login_page(error: str = "") -> str:
    msg = f'<p class="err">{html.escape(error)}</p>' if error else ""
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>PO 跟单</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #1f2329; }}
  form {{ background: #fff; padding: 32px 28px; border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.08);
    width: min(320px, calc(100vw - 32px)); box-sizing: border-box; }}
  h1 {{ font-size: 18px; margin: 0 0 6px; }}
  .sub {{ font-size: 13px; color: #8a8f99; margin: 0 0 20px; }}
  input {{ width: 100%; box-sizing: border-box; font-size: 16px; padding: 10px 12px; border: 1px solid #d0d3d9; border-radius: 6px; }}
  button {{ margin-top: 14px; width: 100%; font-size: 16px; padding: 10px; border: 0; border-radius: 6px; background: #3370ff; color: #fff; cursor: pointer; }}
  .err {{ color: #d83931; font-size: 14px; margin: 12px 0 0; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #1b1c1f; color: #e8e9eb; }}
    form {{ background: #26272b; box-shadow: none; }}
    input {{ background: #1b1c1f; color: #e8e9eb; border-color: #44464d; }}
  }}
</style>
</head>
<body>
<form method="post" action="/login">
  <h1>PO 跟单</h1>
  <p class="sub">和报价页同一个密码</p>
  <input type="password" name="password" placeholder="密码" autocomplete="current-password" autofocus required />
  <button type="submit">进入</button>
  {msg}
</form>
</body>
</html>
"""


# ---------------------------------------------------------------- 请求处理

class Handler(BaseHTTPRequestHandler):
    server_version = "po-tracker"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    app: App  # 由 make_server 设置

    # ---- 小工具
    def header(self, name: str) -> str:
        return (self.headers.get(name) or "").strip()

    @property
    def host(self) -> str:
        h = self.header("host").lower()
        if h.startswith("["):
            return h[1:].split("]", 1)[0]
        return h.rsplit(":", 1)[0] if h.count(":") == 1 else h

    @property
    def public(self) -> bool:
        """经 Cloudflare（或任何代理）来的：带 cf-* / tailscale-* 头，或 Host 不是本机名。"""
        if self.host not in LOCAL_HOSTS:
            return True
        return any(k.lower().startswith(("cf-", "tailscale-")) for k in self.headers.keys())

    def authed(self) -> bool:
        if not self.public:
            return True
        token = ""
        for part in self.header("cookie").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                token = v
        return check_session(token, self.app.key, self.app.password_hash())

    def send(self, status: int, body: bytes | str, ctype: str = "text/html; charset=utf-8",
             headers: dict[str, str] | None = None) -> None:
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Robots-Tag", "noindex, nofollow")
        self.send_header("Content-Security-Policy", CSP)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def redirect(self, location: str, status: int = 303, headers: dict[str, str] | None = None) -> None:
        self.send(status, "", headers={"Location": location, **(headers or {})})

    def cookie_header(self, token: str, max_age: int) -> str:
        secure = "; Secure" if self.public else ""
        return f"{COOKIE}={token}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure}"

    def log_message(self, fmt, *args):  # 只记错误，正常访问记在 access/
        pass

    def log_error(self, fmt, *args):
        sys.stderr.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} {fmt % args}\n")

    # ---- 入口检查：本机连接、域名、http→https
    def gate(self) -> bool:
        if self.client_address[0] not in LOOPBACK:
            self.send(403, "forbidden", "text/plain; charset=utf-8")
            return False
        if self.public and self.host not in self.app.hosts:
            self.send(421, "unknown host", "text/plain; charset=utf-8")
            return False
        if self.public and self.header("x-forwarded-proto").lower() == "http":
            self.redirect(f"https://{self.host}{self.path}", 308)
            return False
        return True

    # ---- 方法
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/healthz":
            return self.send(200, "ok", "text/plain; charset=utf-8")
        if not self.gate():
            return
        if path == "/robots.txt":
            return self.send(200, "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8")
        if path == "/login":
            if self.public and self.authed():
                return self.redirect("/")
            self.app.log_access("login_page", self)
            return self.send(200, login_page())
        if path == "/logout":
            return self.redirect("/login", headers={"Set-Cookie": self.cookie_header("", 0)})
        if not self.authed():
            if path.startswith("/api/"):
                return self.send(401, json.dumps({"error": "需要登录"}, ensure_ascii=False), "application/json; charset=utf-8")
            return self.redirect("/login")
        if path in ("/", "/index.html"):
            self.app.log_access("page", self)
            return self.static("index.html")
        if path == "/api/orders":
            doc = self.app.orders()
            doc["meta"]["server_time"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
            doc["meta"]["can_logout"] = self.public
            body = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
            return self.send(200, body, "application/json; charset=utf-8")
        if path.startswith("/static/"):
            return self.static(path[len("/static/"):])
        return self.send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        path = urlsplit(self.path).path
        if not self.gate():
            return
        if path == "/logout":
            return self.redirect("/login", headers={"Set-Cookie": self.cookie_header("", 0)})
        if path != "/login":
            return self.send(404, "not found", "text/plain; charset=utf-8")
        try:
            n = int(self.header("content-length") or "0")
        except ValueError:
            n = 0
        if n <= 0 or n > 4096:
            return self.send(400, login_page("请求不对，请重试"))
        form = parse_qs(self.rfile.read(n).decode("utf-8", "replace"))
        password = (form.get("password") or [""])[0]
        if self.app.locked_out():
            self.app.log_access("login_locked", self)
            return self.send(429, login_page("试错次数太多，请 10 分钟后再试"))
        stored = self.app.password_hash()
        if not stored:
            return self.send(503, login_page("还没有设置密码"))
        if not password or not verify_password(password, stored):
            self.app.note_fail()
            self.app.log_access("login_fail", self)
            return self.send(401, login_page("密码不对"))
        self.app.log_access("login_ok", self)
        token = make_session(self.app.key, stored)
        self.redirect("/", headers={"Set-Cookie": self.cookie_header(token, SESSION_MAX_AGE)})

    def static(self, name: str) -> None:
        p = (STATIC / name).resolve()
        if STATIC.resolve() not in p.parents or not p.is_file() or p.suffix not in STATIC_TYPES:
            return self.send(404, "not found", "text/plain; charset=utf-8")
        self.send(200, p.read_bytes(), STATIC_TYPES[p.suffix])


def make_server(app: App, port: int) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"app": app})
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.daemon_threads = True
    return srv


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="PO 跟单列表页服务")
    ap.add_argument("--port", type=int, default=8792)
    ap.add_argument("--data", type=Path, required=True, help="数据目录（orders.json、overrides.json、session.key、access/）")
    ap.add_argument("--password-from", type=Path, required=True, help="pricompare 的 config.json（读其中的 password 哈希）")
    ap.add_argument("--host", action="append", default=[], help="允许的对外域名，可写多次，如 po.kvstek.com")
    a = ap.parse_args(argv)
    app = App(a.data.expanduser(), a.password_from.expanduser(), a.host)
    srv = make_server(app, a.port)
    sys.stderr.write(f"{dt.datetime.now():%Y-%m-%d %H:%M:%S} po-tracker 启动 127.0.0.1:{a.port} 域名 {sorted(app.hosts)}\n")
    srv.serve_forever()


if __name__ == "__main__":
    main()

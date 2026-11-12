# PO 跟单列表页（po.kvstek.com）

一个页面列出 PO，按供应商交期的紧急程度上色。起点是 2026-11-12 从 zill@kvstek.com 邮件整理的 PO；之后不再自动判断状态（邮件同步已暂停），由跟单的人在页面上改状态、写跟进、手动新增 PO。和 pricompare 桌面版/报价网页无关，单独跑在 Zane 的 Mac 上，只用 Python 标准库。

```
po-tracker/
  po_server.py        网页服务（127.0.0.1:8792），密码登录，读 data/orders.json + overrides.json + edits.json
  edits.py            网页上的改动：检查、保存（data/edits.json）、跟进记录（data/history.jsonl）
  static/             页面（index.html、app.js、app.css、favicon.svg）
  deploy/             Mac 上的 LaunchAgent（local.po-tracker.plist）、健康检查、手动重启脚本
  sample/make_sample.py  生成假数据，本地看效果
  tests/               python3 -m unittest discover -s tests
```

起点数据由 Mac 上的 `~/apps/po-tracker/po_sync.py` 生成（只读 zill@ 邮箱 → `claude -p` 整理 → `data/orders.json`；2026-11-12 起暂停）。那个脚本含邮件细节，只放在 Mac 上，不进这个公开仓库；**任何邮件内容、订单数据都不要提交到这里。**

## 运行

```
python3 po_server.py --data ~/apps/po-tracker/data \
  --password-from ~/apps/pricompare-data/config.json --host po.kvstek.com --port 8792
```

- 只监听 127.0.0.1。外面经 Cloudflare 通道进来（cloudflared ingress `po.kvstek.com → http://127.0.0.1:8792`）。
- 密码和报价页同一个：每次登录都重新读 pricompare `config.json` 的 `password`（scrypt 哈希，和 `src/server/password.ts` 同格式）。报价页换密码后，这里马上要用新密码，旧登录全部失效。登录 cookie `po_auth`，30 天，用 `data/session.key` 签名。
- 带 `cf-*` / `tailscale-*` 头或 Host 不是 localhost 的请求都要登录，且 Host 必须是 `--host` 里的域名；本机直接打开 `http://localhost:8792/` 不用密码。
- 全站 10 分钟内输错 10 次密码就先停 10 分钟。http 自动转 https（看 `X-Forwarded-Proto`）。
- Mac 上由 LaunchAgent 常驻：`deploy/local.po-tracker.plist` 放到 `~/Library/LaunchAgents/`，`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.po-tracker.plist`；开机自启，退出后 10 秒自动拉起。改了代码后跑 `deploy/po_tracker_up.sh`（kickstart -k）让新代码生效。
- hermes 每 10 分钟跑 `deploy/po_tracker_check.sh`：只查 `/healthz`，不重启；连续两次不通才发一条 Telegram，恢复时再发一条。
- `GET /healthz` 给健康检查用；`GET /api/orders` 返回数据；访问记录写 `data/access/YYYY-MM.jsonl`。

## 在网页上改状态

- 编辑密码和查看密码分开（查看密码 Tony 也有，只能看）。设编辑密码（只存 scrypt 哈希到 `data/config.json`，权限 600）：
  `python3 po_server.py set-edit-password --data ~/apps/po-tracker/data`
- 页面右上角「编辑」→ 输编辑密码 → 这台设备 30 天内能改（cookie `po_edit`，换编辑密码后全部作废）。本机直接打开不用密码。
- 展开一个 PO：改状态（未定/已下单/已确认/已发货/已完成/已取消）、供应商交期、预计发货（日期或文字）、运单号，写「这次跟进了什么」，填名字（浏览器记住），保存。每次保存在 `data/history.jsonl` 记一行（谁、什么时候、改了什么旧→新、备注），页面上显示成「跟进记录」。
- 「新增 PO」：PO 号 + 供应商必填（同一对不能重复），可填交期、金额、客户 PO、零件（每行「零件号 数量」）。手动加的可以删，邮件来的不能删（不要的改成「已取消」）。
- 当前值存在 `data/edits.json`（`patches` 按 `PO|供应商`，`added` 是手动新增的），优先级最高：盖过 orders.json 和 overrides.json。
- 接口（都要登录 + 编辑权限，`Content-Type: application/json`，带 Origin 时必须是本站）：`POST /api/edit-login {password}`、`/api/edit-logout`、`/api/order/update {key, by, changes, note}`、`/api/order/add {by, order}`、`/api/order/delete {key, by}`。编辑密码输错算进全站 10 次限速。

## orders.json 格式（从邮件整理的旧数据）

```jsonc
{
  "version": 1,
  "generated_at": "2026-11-12T13:07:00+09:00",
  "source": "zill@kvstek.com",
  "po_mail_count": 140,
  "orders": [{
    "po": "44277",                 // 我方 PO/WO 号，可带后缀（44276A）；改过号用最终号
    "aliases": ["44259"],          // 旧号
    "supplier": "华晨",            // 华晨 / 凯维 / 兴华 / 其他简称；"" = 未定
    "buyer_entity": "Kavis Tech LLC",   // 或 深圳凯阔
    "customer_po": "22542184",     // 多个用 " / " 连接
    "customer": "KLA", "end_user": "Trudi Lootens",
    "order_date": "2026-10-26",    // 发给供应商的日期
    "due_date": "2026-11-15",      // 供应商交期（区间取最后一天）；null = 没写
    "due_text": "11/15",           // 原文
    "customer_due": null,
    "amount": 35400, "currency": "RMB", "tax": "含税",   // 兴华是未税价
    "status": "已确认",            // 未定 / 已下单 / 已确认 / 已发货 / 已完成 / 已取消
    "status_note": "华晨 10-27 回 confirmed",
    "tracking": "",
    "lines": [{"pn": "0712615-000", "rev": "AA", "desc": "…", "qty": 10, "unit_price": 53, "amount": 530}],
    "open_issues": ["改成 10 行后没看到华晨确认"],
    "mails": [{"folder": "收件箱", "uid": 812, "date": "…", "from": "Gene", "subject": "PO 44277 Due 11/15"}],
    "last_mail_at": "…", "updated_at": "…"
  }]
}
```

## 颜色

按 `due_date` 和今天差几天（日历天）：逾期（深红）、0–3 天（红）、4–7 天（黄）、7 天以上（绿）、没写交期（灰）。状态是已发货 / 已完成 / 已取消的一律变淡、排最后。阈值在 `static/app.js` 开头。

## 手工更正

`data/overrides.json`（可选），按 PO 号覆盖字段，下次读取就生效，不用重启：

```json
{
  "_说明": "下划线开头的键会被忽略",
  "44233": {"status": "已完成", "status_note": "Zane 11-12：已收货"},
  "44999": {"hidden": true}
}
```

同一个 PO 号给了两家供应商时（如 44278），键写成 `"44278|兴华"` 只改那一条；只写 PO 号就两条都改。页面上被更正过的 PO 展开后会标「手工更正过」。

`orders.json` 里的 `open_issues`、`doubts` 页面已经不显示（2026-11-12 起状态改由人跟进）。网页上的改动优先于这里的手工更正。

## 本地看效果

```
python3 sample/make_sample.py /tmp/po-data/orders.json
echo '{}' > /tmp/po-cfg.json
python3 po_server.py --data /tmp/po-data --password-from /tmp/po-cfg.json --host po.kvstek.com
# 打开 http://localhost:8792/
```

本机打开就能改；要试编辑密码，用 `--host localhost` 启动、请求带一个 `cf-ray` 头（当成公网），先 `set-edit-password`。

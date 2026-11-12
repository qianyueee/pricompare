# PO 跟单列表页（po.kvstek.com）

一个页面列出 PO，按供应商交期的紧急程度上色。数据以跟单人员每天上传的**跟单总表**为准（状态、备注全是人填的，页面不做判断）；还没上传过总表时，才显示从 zill@kvstek.com 邮件整理的旧数据。和 pricompare 桌面版/报价网页无关，单独跑在 Zane 的 Mac 上，只用 Python 标准库。

```
po-tracker/
  po_server.py        网页服务（127.0.0.1:8792），密码登录，读 data/tracker.json（没有就读 orders.json）
  tracker.py          读跟单总表 .xlsx 的「订单明细」，按 WO# + 供应商汇总（只用标准库）
  static/             页面（index.html、app.js、app.css、favicon.svg）
  deploy/             Mac 上的 LaunchAgent（local.po-tracker.plist）、健康检查、手动重启脚本
  sample/make_sample.py  生成假数据，本地看效果
  tests/               python3 -m unittest discover -s tests
```

数据由 Mac 上的 `~/apps/po-tracker/po_sync.py` 每小时生成（只读 zill@ 邮箱 → `claude -p` 整理 → `data/orders.json`）。那个脚本含邮件细节，只放在 Mac 上，不进这个公开仓库；**任何邮件内容、订单数据都不要提交到这里。**

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

## 上传跟单总表

- 页面右上角「上传总表」→ 选 .xlsx → 输上传密码。上传密码和查看密码分开（查看密码 Tony 也有）。
- 设上传密码（只存 scrypt 哈希到 `data/config.json`，权限 600）：
  `python3 po_server.py set-upload-password --data ~/apps/po-tracker/data`
- 接口：`POST /api/upload`，要登录 cookie（本机不用），请求体就是文件本身，`X-Upload-Key` = 上传密码的 UTF-8 再 base64，`X-Filename` = URL 编码的文件名；上限 30 MB；输错算进全站的 10 次限速。
- 读的是「订单明细」：前 10 行里有 `WO#` 和 `WO Due` 的那行是表头，必须有 `WO#`、`WO Due`、`Vendor`、`P/N`、`备注`。按 (WO#, Vendor) 汇总成一个 PO；Vendor 英文名换成 华晨/凯维/兴华。
- 一行算结束：`备注` 就是「完成」，或 `备注` 含「取消」，或填了 `发货日期`（1/1/2000 这种占位不算）。一个 PO 的所有行都结束才算结束（灰色、排最后）；其余按没结束的行里最早的 `WO Due` 上色，`备注` 和 `预计发货日期` 原文照样显示。
- 结果写 `data/tracker.json`（`source: "tracker"`, `uploaded_at`, `filename`, `sheet_note`, `rows`, `wo_count`, `open_count`, `orders`）；原文件留在 `data/tracker/`，保留最近 90 份。格式不对时原样告诉上传的人，页面不变。

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

`orders.json` 里的 `open_issues`、`doubts` 页面已经不显示（2026-11-12 起状态改由人跟进）。

## 本地看效果

```
python3 sample/make_sample.py /tmp/po-data/orders.json
echo '{}' > /tmp/po-cfg.json
python3 po_server.py --data /tmp/po-data --password-from /tmp/po-cfg.json --host po.kvstek.com
# 打开 http://localhost:8792/
```

看总表模式：先 `python3 po_server.py set-upload-password --data /tmp/po-data`，再在页面上点「上传总表」传一份。

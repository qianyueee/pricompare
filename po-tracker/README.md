# PO 跟单列表页（po.kvstek.com）

一个页面列出 zill@kvstek.com 邮箱里已有的 PO，按供应商交期的紧急程度上色。和 pricompare 桌面版/报价网页无关，单独跑在 Zane 的 Mac 上，只用 Python 标准库。

```
po-tracker/
  po_server.py        网页服务（127.0.0.1:8792），密码登录，读 data/orders.json
  static/             页面（index.html、app.js、app.css、favicon.svg）
  deploy/             Mac 上的保活脚本样板
  sample/make_sample.py  生成假数据，本地看效果
  tests/test_server.py   python3 -m unittest discover -s tests
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
- `GET /healthz` 给保活用；`GET /api/orders` 返回数据；访问记录写 `data/access/YYYY-MM.jsonl`。

## orders.json 格式

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

`orders.json` 里每条还可以有 `doubts`（整理时拿不准的地方，字符串数组），展开后显示在「整理时拿不准的地方」。

## 本地看效果

```
python3 sample/make_sample.py /tmp/po-data/orders.json
echo '{}' > /tmp/po-cfg.json
python3 po_server.py --data /tmp/po-data --password-from /tmp/po-cfg.json --host po.kvstek.com
# 打开 http://localhost:8792/
```

#!/bin/bash
# PO 跟单页保活（hermes 每 10 分钟跑）：127.0.0.1:8792/healthz 不通就重新拉起 local.po-tracker。
# 正常或重启成功时什么都不打印；只有起不来才打印一行（hermes 转发到 Telegram）。
APP=/Users/hanzj/apps/po-tracker
PY=/Users/hanzj/apps/pdf-locator-app/.venv/bin/python3
LABEL=local.po-tracker
PORT=8792
CONFIG=/Users/hanzj/apps/pricompare-data/config.json

ok() { /usr/bin/curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }
ok && exit 0

launchctl remove "$LABEL" 2>/dev/null
for _ in $(seq 1 20); do launchctl list "$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
launchctl submit -l "$LABEL" -o "$APP/server.log" -e "$APP/server.log" -- \
  "$PY" "$APP/po_server.py" --port "$PORT" --data "$APP/data" --password-from "$CONFIG" --host po.kvstek.com
for _ in $(seq 1 30); do ok && exit 0; sleep 0.5; done
echo "⚠️ PO 跟单页（po.kvstek.com）停了，重启也没起来，看 $APP/server.log"
exit 1

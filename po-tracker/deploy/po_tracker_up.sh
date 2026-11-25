#!/bin/bash
# 手动重启 PO 跟单页（平时不用：LaunchAgent local.po-tracker 开机自启、退出后自动拉起）。
# 改了 po_server.py / tracker.py 之后跑一下让新代码生效；正常时什么都不打印。
APP=/Users/hanzj/apps/po-tracker
LABEL=local.po-tracker
PORT=8792
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

ok() { /usr/bin/curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }

if [ ! -f "$PLIST" ]; then
  echo "没有 $PLIST，先按 README 装 LaunchAgent（deploy/local.po-tracker.plist）"
  exit 1
fi
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  launchctl bootstrap "$DOMAIN" "$PLIST"
fi
sleep 1
for _ in $(seq 1 30); do ok && exit 0; sleep 0.5; done
echo "⚠️ PO 跟单页（po.kvstek.com）重启后没起来，看 $APP/server.log"
exit 1

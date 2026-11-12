#!/bin/bash
# PO 跟单页健康检查（hermes 每 10 分钟跑一次）：只查 127.0.0.1:8792/healthz，不重启任何东西——
# 拉起服务归 launchd 的 LaunchAgent（~/Library/LaunchAgents/local.po-tracker.plist）管。
# 正常时什么都不打印。连续两次不通才打印一行（hermes 转发到 Telegram），之后恢复时再打印一行。
PORT=8792
STATE=/Users/hanzj/apps/po-tracker/data/.health_fails
LOG=/Users/hanzj/apps/po-tracker/server.log

n=$(cat "$STATE" 2>/dev/null || echo 0)
case "$n" in ''|*[!0-9]*) n=0 ;; esac

if /usr/bin/curl -fsS -m 5 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  [ "$n" -ge 2 ] && echo "✅ PO 跟单页（po.kvstek.com）恢复了"
  [ "$n" -ne 0 ] && echo 0 > "$STATE"
  exit 0
fi

n=$((n + 1))
echo "$n" > "$STATE"
if [ "$n" -eq 2 ]; then
  echo "⚠️ PO 跟单页（po.kvstek.com）停了 10 分钟以上，launchd 也没拉起来。看 $LOG，或 launchctl print gui/$(id -u)/local.po-tracker"
  exit 1
fi
exit 0

#!/usr/bin/env bash
# 服务器侧：给 task_center 的外部 application.properties 加 pi.notify.token（先备份，可一行还原）
# 用法：ssh -o BatchMode=yes root@<域名> 'bash -s' < scripts/server-apply-pi-token.sh
# 还原：ssh root@<域名> 'cp -a <服务器根>/java/task_center/application.properties.bak-<TS> <服务器根>/java/task_center/application.properties && systemctl restart task-center.service'
set -euo pipefail

F=<服务器根>/java/task_center/application.properties
# 令牌不入库：从环境变量 PI_NOTIFY_TOKEN 读，或从（已 gitignore 的）scripts/pi-token.txt 读
TOKEN=${PI_NOTIFY_TOKEN:-}
if [ -z "$TOKEN" ] && [ -f "$(dirname "$0")/pi-token.txt" ]; then
  TOKEN=$(tr -d '\r\n' < "$(dirname "$0")/pi-token.txt")
fi
if [ -z "$TOKEN" ]; then
  echo "缺少令牌：export PI_NOTIFY_TOKEN=<与 config/config.json 的 token 一致> 或写 scripts/pi-token.txt" >&2
  exit 1
fi
TS=$(date +%Y%m%d-%H%M%S)

cp -a "$F" "${F}.bak-${TS}"
echo "BACKUP=${F}.bak-${TS}"

if grep -qn '^pi\.notify\.token=' "$F"; then
  sed -i "s|^pi\.notify\.token=.*|pi.notify.token=${TOKEN}|" "$F"
  echo "MODE=updated"
else
  printf '\n# pi-gateway (home box, via frp) -> POST /ui/api/pi/notify with header X-Pi-Token\npi.notify.token=%s\n' "$TOKEN" >> "$F"
  echo "MODE=appended"
fi

echo "--- result ---"
grep -n 'pi\.notify' "$F" || echo "MISSING pi.notify"
ls -la "${F}".bak-* 2>/dev/null | tail -3

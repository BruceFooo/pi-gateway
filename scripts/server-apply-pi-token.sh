#!/usr/bin/env bash
# 服务器侧：给 task_center 的外部 application.properties 加 pi.notify.token（先备份，可一行还原）
# 这个脚本在服务器上跑，所以文件路径由调用方用环境变量传：
#   F=${F:?}  例：/srv/app/application.properties（取自本机 config/deploy.local.json 的 server.centerProps）
# 令牌不入库：从环境变量 PI_NOTIFY_TOKEN 读，或从（已 gitignore 的）scripts/pi-token.txt 读。
# 调用形如：
#   eval "$(node scripts/deploy-config.mjs --sh)"
#   ssh $SSH_OPTS $SSH_HOST "F=$SERVER_CENTER_PROPS bash -s" < scripts/server-apply-pi-token.sh
# 还原（<TS> 用脚本打印的时间戳）：
#   ssh $SSH_HOST "cp -a <F>.bak-<TS> <F> && systemctl restart <center unit>"
set -euo pipefail

F=${F:?缺少环境变量 F（application.properties 的绝对路径）}
CENTER_UNIT=${CENTER_UNIT:-task-center.service}
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
grep -c 'pi\.notify' "$F" | sed 's/^/pi_notify_lines=/'
ls -1 "${F}".bak-* 2>/dev/null | tail -3

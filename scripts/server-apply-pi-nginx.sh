#!/usr/bin/env bash
# 服务器侧：安装带 /pi/ 反代的 UI 站点 vhost（备份 -> 安装 -> nginx -t -> 失败即还原 -> reload）
# 这个脚本在服务器上跑，所以真实路径/域名不写死，由调用方用环境变量传进来：
#   VHOST       站点文件（如 /etc/nginx/sites-available/<ui>.conf）
#   NGINX_CONF  nginx -t 要校验的主配置
#   NGINX_BIN   nginx 可执行文件（默认 /usr/sbin/nginx）
#   UI_ORIGIN   站点公网 origin（只用于探活打印）
# 推荐用本机包装脚本 scripts/apply-pi-nginx.sh（它从 config/deploy.local.json 取这些值）。手工调用形如：
#   ssh $SSH_OPTS $SSH_HOST "VHOST=... NGINX_CONF=... UI_ORIGIN=... bash -s -- /tmp/pi-vhost.conf" < scripts/server-apply-pi-nginx.sh
# 紧急还原（把 <TS> 换成脚本打印的时间戳）：
#   ssh $SSH_HOST "cp -a <VHOST>.bak-<TS> <VHOST> && <NGINX_BIN> -t -c <NGINX_CONF> && systemctl reload <nginx unit>"
set -uo pipefail

SRC=${1:?用法: server-apply-pi-nginx.sh <已上传的新 vhost 路径>}
VHOST=${VHOST:?缺少环境变量 VHOST（站点文件绝对路径）}
NGINX_CONF=${NGINX_CONF:?缺少环境变量 NGINX_CONF（nginx -t 要校验的主配置）}
NGINX_BIN=${NGINX_BIN:-/usr/sbin/nginx}
UI_ORIGIN=${UI_ORIGIN:-}
NGINX_UNIT=${NGINX_UNIT:-runtime-nginx.service}
TS=$(date +%Y%m%d-%H%M%S)
BAK="${VHOST}.bak-${TS}"

echo "TS=$TS"
if [ ! -s "$SRC" ]; then echo "SRC_MISSING=$SRC"; exit 1; fi
if ! grep -q 'location \^~ /pi/' "$SRC"; then echo "SRC_HAS_NO_PI_BLOCK"; exit 1; fi

cp -a "$VHOST" "$BAK" && echo "BACKUP=$BAK"
cp -f "$SRC" "$VHOST" && echo "INSTALLED from $SRC"

if ! "$NGINX_BIN" -t -c "$NGINX_CONF"; then
  echo "NGINX_TEST_FAILED -> 还原 $BAK"
  cp -f "$BAK" "$VHOST"
  "$NGINX_BIN" -t -c "$NGINX_CONF" && echo "RESTORED_CONFIG_OK"
  echo "ROLLBACK_DONE config_invalid_no_reload"
  exit 1
fi

systemctl reload "$NGINX_UNIT"
sleep 2
echo "nginx=$(systemctl is-active "$NGINX_UNIT")"
if [ -n "$UI_ORIGIN" ]; then
  echo "admin=$(curl -s -o /dev/null -w '%{http_code}' "$UI_ORIGIN/admin/")"
  # /pi/healthz 在 frpc 隧道建起来之前预期 502/504，不是配置错误
  echo "pihealthz=$(curl -s -o /dev/null -w '%{http_code}' "$UI_ORIGIN/pi/healthz")"
fi
echo "ROLLBACK_CMD=cp -a $BAK $VHOST && $NGINX_BIN -t -c $NGINX_CONF && systemctl reload $NGINX_UNIT"
echo "APPLY_OK"

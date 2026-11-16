#!/usr/bin/env bash
# 服务器侧：安装带 /pi/ 反代的 <站点短名> vhost（备份 -> 安装 -> nginx -t -> 失败即还原 -> reload）
# 用法：
#   scp -o BatchMode=yes <新vhost> root@<域名>:/tmp/<站点短名>-pi.conf
#   ssh -o BatchMode=yes root@<域名> 'bash -s' < scripts/server-apply-pi-nginx.sh /tmp/<站点短名>-pi.conf
# 紧急还原（把 <TS> 换成脚本打印的时间戳）：
#   ssh root@<域名> 'cp -a <服务器根>/runtime/nginx/sites-available/<UI域名>.conf.bak-<TS> <服务器根>/runtime/nginx/sites-available/<UI域名>.conf && /usr/sbin/nginx -t -c <服务器根>/runtime/nginx/conf/nginx.conf && systemctl reload runtime-nginx.service'
set -uo pipefail

SRC=${1:?用法: server-apply-pi-nginx.sh <已上传的新 vhost 路径>}
VHOST=<服务器根>/runtime/nginx/sites-available/<UI域名>.conf
NGINX_BIN=/usr/sbin/nginx
NGINX_CONF=<服务器根>/runtime/nginx/conf/nginx.conf
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

systemctl reload runtime-nginx.service
sleep 2
echo "nginx=$(systemctl is-active runtime-nginx.service)"
echo "admin=$(curl -s -o /dev/null -w '%{http_code}' https://<UI域名>/admin/)"
# /pi/healthz 在 frpc 隧道建起来之前预期 502/504，不是配置错误
echo "pihealthz=$(curl -s -o /dev/null -w '%{http_code}' https://<UI域名>/pi/healthz)"
echo "ROLLBACK_CMD=cp -a $BAK $VHOST && $NGINX_BIN -t -c $NGINX_CONF && systemctl reload runtime-nginx.service"
echo "APPLY_OK"

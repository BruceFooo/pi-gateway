#!/usr/bin/env bash
# 手动跑 UI 上线（本机没装 PowerShell 7，Deploy-TaskCenter.ps1 有 #requires ps 7 跑不了）。
# 语义与技能脚本的 UI 分支一致：先看 vite 输出的 VITE_API_BASE_URL 是不是生产域名（门禁），
# 再 cp -a 整份备份到 <server.uiBackupDir>/<STAMP>，最后 rsync -a --delete --exclude 'admin.7z' 覆盖站点。
#
# 真实值（SSH 目标、域名、服务器路径）都不写在脚本里，取自 config/deploy.local.json：
#   node scripts/deploy-config.mjs --get ssh.host
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC2046
eval "$(node "$HERE/deploy-config.mjs" --sh)"

# <本机工具根>/... -> /g/code/...（git-bash 下能用）
to_msys() {
  local p=${1//\\//}
  local drive=${p%%:*}
  if [ "$drive" = "$p" ]; then printf '%s' "$p"; return; fi
  printf '/%s%s' "$(printf '%s' "$drive" | tr 'A-Z' 'a-z')" "${p#*:}"
}

UI=$(to_msys "$LOCAL_UI_DIR")
SSH_HOST=$SSH_HOST
OPT=$SSH_OPTS
UI_ROOT=$SERVER_UI_ROOT
UI_BACKUP=$SERVER_UI_BACKUP_DIR
CENTER_ORIGIN=https://$DOMAINS_CENTER
UI_ORIGIN=https://$DOMAINS_UI

export PATH="/c/node/node-versions/v24.19.0/installation:$PATH"
cd "$UI"
BUILD=$(npm run build 2>&1)
ENVL=$(printf '%s\n' "$BUILD" | grep -m1 'VITE_API_BASE_URL' || true)
echo "门禁行：$ENVL"
case "$ENVL" in
  *"$CENTER_ORIGIN"*) ;;
  *) echo "拒绝发布：UI 构建的 API 地址不是 $CENTER_ORIGIN"; exit 1 ;;
esac

CSS=$(basename "$(ls dist/assets/admin-*.css | head -1)")
JS=$(basename "$(ls dist/assets/admin-*.js | head -1)")
STAMP=$(date +%Y%m%d-%H%M%S)
RS=/tmp/<中性名>-$STAMP
TAR=/tmp/ui-dist-$STAMP.tar.gz
tar -czf "$TAR" -C dist .
echo "产物：$CSS / $JS，包 $(du -h "$TAR" | cut -f1)"

# shellcheck disable=SC2086
ssh $OPT "$SSH_HOST" "mkdir -p $RS"
# shellcheck disable=SC2086
scp $OPT -q "$TAR" "$SSH_HOST:$RS/ui-dist.tar.gz"
# shellcheck disable=SC2086
ssh $OPT "$SSH_HOST" "set -euo pipefail
STAMP=$STAMP
RS=$RS
UI_ROOT=$UI_ROOT
UI_BK=$UI_BACKUP/\$STAMP
mkdir -p \$(dirname \"\$UI_BK\")
[ -d \"\$UI_ROOT\" ] && cp -a \"\$UI_ROOT\" \"\$UI_BK\"
rm -rf \"\$RS/ui\" && mkdir -p \"\$RS/ui\"
tar -xzf \"\$RS/ui-dist.tar.gz\" -C \"\$RS/ui\"
rsync -a --delete --exclude 'admin.7z' \"\$RS/ui/\" \"\$UI_ROOT/\"
ls -1dt $UI_BACKUP/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
rm -rf \"\$RS\"
echo REMOTE_DEPLOY_OK \$UI_BK"

echo "--- 健康检查"
for u in "$UI_ORIGIN/" "$UI_ORIGIN/admin/"; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 12 "$u" || true)
  echo "$u -> $code"
done
SERVED=$(curl -sk --max-time 12 "$UI_ORIGIN/admin/" | grep -o 'admin-[A-Za-z0-9_-]*\.css' | head -1)
echo "线上 admin 引的 CSS：${SERVED:-（没抓到）}  本地：$CSS"
[ "$SERVED" = "$CSS" ] && echo "UI 上线确认：新样式已生效" || echo "注意：线上 CSS 与本次产物不一致（可能没替换成功）"
rm -f "$TAR"

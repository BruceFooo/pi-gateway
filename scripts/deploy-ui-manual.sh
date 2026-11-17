#!/usr/bin/env bash
# 手动跑 UI 上线（本机没装 PowerShell 7，Deploy-TaskCenter.ps1 有 #requires ps 7 跑不了）。
# 语义与技能脚本的 UI 分支一致：先看 vite 输出的 VITE_API_BASE_URL 是不是生产域名（门禁），
# 再 cp -a 整份备份到 .<站点短名>-backup/<STAMP>，最后 rsync -a --delete --exclude 'admin.7z' 覆盖站点。
set -euo pipefail

UI=/g/code/1PROJECT/myProjects/java/distrisched/ui/task_manage
SSH_HOST=root@<域名>
OPT="-o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR"
UI_ROOT=<服务器根>/runtime/www/<UI域名>

export PATH="/c/node/node-versions/v24.19.0/installation:$PATH"
cd "$UI"
BUILD=$(npm run build 2>&1)
ENVL=$(printf '%s\n' "$BUILD" | grep -m1 'VITE_API_BASE_URL' || true)
echo "门禁行：$ENVL"
case "$ENVL" in
  *https://<CENTER域名>*) ;;
  *) echo "拒绝发布：UI 构建不是生产 API 地址"; exit 1 ;;
esac

CSS=$(basename "$(ls dist/assets/admin-*.css | head -1)")
JS=$(basename "$(ls dist/assets/admin-*.js | head -1)")
STAMP=$(date +%Y%m%d-%H%M%S)
RS=/tmp/<中性名>-$STAMP
TAR=/tmp/<站点短名>-$STAMP.tar.gz
tar -czf "$TAR" -C dist .
echo "产物：$CSS / $JS，包 $(du -h "$TAR" | cut -f1)"

# shellcheck disable=SC2086
ssh $OPT "$SSH_HOST" "mkdir -p $RS"
# shellcheck disable=SC2086
scp $OPT -q "$TAR" "$SSH_HOST:$RS/<站点短名>-dist.tar.gz"
# shellcheck disable=SC2086
ssh $OPT "$SSH_HOST" "set -euo pipefail
STAMP=$STAMP
RS=$RS
UI_ROOT=$UI_ROOT
UI_BK=<服务器根>/runtime/www/.<站点短名>-backup/\$STAMP
mkdir -p \$(dirname \"\$UI_BK\")
[ -d \"\$UI_ROOT\" ] && cp -a \"\$UI_ROOT\" \"\$UI_BK\"
rm -rf \"\$RS/ui\" && mkdir -p \"\$RS/ui\"
tar -xzf \"\$RS/<站点短名>-dist.tar.gz\" -C \"\$RS/ui\"
rsync -a --delete --exclude 'admin.7z' \"\$RS/ui/\" \"\$UI_ROOT/\"
ls -1dt <服务器根>/runtime/www/.<站点短名>-backup/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
rm -rf \"\$RS\"
echo REMOTE_DEPLOY_OK \$UI_BK"

echo "--- 健康检查"
for u in https://<UI域名>/ https://<UI域名>/admin/; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 12 "$u" || true)
  echo "$u -> $code"
done
SERVED=$(curl -sk --max-time 12 https://<UI域名>/admin/ | grep -o 'admin-[A-Za-z0-9_-]*\.css' | head -1)
echo "线上 admin 引的 CSS：${SERVED:-（没抓到）}  本地：$CSS"
[ "$SERVED" = "$CSS" ] && echo "UI 上线确认：新样式已生效" || echo "注意：线上 CSS 与本次产物不一致（可能没替换成功）"
rm -f "$TAR"

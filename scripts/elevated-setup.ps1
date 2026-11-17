# 一次性提权脚本：把 pi-gateway 装成 WinSW 服务 + 重启 frpc 隧道。
# 运行方式（非管理员 shell 里）：
#   powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<本机工具根>\pi-gateway\scripts\elevated-setup.ps1'"
# 日志：<本机工具根>\pi-gateway\logs\elevated-setup-<ts>.log（提权窗口关掉也能读到结果）
# 卸载服务（紧急回退）：管理员 shell 里 <本机工具根>\pi-gateway\service\pi-gateway.exe uninstall
$ErrorActionPreference = 'Continue'
# 包根不写死机器路径：本脚本在 <包根>\scripts\ 里，往上一级就是包根，换机器/换盘符都跟着走。
$root = Split-Path -Parent $PSScriptRoot
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$log  = Join-Path $root "logs\elevated-setup-$ts.log"
Start-Transcript -Path $log | Out-Null
function L($m) { Write-Host $m }

L "==== elevated-setup $ts ===="

# 1) 让位：杀掉手动起的网关（监听 33336 的 node）
$conns = @(Get-NetTCPConnection -LocalPort 33336 -State Listen -ErrorAction SilentlyContinue)
foreach ($c in $conns) {
    $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
    L "port33336 owner pid=$($c.OwningProcess) name=$($p.ProcessName)"
    if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force; L "killed manual gateway pid=$($p.Id)" }
}
Start-Sleep -Seconds 2

# 2) 安装 + 启动服务
Set-Location $root
& "$root\service\pi-gateway.exe" install 2>&1 | ForEach-Object { L "install: $_" }
L "install_exit=$LASTEXITCODE"
& "$root\service\pi-gateway.exe" start 2>&1 | ForEach-Object { L "start: $_" }

# 3) 健康检查（60s）
$ok = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:33336/healthz' -TimeoutSec 5
        if ($r.StatusCode -eq 200) { L "health: $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))"; $ok = $true; break }
    } catch { L "health attempt $($i+1): $($_.Exception.Message)" }
}

if (-not $ok) {
    L 'HEALTH_FAILED -> 自动回退：卸载服务，恢复手动网关'
    & "$root\service\pi-gateway.exe" stop 2>&1 | ForEach-Object { L "stop: $_" }
    & "$root\service\pi-gateway.exe" uninstall 2>&1 | ForEach-Object { L "uninstall: $_" }
    & powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\restart-gateway.ps1" 2>&1 | ForEach-Object { L "manual: $_" }
    L 'RESTORED_MANUAL'
}

# 4) frpc 隧道（会把远程桌面那条隧道断几秒）
try {
    Restart-Service remote-desktop -Force
    L 'remote-desktop restarted'
} catch {
    L "remote-desktop restart FAILED: $($_.Exception.Message)"
}
Start-Sleep -Seconds 8
L ("remote-desktop=" + (Get-Service remote-desktop -ErrorAction SilentlyContinue).Status)
Get-Process frpc -ErrorAction SilentlyContinue | ForEach-Object { L "frpc pid=$($_.Id)" }
L ("pi-gateway=" + (Get-Service pi-gateway -ErrorAction SilentlyContinue).Status)
L '==== elevated-setup done ===='
Stop-Transcript | Out-Null

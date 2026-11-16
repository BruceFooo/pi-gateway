# 重启 WinSW 服务 pi-gateway 的**正确**姿势（2026-11-16 事故后补）。
#
# 事故：`sc.exe stop pi-gateway` 只结束 WinSW 包装进程，它起的 `node index.js` 子进程**不会被杀**，
# 变成孤儿继续占 33336；随后 `sc.exe start` 起的新实例 EADDRINUSE 崩掉，服务变成
# STOPPED / WIN32_EXIT_CODE 1067（进程意外终止），而端口上还跑着**旧代码**的旧进程
# —— 手机上就表现为新指令报「未知指令：page_list」，healthz 的 uptimeSec 还是几小时。
#
# 所以停服务之后必须先按端口清掉孤儿（连带它起的 pi --mode rpc 子进程），再 start。
# 注意：这会杀掉当前 pi 会话（会话就是网关起的子进程），跑之前先跟手机上的人说一声，
# 或者用 -DelaySec 排一次延迟重启。
param([int]$DelaySec = 0)
$ErrorActionPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)

$log = Join-Path $PWD 'logs\restart-service.log'
function Say($m) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"
    Write-Output $line
    Add-Content -Path $log -Value $line
}

if ($DelaySec -gt 0) { Say "等待 $DelaySec 秒后重启（让当前会话的回复先送达手机）"; Start-Sleep -Seconds $DelaySec }

Say "=== restart-service 开始"
sc.exe stop pi-gateway 2>&1 | ForEach-Object { Say "stop: $_" }
Start-Sleep -Seconds 3

# 清掉停服务后遗留的孤儿：先按端口，再按 pi --mode rpc 子进程（绝不碰用户自己开的 pi 会话）
$killed = @()
foreach ($c in Get-NetTCPConnection -LocalPort 33336 -State Listen) {
    $procId = $c.OwningProcess
    if ($killed -notcontains $procId) {
        Say "kill 占端口的孤儿 PID $procId ($((Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine))"
        Stop-Process -Id $procId -Force
        $killed += $procId
    }
}
foreach ($o in Get-CimInstance Win32_Process -Filter "Name='node.exe'") {
    if ($o.ProcessId -notin $killed -and $o.CommandLine -like '*--mode*rpc*') {
        Say "kill 残留的 pi 子进程 PID $($o.ProcessId)"
        Stop-Process -Id $o.ProcessId -Force
        $killed += $o.ProcessId
    }
}
Start-Sleep -Seconds 2

sc.exe start pi-gateway 2>&1 | ForEach-Object { Say "start: $_" }
Start-Sleep -Seconds 12

$q = (sc.exe query pi-gateway 2>&1) -join ' '
Say "service: $q"
try {
    $h = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:33336/healthz' -TimeoutSec 8).Content
    Say "healthz: $h"
} catch { Say "healthz FAILED: $($_.Exception.Message)" }

# 页面路由探针：不带令牌应当 401（新路由已生效）；404 说明跑的还是旧代码
try {
    Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:33336/pi/pages/__probe__.html' -TimeoutSec 8 | Out-Null
    Say 'pages probe: 200（意外：不带令牌不该通）'
} catch {
    Say "pages probe: HTTP $($_.Exception.Response.StatusCode.value__)（401=新路由生效；404=还是旧代码）"
}
Say "=== restart-service 结束"

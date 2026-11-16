# 重启 pi-gateway：按端口找占用者（它的命令行只是 "node index.js"，按命令行匹配不到），
# 再清掉它遗留的 pi 子进程（bundle/cli.js --mode rpc）。绝不碰用户自己的 pi 会话。
$ErrorActionPreference = 'SilentlyContinue'
Set-Location (Split-Path -Parent $PSScriptRoot)

$log = Join-Path $PWD 'logs\restart.log'
function Say($m) { $line = "$(Get-Date -Format 'HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $log -Value $line }

$conns = Get-NetTCPConnection -LocalPort 33336 -State Listen
foreach ($c in $conns) {
    $procId = $c.OwningProcess
    $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$procId").CommandLine
    Say "kill listener PID $procId ($cmd)"
    Stop-Process -Id $procId -Force
}

$orphans = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*bundle*cli.js*--mode rpc*' }
foreach ($o in $orphans) {
    Say "kill orphan pi PID $($o.ProcessId)"
    Stop-Process -Id $o.ProcessId -Force
}

Start-Sleep -Seconds 2
$psi = Start-Process -FilePath "node" -ArgumentList "index.js" -WorkingDirectory $PWD -WindowStyle Hidden `
    -RedirectStandardOutput "logs\stdout.log" -RedirectStandardError "logs\gw.err" -PassThru
Say "started gateway PID $($psi.Id)"
Start-Sleep -Seconds 6
Say "healthz: $((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:33336/healthz -TimeoutSec 5).Content)"

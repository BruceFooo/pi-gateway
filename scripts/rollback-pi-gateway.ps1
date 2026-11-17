#requires -Version 7.0
<#
.SYNOPSIS
    pi 手机网关的一键紧急回退：把「上线时动过的每一处」单独或全部退回上线前状态。
.DESCRIPTION
    上线一共动了四处，本脚本按层级回退（每一层都是幂等的，重复执行安全）：

      -Level service   Windows 服务 pi-gateway 停掉并卸载，回到「手动跑网关」或「完全不跑」
      -Level frpc      gofrpc 里删掉 pi-gateway 隧道段（33336），重启 remote-desktop 服务
      -Level nginx     服务器 UI 站点还原到上线前备份，nginx -t 通过后 reload
      -Level center    task_center 的 application.properties 还原（去掉 pi.notify.token），重启 task-center
      -Level all       以上全部（默认）

    另外：task_center 的 jar / 前端 dist 是发布脚本自己带备份和自动回滚的
    （<本机工作区>\java\distrisched\backup\<时间戳>\，失败时会自己还原；
    人工回退就用 deploy 脚本打印的 Copy-Item 命令）。本脚本不碰它们。

    不加 -Yes 时只打印将要执行的命令（dry-run）。

    -SelfTest 只在临时副本上验证「删 frpc 段」的逻辑，不碰真文件也不重启服务，
    用来确认回退脚本本身可用（上线后建议先跑一次）。
.EXAMPLE
    ./scripts/rollback-pi-gateway.ps1                      # 预览全部回退步骤
    ./scripts/rollback-pi-gateway.ps1 -SelfTest            # 验证 frpc 删段逻辑（无副作用）
    ./scripts/rollback-pi-gateway.ps1 -Level nginx -Yes    # 只回退 nginx，真的执行
    ./scripts/rollback-pi-gateway.ps1 -Level all -Yes      # 全部下线
#>
param(
    [ValidateSet('service', 'frpc', 'nginx', 'center', 'all')]
    [string] $Level = 'all',
    [switch] $Yes,
    [switch] $SelfTest,
    [string] $SshHost = '',
    [string] $GatewayRoot = '',
    [string] $FrpcToml = '',
    [string] $NginxSite = '',
    [string] $NginxBak = '',
    [string] $CenterProps = '',
    [string] $CenterPropsBak = ''
)

$ErrorActionPreference = 'Stop'

# 真实域名/服务器路径/SSH 目标不写在脚本里，取自 config/deploy.local.json（不入库）。
# 命令行参数仍可显式覆盖（应急时不带清单也能跑）。
. (Join-Path $PSScriptRoot 'deploy-config.ps1')
$deploy = $null
try { $deploy = Get-DeployConfig } catch { Write-Host "（读部署清单失败：$($_.Exception.Message)）" }
function Dget([string] $p) {
    if (-not $deploy) { return '' }
    $o = $deploy
    foreach ($seg in $p.Split('.')) { $o = $o.$seg; if ($null -eq $o) { return '' } }
    return [string] $o
}
if (-not $SshHost)      { $SshHost = Dget 'ssh.host' }
if (-not $GatewayRoot)  { $GatewayRoot = if (Dget 'local.gatewayRoot') { Dget 'local.gatewayRoot' } else { Split-Path $PSScriptRoot -Parent } }
if (-not $FrpcToml)     { $FrpcToml = Dget 'local.frpcToml' }
if (-not $NginxSite)    { $NginxSite = Dget 'server.nginxVhost' }
if (-not $NginxBak)     { $NginxBak = Dget 'server.nginxVhostBak' }
if (-not $CenterProps)  { $CenterProps = Dget 'server.centerProps' }
if (-not $CenterPropsBak) { $CenterPropsBak = Dget 'server.centerPropsBak' }
$NginxBin  = Dget 'server.nginxBin';  if (-not $NginxBin) { $NginxBin = '/usr/sbin/nginx' }
$NginxConf = Dget 'server.nginxConf'
$PiHealthz = Dget 'urls.piHealthz'
$CenterHealth = Dget 'urls.centerHealth'
$SshOptList = @('-o', 'BatchMode=yes')
if (Dget 'ssh.opts') { $SshOptList = @((Dget 'ssh.opts') -split '\s+' | Where-Object { $_ }) }

$svcExe = Join-Path $GatewayRoot 'service\pi-gateway.exe'
$doit = [bool] $Yes

function Say([string] $m) { Write-Host $m }
function Run([string] $label, [scriptblock] $block, [string] $show) {
    Say "  - $label"
    Say "      $(if ($doit) { '执行' } else { '预览' })：$show"
    if (-not $doit) { return }
    try {
        & $block | Out-Host
    } catch {
        Say "      失败：$($_.Exception.Message)"
        throw
    }
}
function Remote([string] $cmd) {
    ssh @SshOptList $SshHost $cmd
}
function NeedServerTarget([string] $what) {
    if (-not $SshHost) { throw "缺少 SSH 目标：在 config/deploy.local.json 填 ssh.host，或用 -SshHost 传入" }
    if (-not $what) { throw "缺少服务器路径：在 config/deploy.local.json 里补上（或用对应参数传入）" }
}
function Do([string] $name) { $Level -eq 'all' -or $Level -eq $name }

# 删掉 frpc.toml 里 name = "pi-gateway" 的那一段（含段头上方的注释行）。
# 按行做：从该行回溯到所属 [[…]] 段头，往后到下一个段头之前；不会误伤其它段。
function Strip-FrpcSection([string] $path) {
    $lines = Get-Content $path
    $hit = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*name\s*=\s*"pi-gateway"') { $hit = $i; break }
    }
    if ($hit -lt 0) { return $false }
    $from = $hit
    while ($from -ge 0 -and $lines[$from] -notmatch '^\s*\[\[?') { $from-- }
    while ($from -ge 1 -and $lines[$from - 1] -match '^\s*#') { $from-- }
    $to = $hit
    while ($to + 1 -lt $lines.Count -and $lines[$to + 1] -notmatch '^\s*\[\[?') { $to++ }
    $kept = @()
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($i -lt $from -or $i -gt $to) { $kept += $lines[$i] } }
    Set-Content -Path $path -Value $kept -Encoding utf8
    Say "      已删除第 $($from + 1)-$($to + 1) 行"
    return $true
}

if ($SelfTest) {
    # 只在临时副本上跑删段逻辑：不碰真文件、不重启服务
    $tmp = Join-Path ([IO.Path]::GetTempPath()) 'frpc-selftest.toml'
    Copy-Item $FrpcToml $tmp -Force
    [void](Strip-FrpcSection $tmp)
    $txt = Get-Content $tmp -Raw
    Remove-Item $tmp -Force
    $gone = -not ($txt -match '(?m)^\s*name\s*=\s*"pi-gateway"')
    $others = ($txt -match 'serverAddr') -and ($txt -match '33333') -and ($txt -match '33334') -and ($txt -match '33335') -and ($txt -match '33389')
    $noLeft = -not ($txt -match '33336')
    Say "[selftest] pi-gateway 段已删=$gone 其它隧道完好=$others 无 33336 残留=$noLeft"
    if ($gone -and $others -and $noLeft) { Say '[selftest] PASS'; exit 0 } else { Say '[selftest] FAIL'; exit 1 }
}

Say "pi-gateway 回退（层级=$Level，$(if ($doit) { '实际执行' } else { '预览模式，加 -Yes 才真做' })）"

# ---------- 1. 网关服务 ----------
if (Do 'service') {
    Say '[service] 停掉并卸载 pi-gateway 服务（要管理员权限）'
    Run '停止服务' { sc.exe stop pi-gateway 2>&1 | Out-Host } 'sc.exe stop pi-gateway'
    Run '卸载服务' {
        if (-not (Test-Path $svcExe)) { throw "找不到 $svcExe" }
        & $svcExe uninstall | Out-Host
        Say '      如需继续用（不推荐长期），手动起：'
        Say '        node src/index.js --host 127.0.0.1 --port 33336（或 scripts/restart-gateway.ps1）'
    } "$svcExe uninstall"
    Run '确认状态' { sc.exe query pi-gateway 2>&1 | Out-Host } 'sc.exe query pi-gateway（应报服务名不存在）'
}

# ---------- 2. frp 隧道 ----------
if (Do 'frpc') {
    Say '[frpc] 去掉 gofrpc 里的 pi-gateway 隧道段（33336），只删这一段，其它隧道（33333/33334/33335/33389）不受影响'
    Run '改 frpc.toml' {
        if (-not (Test-Path $FrpcToml)) { throw "找不到 $FrpcToml" }
        $bak = "$FrpcToml.bak-rollback-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $FrpcToml $bak
        Say "      已备份到 $bak"
        # 删段逻辑在 Strip-FrpcSection；可先用 -SelfTest 在副本上验证
        if (Strip-FrpcSection $FrpcToml) { Say '      已删除 pi-gateway 段' } else { Say '      没找到 pi-gateway 段（可能已回退过）' }
        if ((Select-String -Path $FrpcToml -Pattern '^\s*name\s*=\s*"pi-gateway"')) { throw 'frpc.toml 里仍有 pi-gateway 段，请手工检查' }
    } "备份 $FrpcToml -> .bak-rollback-<时间戳>，删除 name=`"pi-gateway`" 段"
    Run '重启远程桌面服务（隧道会断几秒）' { Restart-Service remote-desktop; Start-Sleep -Seconds 3; (Get-Service remote-desktop).Status } 'Restart-Service remote-desktop'
}

# ---------- 3. 服务器 nginx ----------
if (Do 'nginx') {
    NeedServerTarget $NginxSite
    Say '[nginx] 还原 UI 站点（去掉 /pi/ 转发），校验通过才 reload，失败自动还原回当前版本'
    Run '还原站点' {
        Remote "set -e; test -f $NginxBak || { echo '备份不存在，不动'; exit 1; }; cp -a $NginxSite $NginxSite.bak-before-rollback-`(date +%Y%m%d-%H%M%S`)`; cp -a $NginxBak $NginxSite; grep -c 'location \^~ /pi/' $NginxSite || echo '站点里已无 /pi/ 块'" `
            "cp -a $NginxBak $NginxSite"
        Run 'nginx -t' {
            if (-not $NginxConf) { throw '缺少 server.nginxConf（nginx -t 要校验的主配置）' }
            $chk = Remote "$NginxBin -t -c $NginxConf"
            if ($LASTEXITCODE -ne 0) {
                Say '      配置校验失败，保持还原后的文件不动（备份里本来就是上线前的可用配置）'
                throw 'nginx -t 失败'
            }
        } "$NginxBin -t -c $NginxConf"
        Run 'reload' { Remote 'systemctl reload runtime-nginx.service; systemctl is-active runtime-nginx.service' } 'systemctl reload runtime-nginx.service'
    } 'ssh 还原 + 校验 + reload'
    Run '验证 /pi 已下线' {
        if (-not $PiHealthz) { throw '缺少 urls.piHealthz（验证 /pi 是否已下线的地址）' }
        $code = curl.exe -s -o NUL -w '%{http_code}' $PiHealthz
        Say "      $PiHealthz -> $code（404/405 = 已下线；200 = 还在，检查 nginx）"
    } 'curl /pi/healthz'
}

# ---------- 4. task_center 配置 ----------
if (Do 'center') {
    NeedServerTarget $CenterProps
    Say '[center] 去掉 pi.notify.token（微信通知入口失效），重启 task-center'
    Run '还原 application.properties' {
        Remote "set -e; test -f $CenterPropsBak || { echo '备份不存在，不动'; exit 1; }; cp -a $CenterProps $CenterProps.bak-before-rollback-`(date +%Y%m%d-%H%M%S`)`; cp -a $CenterPropsBak $CenterProps; grep -n '^pi.notify.token' $CenterProps || echo '已无 pi.notify.token'" `
            "cp -a $CenterPropsBak $CenterProps"
        Run '重启 task-center' { Remote 'systemctl restart task-center.service; sleep 8; systemctl is-active task-center.service' } 'systemctl restart task-center.service'
        Run '验证健康' {
            if (-not $CenterHealth) { throw '缺少 urls.centerHealth（健康检查地址）' }
            $code = curl.exe -s -o NUL -w '%{http_code}' $CenterHealth
            Say "      $CenterHealth -> $code"
        } 'curl /ui/api/health'
    } 'ssh 还原 + 重启 + 验证'
}

if (-not $doit) {
    Say ''
    Say '以上是预览。真的回退请加 -Yes（service 层级需要管理员权限的窗口）。'
} else {
    Say ''
    Say '回退完成。手机侧表现：/admin/#/pi 页面会显示「未连接」（不影响 admin 其它功能）。'
}

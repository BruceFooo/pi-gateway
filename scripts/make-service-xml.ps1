# 生成 WinSW 服务配置 service/pi-gateway.xml
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-service-xml.ps1
# 说明：pi-gateway 作为 Windows 服务跑在 LocalSystem 下，环境变量不会自动继承登录会话，
#       所以这里把「当前登录用户实际用的 PATH / TEMP / USERPROFILE」快照写进 XML。
#       以后 node / maven / npm 的 PATH 变了，重跑本脚本 + pi-gateway.exe reinstall 即可。
$ErrorActionPreference = 'Stop'
$pkg  = Split-Path -Parent $PSScriptRoot            # <本机工具根>\pi-gateway
$node = 'C:\node\aliases\default'                   # fnm 的稳定别名目录（当前 v24.19.0）
$user = $env:USERPROFILE                            # <用户主目录>

$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath    = [Environment]::GetEnvironmentVariable('Path', 'User')
# 服务态 PATH：node 在最前，其次是用户 PATH（npm 全局目录等），最后是系统 PATH
$svcPath = ($node, $userPath, $machinePath | Where-Object { $_ }) -join ';'

$xml = @"
<service>
  <id>pi-gateway</id>
  <name>Pi Gateway</name>
  <description>pi 手机控制台网关（127.0.0.1:33336，/pi/ws + /pi/media）。紧急回退：net stop pi-gateway; service\pi-gateway.exe uninstall; 再跑 scripts/restart-gateway.ps1 用手动方式起。</description>
  <executable>$node\node.exe</executable>
  <arguments>index.js</arguments>
  <workingdirectory>$pkg</workingdirectory>
  <env name="PATH" value="$svcPath"/>
  <env name="USERPROFILE" value="$user"/>
  <env name="HOME" value="$user"/>
  <env name="APPDATA" value="$user\AppData\Roaming"/>
  <env name="LOCALAPPDATA" value="$user\AppData\Local"/>
  <env name="TEMP" value="$user\AppData\Local\Temp"/>
  <env name="TMP" value="$user\AppData\Local\Temp"/>
  <startmode>Automatic</startmode>
  <logmode>reset</logmode>
  <logpath>$pkg\logs\service</logpath>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>20 sec</stoptimeout>
</service>
"@

$dir = Join-Path $pkg 'service'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$xmlPath = Join-Path $dir 'pi-gateway.xml'
[System.IO.File]::WriteAllText($xmlPath, $xml, (New-Object System.Text.UTF8Encoding($false)))
"WROTE $xmlPath"
"PATH(head)=$($svcPath.Substring(0, [Math]::Min(160, $svcPath.Length)))..."

$ErrorActionPreference = 'SilentlyContinue'
"MachinePath=" + [Environment]::GetEnvironmentVariable('Path', 'Machine')
"UserPath=" + [Environment]::GetEnvironmentVariable('Path', 'User')
"UserTemp=" + [Environment]::GetEnvironmentVariable('TEMP', 'User')
"UserTmp=" + [Environment]::GetEnvironmentVariable('TMP', 'User')
"NodeExe=" + (Get-Command node.exe).Source
"PiShim=" + (Get-Command pi).Source

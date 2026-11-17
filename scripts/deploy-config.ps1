# 部署清单读取器（PowerShell 侧）：真实域名/服务器路径/SSH 目标在 config/deploy.local.json，不入库。
# 用法：. "$PSScriptRoot\deploy-config.ps1"; $deploy = Get-DeployConfig; $deploy.ssh.host
function Get-DeployConfigPath {
    if ($env:PI_DEPLOY_CONFIG) { return $env:PI_DEPLOY_CONFIG }
    return Join-Path (Split-Path $PSScriptRoot -Parent) 'config\deploy.local.json'
}

function Get-DeployConfig {
    $path = Get-DeployConfigPath
    if (-not (Test-Path $path)) {
        $example = Join-Path (Split-Path $path -Parent) 'deploy.example.json'
        throw "找不到部署清单：$path`n请先复制 $example 为 $path 并填上真实域名/服务器路径（或用 -SshHost 等参数显式传入）。"
    }
    $cfg = Get-Content -Raw -Path $path | ConvertFrom-Json
    if ((ConvertTo-Json $cfg -Compress) -match 'CHANGE[-_]ME|your-domain\.example') {
        throw "$path 里还是示例占位值，先把真实值填进去再跑。"
    }
    return $cfg
}

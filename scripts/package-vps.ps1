param(
  [string]$OutputDir = "C:\Users\PC\Documents\Codex\2026-07-17\to\outputs"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$packageName = "web-bando-vps-$timestamp"
$stageRoot = Join-Path $root "build\vps-package"
$stage = Join-Path $stageRoot $packageName
$zipPath = Join-Path $OutputDir "$packageName.zip"

Set-Location $root
npm run build

if (Test-Path $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $stage | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "backend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "frontend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $stage "scripts") | Out-Null

Copy-Item -LiteralPath (Join-Path $root "backend\src") -Destination (Join-Path $stage "backend\src") -Recurse
Copy-Item -LiteralPath (Join-Path $root "frontend\dist") -Destination (Join-Path $stage "frontend\dist") -Recurse
Copy-Item -LiteralPath (Join-Path $root "scripts\import-game-servers-from-sql.mjs") -Destination (Join-Path $stage "scripts\import-game-servers-from-sql.mjs")
Copy-Item -LiteralPath (Join-Path $root "backend\.env.example") -Destination (Join-Path $stage ".env.example")
Copy-Item -LiteralPath (Join-Path $root "scripts\VPS_DEPLOY_README.md") -Destination (Join-Path $stage "README.md")

$backendPackage = Get-Content -Raw -LiteralPath (Join-Path $root "backend\package.json") | ConvertFrom-Json
$deployPackage = [ordered]@{
  name = "web-bando-vps"
  version = $backendPackage.version
  private = $true
  type = "module"
  scripts = [ordered]@{
    start = "node backend/src/index.js"
    "db:import-game-servers" = "node scripts/import-game-servers-from-sql.mjs"
  }
  dependencies = $backendPackage.dependencies
}
$deployPackage | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $stage "package.json") -Encoding UTF8

if (!(Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}
if (Test-Path $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
$packageItems = Get-ChildItem -LiteralPath $stage -Force
Compress-Archive -Path $packageItems.FullName -DestinationPath $zipPath -Force

Write-Host "Created VPS package: $zipPath"

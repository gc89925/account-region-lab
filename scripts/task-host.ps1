param([Parameter(Mandatory=$true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
& $NodePath (Join-Path $PSScriptRoot 'service.js')
exit $LASTEXITCODE

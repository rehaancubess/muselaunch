# Set KEY=VALUE in .env (creating .env from .env.example if needed), keeping every other line.
# Writes UTF-8 without a BOM so dotenv reads the first key correctly.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\set-env.ps1 KEY VALUE [-OnlyIfEmpty]
param(
  [Parameter(Mandatory = $true)][string]$Key,
  [Parameter(Mandatory = $true)][string]$Value,
  [switch]$OnlyIfEmpty,
  [string]$Path = ".env"
)
$full = Join-Path (Get-Location) $Path
if (-not (Test-Path $full)) { Copy-Item (Join-Path (Get-Location) ".env.example") $full }
$lines = [System.IO.File]::ReadAllLines($full)
$pattern = '^' + [regex]::Escape($Key) + '='
$found = $false
$out = foreach ($line in $lines) {
  if ($line -match $pattern) {
    $found = $true
    $current = $line.Substring($Key.Length + 1).Trim()
    if ($OnlyIfEmpty -and $current -ne '') { $line } else { "$Key=$Value" }
  } else { $line }
}
if (-not $found) { $out = @($out) + "$Key=$Value" }
[System.IO.File]::WriteAllLines($full, [string[]]$out)
Write-Host "  .env: $Key set"

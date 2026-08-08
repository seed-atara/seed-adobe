<#
.SYNOPSIS
  Builds the SEED / AE panel and installs it as an After Effects CEP extension.

.DESCRIPTION
  Two things have to be true for After Effects to load this panel:

    1. The extension folder lives in the per-user CEP extensions directory.
    2. CEP allows unsigned extensions (PlayerDebugMode), because this bundle
       is not signed with an Adobe certificate.

  This script does both, then tells you where to find the panel. Run it
  yourself — it writes to your registry (HKCU only) and your AppData.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File scripts/install-extension.ps1

.PARAMETER Uninstall
  Removes the installed extension. PlayerDebugMode is left alone, since other
  extensions may rely on it.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall,
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'

$BundleId = 'ai.seedstudios.seedae'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Source = Join-Path $RepoRoot 'apps/extension'
$Target = Join-Path $env:APPDATA "Adobe/CEP/extensions/$BundleId"

if ($Uninstall) {
    if (Test-Path $Target) {
        Remove-Item -Recurse -Force $Target
        Write-Host "Removed $Target"
    } else {
        Write-Host "Nothing installed at $Target"
    }
    return
}

# 1. Build the panel into apps/extension/panel.
if (-not $SkipBuild) {
    Write-Host 'Building the panel...'
    Push-Location $RepoRoot
    try {
        & npm run build --workspace '@seed-ae/panel' -- --outDir ../extension/panel --emptyOutDir
        if ($LASTEXITCODE -ne 0) { throw "panel build failed ($LASTEXITCODE)" }
    } finally {
        Pop-Location
    }
}

$builtIndex = Join-Path $Source 'panel/index.html'
if (-not (Test-Path $builtIndex)) {
    throw "No built panel at $builtIndex. Run without -SkipBuild."
}

# 2. Allow unsigned extensions. CEP reads a different key per major version,
#    so set every version After Effects might be using.
Write-Host 'Enabling PlayerDebugMode for CSXS 9-12...'
foreach ($version in 9..12) {
    $key = "HKCU:\Software\Adobe\CSXS.$version"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
}

# 3. Copy the extension into place.
if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
New-Item -ItemType Directory -Path $Target -Force | Out-Null
Copy-Item -Recurse -Force (Join-Path $Source '*') $Target

Write-Host ''
Write-Host "Installed to $Target"
Write-Host ''
Write-Host 'Next:'
Write-Host '  1. Start the SEED service:   npm run dev'
Write-Host '     (it prints a session token - copy it)'
Write-Host '  2. Restart After Effects.'
Write-Host '  3. Window > Extensions > SEED / AE'
Write-Host '  4. Paste the session token into the panel.'

[CmdletBinding()]
param(
    [string]$InstallDir,
    [string]$Manifest = "https://github.com/Kura-etnPL/SovereignBot/releases/latest/download/release-manifest.json",
    [string]$InstallerCore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "SovereignBot requires Node.js 22+ and 'node' was not found on PATH."
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $HOME }
    $InstallDir = Join-Path $base "SovereignBot"
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
$root = [System.IO.Path]::GetPathRoot($InstallDir)
if ($InstallDir.TrimEnd('\') -eq $root.TrimEnd('\')) {
    throw "Refusing to use a filesystem root as the install directory."
}

function Assert-NoReparsePoint([string]$Path, [string]$Label) {
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "$Label must not be a reparse point: $Path"
        }
    }
}

Assert-NoReparsePoint $InstallDir "Install directory"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Assert-NoReparsePoint $InstallDir "Install directory"

$bootstrapDir = Join-Path $InstallDir ".bootstrap"
Assert-NoReparsePoint $bootstrapDir "Bootstrap directory"
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Assert-NoReparsePoint $bootstrapDir "Bootstrap directory"

$downloadedCore = Join-Path $bootstrapDir "portable-install.mjs"
$downloadedManifest = Join-Path $bootstrapDir "release-manifest.json"
$corePath = $null
$manifestForHash = $null

try {
    if ($Manifest -match '^https://') {
        $manifestUri = [Uri]$Manifest
        if ($manifestUri.Scheme -ne 'https') {
            throw "Remote installer sources must use HTTPS."
        }
        Invoke-WebRequest -UseBasicParsing -Uri $manifestUri.AbsoluteUri -OutFile $downloadedManifest
        $manifestForHash = $downloadedManifest
    }
    else {
        $manifestForHash = (Resolve-Path -LiteralPath $Manifest).Path
    }

    if (-not [string]::IsNullOrWhiteSpace($InstallerCore)) {
        $corePath = (Resolve-Path -LiteralPath $InstallerCore).Path
    }
    elseif ($Manifest -match '^https://') {
        $manifestUri = [Uri]$Manifest
        $coreUri = [Uri]::new($manifestUri, "portable-install.mjs")
        if ($coreUri.Scheme -ne 'https') {
            throw "Remote installer core must use HTTPS."
        }
        Invoke-WebRequest -UseBasicParsing -Uri $coreUri.AbsoluteUri -OutFile $downloadedCore
        $corePath = $downloadedCore
    }
    else {
        $candidate = Join-Path (Split-Path -Parent $manifestForHash) "portable-install.mjs"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "portable-install.mjs was not found next to the local release manifest."
        }
        $corePath = $candidate
    }

    $releaseManifest = Get-Content -LiteralPath $manifestForHash -Raw | ConvertFrom-Json
    $coreEntry = @($releaseManifest.installers) | Where-Object { $_.file -eq "portable-install.mjs" } | Select-Object -First 1
    if ($null -eq $coreEntry -or [string]::IsNullOrWhiteSpace([string]$coreEntry.sha256) -or ([string]$coreEntry.sha256) -notmatch '^[0-9a-f]{64}$') {
        throw "Release manifest does not contain a valid portable-install.mjs SHA-256."
    }

    $actualHash = (Get-FileHash -LiteralPath $corePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$coreEntry.sha256).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "portable-install.mjs SHA-256 mismatch; refusing to execute installer core."
    }

    & node $corePath --install-dir $InstallDir --manifest $Manifest
    if ($LASTEXITCODE -ne 0) {
        throw "SovereignBot installer core exited with code $LASTEXITCODE."
    }
}
finally {
    if (Test-Path -LiteralPath $bootstrapDir) {
        $bootstrapItem = Get-Item -LiteralPath $bootstrapDir -Force
        if (($bootstrapItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            Remove-Item -LiteralPath $bootstrapDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

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

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$bootstrapDir = Join-Path $InstallDir ".bootstrap"
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
$downloadedCore = Join-Path $bootstrapDir "portable-install.mjs"
$corePath = $null

try {
    if (-not [string]::IsNullOrWhiteSpace($InstallerCore)) {
        $corePath = (Resolve-Path -LiteralPath $InstallerCore).Path
    }
    elseif ($Manifest -match '^https://') {
        $manifestUri = [Uri]$Manifest
        if ($manifestUri.Scheme -ne 'https') {
            throw "Remote installer sources must use HTTPS."
        }
        $coreUri = [Uri]::new($manifestUri, "portable-install.mjs")
        if ($coreUri.Scheme -ne 'https') {
            throw "Remote installer core must use HTTPS."
        }
        Invoke-WebRequest -UseBasicParsing -Uri $coreUri.AbsoluteUri -OutFile $downloadedCore
        $corePath = $downloadedCore
    }
    else {
        $manifestPath = (Resolve-Path -LiteralPath $Manifest).Path
        $candidate = Join-Path (Split-Path -Parent $manifestPath) "portable-install.mjs"
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw "portable-install.mjs was not found next to the local release manifest."
        }
        $corePath = $candidate
    }

    & node $corePath --install-dir $InstallDir --manifest $Manifest
    if ($LASTEXITCODE -ne 0) {
        throw "SovereignBot installer core exited with code $LASTEXITCODE."
    }
}
finally {
    Remove-Item -LiteralPath $bootstrapDir -Recurse -Force -ErrorAction SilentlyContinue
}

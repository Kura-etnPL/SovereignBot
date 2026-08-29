[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$project = if ($env:SOVEREIGNBOT_PROJECT) { $env:SOVEREIGNBOT_PROJECT } else { 'E:\Eternal\Auto_Empire\projects\SovereignBot' }
$stateDir = if ($env:SOVEREIGN_CONTROL_STATE_DIR) { $env:SOVEREIGN_CONTROL_STATE_DIR } else { 'E:\Eternal\Auto_Empire\runtime\sovereign-control' }
$liveWorktree = if ($env:SOVEREIGNBOT_LIVE_WORKTREE) { $env:SOVEREIGNBOT_LIVE_WORKTREE } else { 'E:\Eternal\Auto_Empire\worktrees\sovereign-s2-live' }
$runtimeBridge = Join-Path $stateDir 'bridge.mjs'
$stdoutLog = Join-Path $stateDir 'bridge.stdout.log'
$stderrLog = Join-Path $stateDir 'bridge.stderr.log'

function Resolve-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [string[]]$Candidates = @()
    )

    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source)) {
        return (Resolve-Path -LiteralPath $command.Source).Path
    }

    foreach ($candidate in $Candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Resolve-GitHubCli {
    if ($env:SOVEREIGN_CONTROL_GH) {
        if (-not (Test-Path -LiteralPath $env:SOVEREIGN_CONTROL_GH)) {
            throw "SOVEREIGN_CONTROL_GH points to a missing file: $($env:SOVEREIGN_CONTROL_GH)"
        }
        return (Resolve-Path -LiteralPath $env:SOVEREIGN_CONTROL_GH).Path
    }

    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe') }
    if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'GitHub CLI\gh.exe') }
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\GitHub CLI\gh.exe')
        $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\gh.exe')
    }
    if ($env:USERPROFILE) { $candidates += (Join-Path $env:USERPROFILE 'scoop\shims\gh.exe') }
    if ($env:ProgramData) { $candidates += (Join-Path $env:ProgramData 'chocolatey\bin\gh.exe') }

    $resolved = Resolve-ExecutablePath -Name 'gh.exe' -Candidates $candidates
    if ($resolved) { return $resolved }

    if ($env:LOCALAPPDATA) {
        $wingetRoot = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
        if (Test-Path -LiteralPath $wingetRoot) {
            $packageDirs = Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter 'GitHub.cli_*' -ErrorAction SilentlyContinue
            foreach ($dir in $packageDirs) {
                $match = Get-ChildItem -LiteralPath $dir.FullName -File -Filter 'gh.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($match) { return $match.FullName }
            }
        }
    }

    throw 'GitHub CLI gh.exe was not found. Install GitHub CLI or set SOVEREIGN_CONTROL_GH to the full gh.exe path.'
}

if (-not (Test-Path -LiteralPath $project)) {
    throw "SovereignBot project path does not exist: $project"
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

# Refresh only the remote main ref. Do not switch/reset the user checkout.
& git -C $project fetch origin main
if ($LASTEXITCODE -ne 0) { throw 'git fetch origin main failed' }

# Run the bridge from the current remote main even if the local checkout is older.
$bridgeText = & git -C $project show 'origin/main:tools/local-control/bridge.mjs'
if ($LASTEXITCODE -ne 0 -or -not $bridgeText) { throw 'could not read tools/local-control/bridge.mjs from origin/main' }
$bridgeText | Set-Content -LiteralPath $runtimeBridge -Encoding utf8

$gh = Resolve-GitHubCli
$node = Resolve-ExecutablePath -Name 'node.exe'
if (-not $node) { throw 'node.exe was not found in PATH' }

# The bridge intentionally calls `gh` without a shell. Make gh visible only to this
# process tree instead of changing the machine/user PATH.
$ghDir = Split-Path -Parent $gh
$env:Path = "$ghDir;$($env:Path)"
$env:SOVEREIGN_CONTROL_GH = $gh
$env:SOVEREIGNBOT_PROJECT = $project
$env:SOVEREIGN_CONTROL_STATE_DIR = $stateDir
$env:SOVEREIGNBOT_LIVE_WORKTREE = $liveWorktree

$needle = [Regex]::Escape($runtimeBridge)
$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $needle }

if ($existing) {
    $existing | Select-Object ProcessId, CommandLine
    Write-Host "[sovereign-local] bridge already running: $runtimeBridge"
    exit 0
}

Set-Content -LiteralPath $stdoutLog -Value '' -Encoding utf8
Set-Content -LiteralPath $stderrLog -Value '' -Encoding utf8

Start-Process `
    -FilePath $node `
    -ArgumentList @("`"$runtimeBridge`"") `
    -WorkingDirectory $project `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog `
    -WindowStyle Hidden

Start-Sleep -Seconds 3

$running = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match $needle }

if (-not $running) {
    $stderr = if (Test-Path -LiteralPath $stderrLog) { (Get-Content -LiteralPath $stderrLog -Tail 80) -join [Environment]::NewLine } else { '' }
    throw "Sovereign Local Control Bridge exited during startup.`n$stderr"
}

$running | Select-Object ProcessId, CommandLine
Write-Host "[sovereign-local] ready-check pending; gh=$gh"
Write-Host "[sovereign-local] stdout=$stdoutLog"
Write-Host "[sovereign-local] stderr=$stderrLog"

<# SovereignBot live desktop capture - strictly bound to sovereign-v3-live, near-black aware with exact-window CopyFromScreen fallback #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$liveRoot = $env:SOVEREIGNBOT_LIVE_WORKTREE
if ([string]::IsNullOrWhiteSpace($liveRoot)) { $liveRoot = 'E:\Eternal\Auto_Empire\worktrees\sovereign-v3-live' }
$liveRoot = $liveRoot.TrimEnd('\','/')
$targetExe = Join-Path $liveRoot 'desktop\node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $targetExe)) { throw "target electron not found: $targetExe (SOVEREIGNBOT_LIVE_WORKTREE=$liveRoot)" }
if ($targetExe -like '*\projects\SovereignBot\*') { throw "prohibited source: $targetExe matches old projects path" }

$cands = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -eq $targetExe) }
if (-not $cands) { throw "no live electron with Path == $targetExe" }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WCap2 {
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@

Add-Type -AssemblyName System.Drawing

$SW_RESTORE = 9

function Get-TargetRect([IntPtr]$hWnd) {
  $rect = New-Object WCap2+RECT
  $got = $false
  try {
    $hr = [WCap2]::DwmGetWindowAttribute($hWnd, 9, [ref]$rect, [Runtime.InteropServices.Marshal]::SizeOf($rect))
    if ($hr -eq 0) { $got = $true }
  } catch {}
  if (-not $got) { [void][WCap2]::GetWindowRect($hWnd, [ref]$rect) }
  return $rect
}

function Test-NearBlack([System.Drawing.Bitmap]$bmp) {
  if (-not $bmp) { return $true }
  $w = $bmp.Width; $h = $bmp.Height
  if ($w -le 0 -or $h -le 0) { return $true }
  # sample ~100 points evenly
  $samples = 0; $dark = 0; $sum = 0
  $stepX = [Math]::Max(1, [int]($w / 12))
  $stepY = [Math]::Max(1, [int]($h / 12))
  for ($y = [int]($stepY/2); $y -lt $h; $y += $stepY) {
    for ($x = [int]($stepX/2); $x -lt $w; $x += $stepX) {
      $c = $bmp.GetPixel($x, $y)
      $brightness = ($c.R + $c.G + $c.B) / 3.0
      $sum += $brightness
      $samples++
      if ($brightness -lt 18) { $dark++ }
    }
  }
  if ($samples -eq 0) { return $true }
  $avg = $sum / $samples
  $darkRatio = $dark / [double]$samples
  # near-black if avg very low or overwhelming majority dark
  if ($avg -lt 14 -or $darkRatio -gt 0.96) { return $true }
  if ($avg -lt 22 -and $darkRatio -gt 0.92) { return $true }
  return $false
}

function Convert-ToJpegBase64([System.Drawing.Bitmap]$srcBmp, [int]$maxW, [int]$quality) {
  $srcW = $srcBmp.Width; $srcH = $srcBmp.Height
  $scaledW = $srcW; $scaledH = $srcH
  if ($srcW -gt $maxW) { $scaledW = $maxW; $scaledH = [int]([math]::Round($srcH * ($maxW / [double]$srcW))) }
  $dstBmp = $null; $g2 = $null
  try {
    $dstBmp = New-Object System.Drawing.Bitmap $scaledW, $scaledH
    $g2 = [System.Drawing.Graphics]::FromImage($dstBmp)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g2.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g2.DrawImage($srcBmp, 0, 0, $scaledW, $scaledH)
    $ms = New-Object System.IO.MemoryStream
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $encParams = New-Object System.Drawing.Imaging.EncoderParameters 1
    $encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$quality)
    $dstBmp.Save($ms, $codec, $encParams)
    $bytes = $ms.ToArray(); $ms.Dispose()
    $b64 = [Convert]::ToBase64String($bytes)
    return @{ base64 = $b64; width = $scaledW; height = $scaledH }
  } finally {
    if ($g2) { try { $g2.Dispose() } catch {} }
    if ($dstBmp) { try { $dstBmp.Dispose() } catch {} }
  }
}

# Build candidate list: MainWindowHandle !=0 and IsWindowVisible == true
$candidates = @()
foreach ($c in $cands) {
  $proc = $null
  try { $proc = Get-Process -Id $c.ProcessId -ErrorAction Stop } catch { continue }
  $h = $proc.MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { continue }
  if (-not [WCap2]::IsWindowVisible($h)) { continue }
  $rect = Get-TargetRect $h
  $w = $rect.Right - $rect.Left; $ht = $rect.Bottom - $rect.Top
  if ($w -lt 400 -or $ht -lt 300) { continue }
  $sb = New-Object System.Text.StringBuilder 512; [void][WCap2]::GetWindowText($h, $sb, 512); $title = $sb.ToString()
  $candidates += [PSCustomObject]@{ pid = [int]$c.ProcessId; hWnd = $h; title = $title; rect = $rect; width = $w; height = $ht }
}
if ($candidates.Count -eq 0) { throw "no visible live Electron window (MainWindowHandle+IsWindowVisible) for $targetExe" }
# Prefer largest area first, but keep deterministic
$candidates = $candidates | Sort-Object { $_.width * $_.height } -Descending

$lastError = $null
foreach ($cand in $candidates) {
  $hWnd = $cand.hWnd; $candidatePid = $cand.pid
  try {
    if ([WCap2]::IsIconic($hWnd)) { [void][WCap2]::ShowWindow($hWnd, $SW_RESTORE) }
    $rect = Get-TargetRect $hWnd
    $srcW = $rect.Right - $rect.Left; $srcH = $rect.Bottom - $rect.Top
    if ($srcW -lt 400 -or $srcH -lt 300) { throw "window rect too small ${srcW}x${srcH} for pid $candidatePid" }
    $titleNowSb = New-Object System.Text.StringBuilder 512; [void][WCap2]::GetWindowText($hWnd, $titleNowSb, 512); $titleNow = $titleNowSb.ToString()

    # --- Attempt 1: PrintWindow ---
    $printBmp = $null; $g = $null; $hdc = [IntPtr]::Zero
    $printedNearBlack = $true
    $printOk = $false
    try {
      $printBmp = New-Object System.Drawing.Bitmap $srcW, $srcH
      $g = [System.Drawing.Graphics]::FromImage($printBmp)
      $hdc = $g.GetHdc()
      $ok = [WCap2]::PrintWindow($hWnd, $hdc, 0)
      if (-not $ok) { $ok = [WCap2]::PrintWindow($hWnd, $hdc, 2) }
      $g.ReleaseHdc($hdc); $hdc = [IntPtr]::Zero; $g.Dispose(); $g = $null
      $printOk = $ok
      if ($ok) {
        $printedNearBlack = Test-NearBlack $printBmp
      }
    } catch {
      $printOk = $false; $printedNearBlack = $true
      if ($hdc -ne [IntPtr]::Zero -and $g) { try { $g.ReleaseHdc($hdc) } catch {}; $hdc = [IntPtr]::Zero }
      if ($g) { try { $g.Dispose() } catch {}; $g = $null }
    } finally {
      if ($hdc -ne [IntPtr]::Zero -and $g) { try { $g.ReleaseHdc($hdc) } catch {} }
      if ($g) { try { $g.Dispose() } catch {} }
    }

    if ($printOk -and -not $printedNearBlack) {
      # Encode with quality stepping to fit mailbox
      $attempts = @(
        @{ maxW = 600; q = 50 }, @{ maxW = 600; q = 42 },
        @{ maxW = 520; q = 42 }, @{ maxW = 520; q = 35 },
        @{ maxW = 440; q = 35 }
      )
      foreach ($a in $attempts) {
        $enc = Convert-ToJpegBase64 $printBmp $a.maxW $a.q
        if ($enc.base64.Length -le 36000 * 1.2) {
          if ($printBmp) { try { $printBmp.Dispose() } catch {} }
          $out = [ordered]@{
            processId     = [int]$candidatePid
            title         = [string]$titleNow
            windowWidth   = [int]$srcW
            windowHeight  = [int]$srcH
            captureWidth  = [int]$enc.width
            captureHeight = [int]$enc.height
            width         = [int]$enc.width
            height        = [int]$enc.height
            captureMethod = 'PrintWindow'
            sourceRoot    = [string]$liveRoot
            mimeType      = 'image/jpeg'
            data          = [string]$enc.base64
            capturedAt    = [string]([DateTime]::UtcNow.ToString('o'))
          }
          [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
          exit 0
        }
      }
      if ($printBmp) { try { $printBmp.Dispose() } catch {} }
      throw "PrintWindow frame valid but all JPEG size attempts exceed mailbox limit for pid $candidatePid"
    }

    # PrintWindow was near-black or failed -> fallback to exact-window CopyFromScreen
    if ($printBmp) { try { $printBmp.Dispose() } catch {}; $printBmp = $null }
    $origFg = [WCap2]::GetForegroundWindow()
    try { [void][WCap2]::ShowWindow($hWnd, $SW_RESTORE) } catch {}
    try { [void][WCap2]::SetForegroundWindow($hWnd) } catch {}
    Start-Sleep -Milliseconds 250
    # Re-read rect after restore/foreground (DWM may have adjusted)
    $rect2 = Get-TargetRect $hWnd
    $srcW2 = $rect2.Right - $rect2.Left; $srcH2 = $rect2.Bottom - $rect2.Top
    if ($srcW2 -lt 400 -or $srcH2 -lt 300) { throw "CopyFromScreen rect too small after restore ${srcW2}x${srcH2} pid $candidatePid" }
    $screenBmp = $null
    try {
      $screenBmp = New-Object System.Drawing.Bitmap $srcW2, $srcH2
      $g3 = [System.Drawing.Graphics]::FromImage($screenBmp)
      # exact-window copy only
      $g3.CopyFromScreen($rect2.Left, $rect2.Top, 0, 0, (New-Object System.Drawing.Size $srcW2, $srcH2))
      $g3.Dispose()
      if (Test-NearBlack $screenBmp) { throw "CopyFromScreen still near-black for pid $candidatePid hWnd=$hWnd" }
      $attempts2 = @(
        @{ maxW = 600; q = 50 }, @{ maxW = 600; q = 42 },
        @{ maxW = 520; q = 42 }, @{ maxW = 520; q = 35 },
        @{ maxW = 440; q = 35 }
      )
      foreach ($a in $attempts2) {
        $enc2 = Convert-ToJpegBase64 $screenBmp $a.maxW $a.q
        if ($enc2.base64.Length -le 36000 * 1.2) {
          $titleNow2Sb = New-Object System.Text.StringBuilder 512; [void][WCap2]::GetWindowText($hWnd, $titleNow2Sb, 512); $titleNow2 = $titleNow2Sb.ToString()
          try { if ($origFg -ne [IntPtr]::Zero) { [void][WCap2]::SetForegroundWindow($origFg) } } catch {}
          $out2 = [ordered]@{
            processId     = [int]$candidatePid
            title         = [string]$titleNow2
            windowWidth   = [int]$srcW2
            windowHeight  = [int]$srcH2
            captureWidth  = [int]$enc2.width
            captureHeight = [int]$enc2.height
            width         = [int]$enc2.width
            height        = [int]$enc2.height
            captureMethod = 'CopyFromScreen'
            sourceRoot    = [string]$liveRoot
            mimeType      = 'image/jpeg'
            data          = [string]$enc2.base64
            capturedAt    = [string]([DateTime]::UtcNow.ToString('o'))
          }
          [Console]::Out.WriteLine(($out2 | ConvertTo-Json -Compress))
          if ($screenBmp) { try { $screenBmp.Dispose() } catch {} }
          exit 0
        }
      }
      throw "CopyFromScreen valid but all JPEG size attempts exceed mailbox limit for pid $candidatePid"
    } finally {
      if ($screenBmp) { try { $screenBmp.Dispose() } catch {} }
      try { if ($origFg -ne [IntPtr]::Zero) { [void][WCap2]::SetForegroundWindow($origFg) } } catch {}
    }
  } catch {
    $lastError = $_
    continue
  }
}
throw "all live visible candidates failed; last error: $lastError"

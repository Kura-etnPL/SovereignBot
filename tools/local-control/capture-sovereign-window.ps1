param()

$ErrorActionPreference = 'Stop'
$project = $env:SOVEREIGNBOT_PROJECT
if ([string]::IsNullOrWhiteSpace($project)) {
    $project = 'E:\Eternal\Auto_Empire\projects\SovereignBot'
}
$expectedExe = [System.IO.Path]::GetFullPath((Join-Path $project 'desktop\node_modules\electron\dist\electron.exe'))

$process = Get-Process -Name electron -ErrorAction SilentlyContinue |
    Where-Object {
        $_.MainWindowHandle -ne 0 -and
        $_.Path -and
        ([System.IO.Path]::GetFullPath($_.Path) -ieq $expectedExe)
    } |
    Select-Object -First 1

if (-not $process) {
    throw 'No visible SovereignBot Electron window was found for the configured project.'
}

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SovereignWindowCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
}
'@

$rect = New-Object SovereignWindowCapture+RECT
if (-not [SovereignWindowCapture]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw 'GetWindowRect failed for SovereignBot.'
}
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
if ($width -gt 6000 -or $height -gt 4000) {
    throw 'SovereignBot window dimensions are implausible.'
}

$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
    $ok = [SovereignWindowCapture]::PrintWindow($process.MainWindowHandle, $hdc, 2)
}
finally {
    $graphics.ReleaseHdc($hdc)
    $graphics.Dispose()
}
if (-not $ok) {
    $bitmap.Dispose()
    throw 'PrintWindow failed for SovereignBot.'
}

$targetWidth = [Math]::Min(420, $width)
$targetHeight = [Math]::Max(1, [int][Math]::Round($height * ($targetWidth / [double]$width)))
$thumb = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
$draw = [System.Drawing.Graphics]::FromImage($thumb)
try {
    $draw.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
}
finally {
    $draw.Dispose()
    $bitmap.Dispose()
}

$stream = New-Object System.IO.MemoryStream
try {
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq 'image/jpeg' | Select-Object -First 1
    $parameters = New-Object System.Drawing.Imaging.EncoderParameters 1
    $parameters.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]35)
    $thumb.Save($stream, $codec, $parameters)
    $base64 = [Convert]::ToBase64String($stream.ToArray())
}
finally {
    $thumb.Dispose()
    $stream.Dispose()
}

if ($base64.Length -gt 36000) {
    throw 'SovereignBot QA thumbnail exceeded the private mailbox size budget.'
}

[ordered]@{
    processId = $process.Id
    title = $process.MainWindowTitle
    width = $width
    height = $height
    mimeType = 'image/jpeg'
    data = $base64
    capturedAt = [DateTime]::UtcNow.ToString('o')
} | ConvertTo-Json -Compress

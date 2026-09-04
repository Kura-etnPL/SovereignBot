Add-Type -AssemblyName System.Drawing

$sourcePath = "C:\Users\Eternal\.gemini\antigravity\brain\1cd9e1c6-aa10-407b-912f-21ab6370976d\sovereignbot_icon_1788486171714.jpg"
$outputPng = "E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention\desktop\resources\icon.png"
$outputIco = "E:\Eternal\Auto_Empire\projects\SovereignBot-luna-attention\desktop\resources\icon.ico"

$src = [System.Drawing.Bitmap]::FromFile($sourcePath)
$w = $src.Width
$h = $src.Height
Write-Host "Source image size: $w x $h"

# Find bounds of the mint glow rim.
$midY = [int]($h / 2)
$left = -1
$right = -1
for ($x = 0; $x -lt $w; $x++) {
    $c = $src.GetPixel($x, $midY)
    if ($c.G -gt 150 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B - 20)) {
        if ($left -eq -1) { $left = $x }
        $right = $x
    }
}

$midX = [int]($w / 2)
$top = -1
$bottom = -1
for ($y = 0; $y -lt $h; $y++) {
    $c = $src.GetPixel($midX, $y)
    if ($c.G -gt 150 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B - 20)) {
        if ($top -eq -1) { $top = $y }
        $bottom = $y
    }
}

Write-Host "Detected rim bounds: left=$left, right=$right, top=$top, bottom=$bottom"
$boxW = $right - $left
$boxH = $bottom - $top
Write-Host "Squircle size: $boxW x $boxH"

$margin = 28
$cropX = [Math]::Max(0, $left - $margin)
$cropY = [Math]::Max(0, $top - $margin)
$cropW = [Math]::Min($w - $cropX, $boxW + ($margin * 2))
$cropH = [Math]::Min($h - $cropY, $boxH + ($margin * 2))

$cropDim = [Math]::Max($cropW, $cropH)
$centerX = [int](($left + $right) / 2)
$centerY = [int](($top + $bottom) / 2)
$cropX = [Math]::Max(0, $centerX - [int]($cropDim / 2))
$cropY = [Math]::Max(0, $centerY - [int]($cropDim / 2))
if ($cropX + $cropDim -gt $w) { $cropDim = $w - $cropX }
if ($cropY + $cropDim -gt $h) { $cropDim = $h - $cropY }

Write-Host "Cropping square region: ($cropX, $cropY) with size ${cropDim}x${cropDim}"

$finalSize = 512
$targetBmp = New-Object System.Drawing.Bitmap $finalSize, $finalSize, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($targetBmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$srcRect = New-Object System.Drawing.Rectangle $cropX, $cropY, $cropDim, $cropDim
$destRect = New-Object System.Drawing.Rectangle 0, 0, $finalSize, $finalSize
$g.DrawImage($src, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)

$g.Dispose()
$src.Dispose()

[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($outputPng)) | Out-Null
$targetBmp.Save($outputPng, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Saved high-res PNG to $outputPng"

$sizes = @(256, 128, 64, 48, 32, 16)
$pngDataList = @()

foreach ($s in $sizes) {
    $subBmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $sg = [System.Drawing.Graphics]::FromImage($subBmp)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $sg.Clear([System.Drawing.Color]::Transparent)
    $sg.DrawImage($targetBmp, 0, 0, $s, $s)
    $sg.Dispose()
    
    $ms = New-Object System.IO.MemoryStream
    $subBmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes = $ms.ToArray()
    $ms.Dispose()
    $subBmp.Dispose()
    $pngDataList += ,@($s, $pngBytes)
}

$icoStream = [System.IO.File]::Create($outputIco)
$writer = New-Object System.IO.BinaryWriter $icoStream

$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$sizes.Count)

$offset = 6 + (16 * $sizes.Count)

foreach ($entry in $pngDataList) {
    $dim = $entry[0]
    $data = $entry[1]
    
    $wByte = if ($dim -ge 256) { [byte]0 } else { [byte]$dim }
    $hByte = if ($dim -ge 256) { [byte]0 } else { [byte]$dim }
    
    $writer.Write($wByte)
    $writer.Write($hByte)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]32)
    $writer.Write([UInt32]$data.Length)
    $writer.Write([UInt32]$offset)
    
    $offset += $data.Length
}

foreach ($entry in $pngDataList) {
    $writer.Write($entry[1])
}

$writer.Flush()
$writer.Close()
$targetBmp.Dispose()

Write-Host "Generated multi-resolution ICO at: $outputIco"

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = Split-Path -Parent $PSScriptRoot
$artPath = Join-Path $projectRoot 'assets/branding/app-icon.png'
$foregroundPath = Join-Path $projectRoot 'assets/branding/app-icon-foreground.png'
$resourceRoot = Join-Path $projectRoot 'android/app/src/main/res'

function Save-ScaledImage($Source, [int]$Size, [string]$Destination, [int]$Inset = 0) {
    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $attributes = [System.Drawing.Imaging.ImageAttributes]::new()
        try {
            $attributes.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
            $rectangle = [System.Drawing.Rectangle]::new($Inset, $Inset, $Size - 2 * $Inset, $Size - 2 * $Inset)
            $graphics.DrawImage($Source, $rectangle, 0, 0, $Source.Width, $Source.Height, [System.Drawing.GraphicsUnit]::Pixel, $attributes)
        } finally { $attributes.Dispose() }
        [System.IO.Directory]::CreateDirectory((Split-Path -Parent $Destination)) | Out-Null
        $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}

$art = [System.Drawing.Image]::FromFile($artPath)
$foreground = [System.Drawing.Bitmap]::new($foregroundPath)
try {
    if ($foreground.GetPixel(0, 0).A -ne 0 -or $foreground.GetPixel([int]($foreground.Width / 2), [int]($foreground.Height / 2)).A -lt 250) {
        throw 'The adaptive foreground must have real transparent corners and an opaque character.'
    }
    # 108 dp at 4x; keep the character inside the central 66 dp safe area.
    Save-ScaledImage $foreground 432 (Join-Path $resourceRoot 'drawable-nodpi/ic_launcher_foreground_art.png') 84
    $mono = [System.Drawing.Bitmap]::new(432, 432, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $scaled = [System.Drawing.Bitmap]::new((Join-Path $resourceRoot 'drawable-nodpi/ic_launcher_foreground_art.png'))
    try {
        for ($y = 0; $y -lt 432; $y++) {
            for ($x = 0; $x -lt 432; $x++) {
                $pixel = $scaled.GetPixel($x, $y)
                $luminance = 0.2126 * $pixel.R + 0.7152 * $pixel.G + 0.0722 * $pixel.B
                if ($pixel.A -gt 0 -and $luminance -lt 145) {
                    $mono.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($pixel.A, 0, 0, 0))
                }
            }
        }
        $mono.Save((Join-Path $resourceRoot 'drawable-nodpi/ic_launcher_monochrome_art.png'), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $scaled.Dispose(); $mono.Dispose() }
    Save-ScaledImage $art 96 (Join-Path $projectRoot 'assets/branding/favicon.png')
} finally { $foreground.Dispose(); $art.Dispose() }
Write-Output 'Generated adaptive foreground and monochrome layers, and the favicon.'

# Ambient — icon pipeline.
#
# Turns resources/logo.png (the full-bleed artwork: a rounded tile on a white ground with a
# soft shadow) into the files the app ships: the installer/window icon, the tray icon, and
# the mark the dashboard's sidebar shows. The tile is found by its dark pixels, cropped, cut
# to a rounded square with transparent corners, and resampled. No image tooling beyond
# System.Drawing, which every Windows PowerShell has.
#
#   npm run icons
#   powershell -File scripts/make-icons.ps1 [-Source resources/logo.png]

param(
    [string]$Source = "resources/logo.png",
    # Corner radius as a fraction of the tile's side. The artwork's own corners are close to
    # this; a little tighter hides the shadow that bleeds past them.
    [double]$Corner = 0.19,
    # How far inside the detected tile to crop, as a fraction of its side, so the pale rim
    # where the artwork fades into its shadow is left behind.
    [double]$Inset = 0.015
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root $Source
if (-not (Test-Path $sourcePath)) { throw "make-icons: $sourcePath is missing." }

$src = [System.Drawing.Bitmap]::new($sourcePath)
try {
    # Bounding box of the tile: anything clearly darker than the white ground. The shadow is
    # light enough to fall outside this threshold, so the box hugs the tile itself.
    $minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
    $step = [Math]::Max(1, [int]($src.Width / 400))
    for ($y = 0; $y -lt $src.Height; $y += $step) {
        for ($x = 0; $x -lt $src.Width; $x += $step) {
            $p = $src.GetPixel($x, $y)
            $lum = (0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
            if ($lum -lt 140) {
                if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
                if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }
    if ($maxX -lt 0) { throw "make-icons: no tile found in $Source." }
    # Square it up around the centre; the tile is square by design.
    $side = [Math]::Max($maxX - $minX, $maxY - $minY) + $step
    $cx = ($minX + $maxX) / 2.0; $cy = ($minY + $maxY) / 2.0
    $left = [int][Math]::Round($cx - $side / 2.0); $top = [int][Math]::Round($cy - $side / 2.0)
    Write-Host ("make-icons: tile {0}x{0} at ({1},{2}) in {3}x{4}" -f $side, $left, $top, $src.Width, $src.Height)

    function Render([int]$Size, [double]$Padding, [string]$Out) {
        $bmp = [System.Drawing.Bitmap]::new($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
            $g.Clear([System.Drawing.Color]::Transparent)
            $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
            $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
            $pad = $Size * $Padding
            $inner = $Size - 2 * $pad
            $r = $inner * $Corner
            $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
            $d = 2 * $r
            $path.AddArc($pad, $pad, $d, $d, 180, 90)
            $path.AddArc($pad + $inner - $d, $pad, $d, $d, 270, 90)
            $path.AddArc($pad + $inner - $d, $pad + $inner - $d, $d, $d, 0, 90)
            $path.AddArc($pad, $pad + $inner - $d, $d, $d, 90, 90)
            $path.CloseFigure()
            $g.SetClip($path)
            $dest = [System.Drawing.RectangleF]::new($pad, $pad, $inner, $inner)
            $trim = $side * $Inset
            $srcRect = [System.Drawing.RectangleF]::new($left + $trim, $top + $trim, $side - 2 * $trim, $side - 2 * $trim)
            $g.DrawImage($src, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        } finally { $g.Dispose() }
        $outPath = Join-Path $root $Out
        New-Item -ItemType Directory -Force (Split-Path -Parent $outPath) | Out-Null
        $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host ("make-icons: wrote {0} ({1}px)" -f $Out, $Size)
    }

    Render 512 0.0 "resources/icon.png"
    Render 32 0.0 "resources/tray.png"
    Render 128 0.0 "public/brand/ambient-mark.png"
} finally {
    $src.Dispose()
}

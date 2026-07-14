param(
  [string]$SourcePath = (Join-Path $PSScriptRoot "..\public\morphly-logo.png")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$source = [IO.Path]::GetFullPath($SourcePath)
$publicRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\public"))

if (-not $source.StartsWith($publicRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The source image must be inside the dashboard public directory."
}
if (-not (Test-Path -LiteralPath $source)) {
  throw "Brand source image not found: $source"
}

$variants = @(
  @{ Size = 16; Name = "morphly-icon-16.png" },
  @{ Size = 32; Name = "morphly-icon-32.png" },
  @{ Size = 48; Name = "morphly-icon-48.png" },
  @{ Size = 180; Name = "apple-touch-icon.png" },
  @{ Size = 192; Name = "morphly-icon-192.png" },
  @{ Size = 512; Name = "morphly-icon-512.png" }
)

$image = [Drawing.Image]::FromFile($source)
try {
  if ($image.Width -ne $image.Height) {
    throw "The Morphly brand source must be square."
  }

  foreach ($variant in $variants) {
    $size = [int]$variant.Size
    $target = [IO.Path]::GetFullPath((Join-Path $publicRoot $variant.Name))
    if (-not $target.StartsWith($publicRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Generated icon path escaped the public directory."
    }

    $bitmap = New-Object Drawing.Bitmap $size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $bitmap.SetResolution(96, 96)
      $graphics = [Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CompositingMode = [Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($image, 0, 0, $size, $size)
      }
      finally {
        $graphics.Dispose()
      }
      $bitmap.Save($target, [Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
      $bitmap.Dispose()
    }
  }
}
finally {
  $image.Dispose()
}

$variants | ForEach-Object {
  $path = Join-Path $publicRoot $_.Name
  [pscustomobject]@{
    Name = $_.Name
    Size = $_.Size
    Bytes = (Get-Item -LiteralPath $path).Length
  }
}

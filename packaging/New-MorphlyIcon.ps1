[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$variants = @(
    @{ Size = 16; Name = "morphly-icon-16.png" },
    @{ Size = 32; Name = "morphly-icon-32.png" },
    @{ Size = 48; Name = "morphly-icon-48.png" },
    @{ Size = 192; Name = "morphly-icon-192.png" }
)

$sourceRoot = (Resolve-Path -LiteralPath $SourceDirectory).Path
$outputFullPath = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $outputFullPath) {
    throw "Refusing to overwrite an existing icon: $outputFullPath"
}

$images = New-Object System.Collections.Generic.List[object]
foreach ($variant in $variants) {
    $path = Join-Path $sourceRoot $variant.Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Morphly icon source is missing: $path"
    }

    [byte[]]$bytes = [IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 24 -or
        $bytes[0] -ne 0x89 -or $bytes[1] -ne 0x50 -or
        $bytes[2] -ne 0x4E -or $bytes[3] -ne 0x47) {
        throw "Morphly icon source is not a valid PNG: $path"
    }

    $width = [int](
        ([uint32]$bytes[16] -shl 24) -bor
        ([uint32]$bytes[17] -shl 16) -bor
        ([uint32]$bytes[18] -shl 8) -bor
        [uint32]$bytes[19]
    )
    $height = [int](
        ([uint32]$bytes[20] -shl 24) -bor
        ([uint32]$bytes[21] -shl 16) -bor
        ([uint32]$bytes[22] -shl 8) -bor
        [uint32]$bytes[23]
    )
    if ($width -ne [int]$variant.Size -or $height -ne [int]$variant.Size) {
        throw "Morphly icon source has dimensions ${width}x${height}; expected $($variant.Size)x$($variant.Size): $path"
    }

    $images.Add([pscustomobject]@{
        Size = [int]$variant.Size
        Bytes = $bytes
    })
}

$outputDirectory = Split-Path -Parent $outputFullPath
if (-not (Test-Path -LiteralPath $outputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
}

$stream = New-Object IO.FileStream($outputFullPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
$writer = New-Object IO.BinaryWriter($stream)
try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$images.Count)

    [uint32]$imageOffset = 6 + (16 * $images.Count)
    foreach ($image in $images) {
        $writer.Write([byte]$image.Size)
        $writer.Write([byte]$image.Size)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]32)
        $writer.Write([uint32]$image.Bytes.Length)
        $writer.Write([uint32]$imageOffset)
        $imageOffset += [uint32]$image.Bytes.Length
    }

    foreach ($image in $images) {
        $writer.Write([byte[]]$image.Bytes)
    }
} finally {
    $writer.Dispose()
    $stream.Dispose()
}

Write-Host "Created Morphly Windows icon: $outputFullPath"

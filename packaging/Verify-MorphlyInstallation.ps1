[CmdletBinding()]
param(
    [string]$ApplicationRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $ApplicationRoot) {
    $ApplicationRoot = $PSScriptRoot
}
$root = (Resolve-Path -LiteralPath $ApplicationRoot).Path
$rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$beatriceBaseLibraryPath = Join-Path $root "engines\beatrice-v2\_internal\base_library.zip"
if (-not (Test-Path -LiteralPath $beatriceBaseLibraryPath -PathType Leaf)) {
    throw "Beatrice embedded Python standard library is missing: $beatriceBaseLibraryPath"
}

$checksumPath = Join-Path $root "checksums.sha256"
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "Checksum manifest is missing: $checksumPath"
}

$failures = New-Object System.Collections.Generic.List[string]
$verified = 0
foreach ($line in Get-Content -LiteralPath $checksumPath -Encoding UTF8) {
    if (-not $line.Trim()) {
        continue
    }
    if ($line -notmatch '^([A-Fa-f0-9]{64}) \*(.+)$') {
        $failures.Add("Malformed checksum line: $line")
        continue
    }

    $expected = $matches[1].ToUpperInvariant()
    $relativePath = $matches[2].Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $root $relativePath))
    if (-not $candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $failures.Add("Checksum path leaves the application directory: $relativePath")
        continue
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $failures.Add("Missing file: $relativePath")
        continue
    }

    $actual = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToUpperInvariant()
    if ($actual -ne $expected) {
        $failures.Add("Checksum mismatch: $relativePath")
        continue
    }
    $verified += 1
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "Verified $verified Morphly Voice installation files."
exit 0

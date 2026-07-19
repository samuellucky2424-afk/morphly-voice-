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

$failures = New-Object System.Collections.Generic.List[string]
$beatriceRoot = Join-Path $root "engines\beatrice-v2"
$beatriceRootPrefix = $beatriceRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$beatriceSlotPath = Join-Path $beatriceRoot "model_dir\1\params.json"
if (-not (Test-Path -LiteralPath $beatriceSlotPath -PathType Leaf)) {
    $failures.Add("Beatrice slot metadata is missing: $beatriceSlotPath")
} else {
    $slotBytes = [IO.File]::ReadAllBytes($beatriceSlotPath)
    if ($slotBytes.Length -ge 3 -and $slotBytes[0] -eq 0xEF -and $slotBytes[1] -eq 0xBB -and $slotBytes[2] -eq 0xBF) {
        $failures.Add("Beatrice slot metadata must be UTF-8 without a byte-order mark: $beatriceSlotPath")
    }
    try {
        $slot = Get-Content -LiteralPath $beatriceSlotPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([string]$slot.voice_changer_type -cne "Beatrice_v2") {
            $failures.Add("Beatrice slot 1 has an unexpected voice_changer_type: $($slot.voice_changer_type)")
        }
        $voiceCount = @($slot.model_info.voice.PSObject.Properties).Count
        if ($voiceCount -lt 1) {
            $failures.Add("Beatrice slot 1 contains no voice metadata.")
        }
        foreach ($propertyName in @(
            "toml_file",
            "phone_extractor_file",
            "pitch_estimator_file",
            "speaker_embeddings_file",
            "waveform_generator_file",
            "embedding_setter_file"
        )) {
            $relativePath = [string]$slot.$propertyName
            $candidate = [IO.Path]::GetFullPath((Join-Path $beatriceRoot $relativePath))
            if (-not $candidate.StartsWith($beatriceRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
                $failures.Add("Beatrice slot path leaves the Beatrice runtime: $propertyName=$relativePath")
            } elseif (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                $failures.Add("Beatrice slot file is missing: $propertyName=$relativePath")
            }
        }
    } catch {
        $failures.Add("Beatrice slot metadata is invalid JSON: $($_.Exception.Message)")
    }
}

$checksumPath = Join-Path $root "checksums.sha256"
if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
    throw "Checksum manifest is missing: $checksumPath"
}

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

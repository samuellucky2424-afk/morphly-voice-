[CmdletBinding()]
param(
    [string]$InnoCompilerPath,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Import-Module (Join-Path $PSScriptRoot "MorphlyPackaging.psm1") -Force
$result = Test-MorphlyPackageSource -InnoCompilerPath $InnoCompilerPath

if ($AsJson) {
    $result | ConvertTo-Json -Depth 8
} else {
    Write-Host "Morphly Voice Windows package preflight"
    Write-Host "Repository: $($result.RepositoryRoot)"
    Write-Host "Source payload ready: $($result.SourceReady)"
    Write-Host "Inno compiler ready: $($result.InstallerCompilerReady)"
    if ($result.PythonRuntime) {
        Write-Host "Python: $($result.PythonRuntime.version) ($($result.PythonRuntime.bits)-bit)"
    }
    if ($result.Estimate) {
        Write-Host "Estimated installed payload: $($result.Estimate.TotalGiB) GiB across $($result.Estimate.TotalFiles) files"
        $result.Estimate.Components |
            Select-Object Name, Files, @{ Name = "GiB"; Expression = { [Math]::Round($_.Bytes / 1GB, 3) } }, Path |
            Format-Table -AutoSize
    }

    Write-Host "Tool readiness:"
    $result.Tooling | Format-List

    if ($result.Errors.Count -gt 0) {
        Write-Host "Errors:"
        $result.Errors | ForEach-Object { Write-Host "  - $_" }
    }
    if ($result.Warnings.Count -gt 0) {
        Write-Host "Warnings:"
        $result.Warnings | ForEach-Object { Write-Host "  - $_" }
    }
}

if (-not $result.SourceReady) {
    exit 1
}
exit 0

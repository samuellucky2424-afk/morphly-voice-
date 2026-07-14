[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$publisher = Join-Path $PSScriptRoot "Publish-MorphlyRelease.ps1"
if (-not (Test-Path -LiteralPath $publisher -PathType Leaf)) {
    throw "Publisher script is missing: $publisher"
}

function Assert-MorphlyThrows {
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Action,
        [Parameter(Mandatory = $true)][string]$ExpectedMessage
    )

    $didThrow = $false
    try {
        & $Action
    } catch {
        $didThrow = $true
        if ($_.Exception.Message -notlike "*$ExpectedMessage*") {
            throw "Expected an error containing '$ExpectedMessage', received: $($_.Exception.Message)"
        }
    }
    if (-not $didThrow) {
        throw "Expected an error containing '$ExpectedMessage', but no error was raised."
    }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("morphly-release-test-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $version = "0.2.0"
    $installerName = "Morphly-Voice-Setup-$version.exe"
    $installerPath = Join-Path $testRoot $installerName
    [IO.File]::WriteAllBytes($installerPath, [byte[]](0..255))
    $hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
    Set-Content -LiteralPath "$installerPath.sha256" -Encoding ASCII -Value "$hash *$installerName"

    $result = & $publisher -Version $version -InstallerPath $installerPath -ValidateOnly
    if ($result.Status -ne "validated" -or $result.Version -ne $version -or $result.Sha256 -ne $hash) {
        throw "Validation-only result did not contain the expected release metadata."
    }

    Assert-MorphlyThrows -ExpectedMessage "without a leading v" -Action {
        & $publisher -Version "v0.2.0" -InstallerPath $installerPath -ValidateOnly
    }

    Assert-MorphlyThrows -ExpectedMessage "requires both -Publish and -ConfirmDistributionRights" -Action {
        & $publisher -Version $version -InstallerPath $installerPath -Publish
    }

    Set-Content -LiteralPath "$installerPath.sha256" -Encoding ASCII -Value "$('0' * 64) *$installerName"
    Assert-MorphlyThrows -ExpectedMessage "does not match its sidecar" -Action {
        & $publisher -Version $version -InstallerPath $installerPath -ValidateOnly
    }

    Write-Host "Publish-MorphlyRelease validation tests passed."
} finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

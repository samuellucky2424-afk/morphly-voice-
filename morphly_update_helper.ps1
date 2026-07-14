[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, [int]::MaxValue)][int]$ParentPid,
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$ApplicationRoot,
    [Parameter(Mandatory = $true)][string]$RestartLauncher,
    [switch]$RestartAfterInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    return $candidatePath.Equals($parentPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidatePath.StartsWith($parentPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$resolvedApplicationRoot = (Resolve-Path -LiteralPath $ApplicationRoot).Path
$resolvedLauncher = (Resolve-Path -LiteralPath $RestartLauncher).Path
$helperRoot = $PSScriptRoot

if (-not (Test-PathInside -Candidate $resolvedInstaller -Parent $helperRoot)) {
    throw "The installer must remain inside the verified Morphly update directory."
}
if (-not (Test-PathInside -Candidate $resolvedLauncher -Parent $resolvedApplicationRoot)) {
    throw "The restart launcher must remain inside the Morphly installation directory."
}
if ([IO.Path]::GetFileName($resolvedInstaller) -notmatch '^Morphly-Voice-Setup-\d+\.\d+\.\d+\.exe$') {
    throw "The verified installer filename is invalid."
}

try {
    Wait-Process -Id $ParentPid -Timeout 180 -ErrorAction SilentlyContinue
} catch {
    # The supervisor may already have exited before this helper begins waiting.
}

$installerExitCode = -1
try {
    $actualSha256 = (Get-FileHash -LiteralPath $resolvedInstaller -Algorithm SHA256).Hash
    if (-not $actualSha256.Equals($ExpectedSha256, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The Morphly installer changed after verification. Installation was cancelled."
    }
    $installer = Start-Process `
        -FilePath $resolvedInstaller `
        -WorkingDirectory $helperRoot `
        -ArgumentList @("/NORESTART", "/CLOSEAPPLICATIONS") `
        -WindowStyle Normal `
        -PassThru `
        -Wait
    $installerExitCode = $installer.ExitCode
} finally {
    if (($RestartAfterInstall -or $installerExitCode -ne 0) -and (Test-Path -LiteralPath $resolvedLauncher -PathType Leaf)) {
        Start-Process -FilePath $resolvedLauncher -WorkingDirectory $resolvedApplicationRoot -WindowStyle Normal
    }
}

exit $installerExitCode

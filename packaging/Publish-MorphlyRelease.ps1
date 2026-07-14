[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$Version,
    [string]$InstallerPath,
    [string]$ReleaseNotesPath,
    [switch]$Publish,
    [switch]$ConfirmDistributionRights,
    [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$whatIfRequested = $PSBoundParameters.ContainsKey("WhatIf") -and [bool]$PSBoundParameters["WhatIf"]
# Several Windows PowerShell 5.1 read-only filesystem cmdlets incorrectly
# suppress their output when the ambient WhatIf preference is set. Preserve
# the caller's intent here and handle it immediately before the GitHub write.
if ($whatIfRequested) {
    $WhatIfPreference = $false
}

$repository = "samuellucky2424-afk/morphly-voice-"
$targetCommitish = "main"
$releaseAssetLimitBytes = [int64]2147483648
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Get-MorphlyJson {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required version file is missing: $Path"
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        throw "Could not parse JSON from ${Path}: $($_.Exception.Message)"
    }
}

function Get-MorphlyLockVersions {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required version file is missing: $Path"
    }
    try {
        # Windows PowerShell 5.1 ConvertFrom-Json rejects npm's required empty
        # string key in packages[""]. JavaScriptSerializer preserves that key.
        Add-Type -AssemblyName System.Web.Extensions
        $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
        $serializer.MaxJsonLength = [int]::MaxValue
        $lockJson = $serializer.DeserializeObject((Get-Content -LiteralPath $Path -Raw -Encoding UTF8))
        $topLevelVersion = [string]$lockJson["version"]
        $rootPackageVersion = [string]$lockJson["packages"][""]["version"]
    } catch {
        throw "Could not parse npm lockfile ${Path}: $($_.Exception.Message)"
    }
    if (-not $topLevelVersion -or -not $rootPackageVersion) {
        throw "The top-level or root package version is missing from package-lock.json: $Path"
    }
    return [pscustomobject]@{
        TopLevel = $topLevelVersion
        RootPackage = $rootPackageVersion
    }
}

function Assert-MorphlyVersionSources {
    param([Parameter(Mandatory = $true)][string]$ExpectedVersion)

    $rootPackagePath = Join-Path $repositoryRoot "package.json"
    $rootLockPath = Join-Path $repositoryRoot "package-lock.json"
    $dashboardPackagePath = Join-Path $repositoryRoot "Morphly-Voice-Dashboard\package.json"
    $dashboardLockPath = Join-Path $repositoryRoot "Morphly-Voice-Dashboard\package-lock.json"

    $rootPackage = Get-MorphlyJson -Path $rootPackagePath
    $rootLock = Get-MorphlyLockVersions -Path $rootLockPath
    $dashboardPackage = Get-MorphlyJson -Path $dashboardPackagePath
    $dashboardLock = Get-MorphlyLockVersions -Path $dashboardLockPath

    $versions = [ordered]@{
        $rootPackagePath = [string]$rootPackage.version
        "$rootLockPath (top-level)" = [string]$rootLock.TopLevel
        "$rootLockPath (root package)" = [string]$rootLock.RootPackage
        $dashboardPackagePath = [string]$dashboardPackage.version
        "$dashboardLockPath (top-level)" = [string]$dashboardLock.TopLevel
        "$dashboardLockPath (root package)" = [string]$dashboardLock.RootPackage
    }
    foreach ($entry in $versions.GetEnumerator()) {
        if ($entry.Value -ne $ExpectedVersion) {
            throw "Version mismatch in $($entry.Key): expected $ExpectedVersion, found $($entry.Value)."
        }
    }
}

function Resolve-MorphlyFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Purpose is missing: $Path"
    }
    return (Resolve-Path -LiteralPath $Path).Path
}

function Invoke-MorphlyGh {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$AllowNotFound
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & gh @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
    $text = ($output | ForEach-Object { [string]$_ }) -join "`n"
    if ($exitCode -eq 0) {
        return $text
    }
    if ($AllowNotFound -and ($text -match '(?i)HTTP\s+404|Not Found')) {
        return $null
    }
    if (-not $text) {
        $text = "gh exited with code $exitCode."
    }
    throw "GitHub CLI failed: $text"
}

function Get-MorphlyReleaseFromGitHub {
    param([Parameter(Mandatory = $true)][string]$Tag)

    $jsonText = Invoke-MorphlyGh -Arguments @(
        "api",
        "repos/$repository/releases/tags/$Tag"
    )
    try {
        return $jsonText | ConvertFrom-Json
    } catch {
        throw "GitHub returned invalid release JSON for ${Tag}: $($_.Exception.Message)"
    }
}

function Assert-MorphlyReleaseAssets {
    param(
        [Parameter(Mandatory = $true)]$Release,
        [Parameter(Mandatory = $true)][string]$ExpectedTag,
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$Installer,
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$Checksum,
        [Parameter(Mandatory = $true)][string]$InstallerSha256,
        [Parameter(Mandatory = $true)][string]$ChecksumSha256
    )

    if ([string]$Release.tag_name -ne $ExpectedTag) {
        throw "GitHub returned tag $($Release.tag_name); expected $ExpectedTag."
    }
    if (-not [bool]$Release.draft) {
        throw "Release $ExpectedTag became public before its assets were verified."
    }

    $expectedAssets = @(
        [pscustomobject]@{ File = $Installer; Sha256 = $InstallerSha256 },
        [pscustomobject]@{ File = $Checksum; Sha256 = $ChecksumSha256 }
    )
    foreach ($expected in $expectedAssets) {
        $matches = @($Release.assets | Where-Object { [string]$_.name -ceq $expected.File.Name })
        if ($matches.Count -ne 1) {
            throw "Expected exactly one uploaded release asset named $($expected.File.Name); found $($matches.Count)."
        }
        $asset = $matches[0]
        if ([string]$asset.state -ne "uploaded") {
            throw "Release asset $($expected.File.Name) is not fully uploaded (state: $($asset.state))."
        }
        if ([int64]$asset.size -ne [int64]$expected.File.Length) {
            throw "Release asset $($expected.File.Name) has size $($asset.size); expected $($expected.File.Length)."
        }
        if ($asset.PSObject.Properties.Name -contains "digest" -and $asset.digest) {
            $expectedDigest = "sha256:$($expected.Sha256.ToLowerInvariant())"
            if ([string]$asset.digest -cne $expectedDigest) {
                throw "Release asset $($expected.File.Name) has digest $($asset.digest); expected $expectedDigest."
            }
        }
    }
}

if ($Publish -and -not $ConfirmDistributionRights) {
    throw "Publishing requires both -Publish and -ConfirmDistributionRights. The confirmation covers Beatrice and every bundled RVC model."
}
if ($ValidateOnly -and $Publish) {
    throw "-ValidateOnly cannot be combined with -Publish."
}

if (-not $Version) {
    $rootPackage = Get-MorphlyJson -Path (Join-Path $repositoryRoot "package.json")
    $Version = [string]$rootPackage.version
}
if ($Version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "Version must be a stable semantic version such as 0.2.0 (without a leading v): $Version"
}

Assert-MorphlyVersionSources -ExpectedVersion $Version

$tag = "v$Version"
$expectedInstallerName = "Morphly-Voice-Setup-$Version.exe"
$expectedChecksumName = "$expectedInstallerName.sha256"
if (-not $InstallerPath) {
    $InstallerPath = Join-Path $PSScriptRoot "output\$expectedInstallerName"
}
$resolvedInstallerPath = Resolve-MorphlyFile -Path $InstallerPath -Purpose "Installer"
$installer = Get-Item -LiteralPath $resolvedInstallerPath
if ($installer.Name -cne $expectedInstallerName) {
    throw "Installer must use the exact release asset name $expectedInstallerName; found $($installer.Name)."
}
if ([int64]$installer.Length -le 0) {
    throw "Installer is empty: $resolvedInstallerPath"
}
if ([int64]$installer.Length -ge $releaseAssetLimitBytes) {
    throw "Installer is $($installer.Length) bytes. GitHub release assets must be smaller than 2 GiB ($releaseAssetLimitBytes bytes)."
}

$checksumPath = "$resolvedInstallerPath.sha256"
$resolvedChecksumPath = Resolve-MorphlyFile -Path $checksumPath -Purpose "Installer SHA-256 sidecar"
$checksum = Get-Item -LiteralPath $resolvedChecksumPath
if ($checksum.Name -cne $expectedChecksumName) {
    throw "Checksum must use the exact release asset name $expectedChecksumName; found $($checksum.Name)."
}
if ([int64]$checksum.Length -le 0 -or [int64]$checksum.Length -gt 4096) {
    throw "Checksum sidecar must contain one SHA-256 record and be no larger than 4096 bytes: $resolvedChecksumPath"
}

$checksumText = (Get-Content -LiteralPath $resolvedChecksumPath -Raw -Encoding ASCII).Trim()
$checksumMatch = [regex]::Match($checksumText, '^([0-9A-Fa-f]{64})\s+\*?([^\r\n]+)$')
if (-not $checksumMatch.Success) {
    throw "Checksum sidecar must contain exactly '<64 hex characters> *$expectedInstallerName'."
}
$recordedHash = $checksumMatch.Groups[1].Value.ToUpperInvariant()
$recordedName = $checksumMatch.Groups[2].Value.Trim()
if ($recordedName -cne $expectedInstallerName) {
    throw "Checksum sidecar names $recordedName; expected $expectedInstallerName."
}
$actualInstallerHash = (Get-FileHash -LiteralPath $resolvedInstallerPath -Algorithm SHA256).Hash.ToUpperInvariant()
if ($recordedHash -cne $actualInstallerHash) {
    throw "Installer SHA-256 does not match its sidecar. Expected $recordedHash, calculated $actualInstallerHash."
}
$actualChecksumHash = (Get-FileHash -LiteralPath $resolvedChecksumPath -Algorithm SHA256).Hash.ToUpperInvariant()

$resolvedReleaseNotesPath = $null
if ($ReleaseNotesPath) {
    $resolvedReleaseNotesPath = Resolve-MorphlyFile -Path $ReleaseNotesPath -Purpose "Release notes file"
}

Write-Host "Local release validation passed."
Write-Host "Version: $Version"
Write-Host "Tag: $tag"
Write-Host "Installer: $resolvedInstallerPath ($($installer.Length) bytes)"
Write-Host "SHA-256: $actualInstallerHash"

if ($ValidateOnly) {
    Write-Host "Validation-only mode: GitHub was not contacted or changed."
    return [pscustomobject]@{
        Version = $Version
        Tag = $tag
        Installer = $resolvedInstallerPath
        InstallerBytes = [int64]$installer.Length
        Sha256 = $actualInstallerHash
        Status = "validated"
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) is required. Install it and authenticate with 'gh auth login'."
}
[void](Invoke-MorphlyGh -Arguments @("auth", "status", "--hostname", "github.com"))

$latestReleaseText = Invoke-MorphlyGh -Arguments @(
    "api",
    "repos/$repository/releases/latest"
) -AllowNotFound
if ($null -ne $latestReleaseText) {
    try {
        $latestRelease = $latestReleaseText | ConvertFrom-Json
    } catch {
        throw "GitHub returned invalid latest-release JSON: $($_.Exception.Message)"
    }
    $latestTag = [string]$latestRelease.tag_name
    if ($latestTag -cnotmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
        throw "The latest GitHub Release tag is not a supported stable Morphly version: $latestTag"
    }
    $latestVersion = $latestTag.Substring(1)
    if ([version]$Version -le [version]$latestVersion) {
        throw "Version $Version is not newer than the latest published version $latestVersion."
    }
}

$existingTag = Invoke-MorphlyGh -Arguments @(
    "api",
    "repos/$repository/git/ref/tags/$tag"
) -AllowNotFound
if ($null -ne $existingTag) {
    throw "Git tag $tag already exists in $repository. Release assets are immutable by convention; choose a new version."
}
$existingRelease = Invoke-MorphlyGh -Arguments @(
    "api",
    "repos/$repository/releases/tags/$tag"
) -AllowNotFound
if ($null -ne $existingRelease) {
    throw "Release $tag already exists in $repository. Choose a new version."
}

$releaseAction = "create draft $tag with $expectedInstallerName and $expectedChecksumName"
if ($whatIfRequested) {
    Write-Host "What if: $releaseAction in $repository. No GitHub changes were made."
    return
}
if (-not $PSCmdlet.ShouldProcess($repository, $releaseAction)) {
    Write-Host "No GitHub changes were made."
    return
}

$createArguments = @(
    "release",
    "create",
    $tag,
    $resolvedInstallerPath,
    $resolvedChecksumPath,
    "--repo",
    $repository,
    "--target",
    $targetCommitish,
    "--title",
    "Morphly Voice $Version",
    "--draft"
)
if ($resolvedReleaseNotesPath) {
    $createArguments += @("--notes-file", $resolvedReleaseNotesPath)
} else {
    $createArguments += "--generate-notes"
}

$draftUrl = Invoke-MorphlyGh -Arguments $createArguments
Write-Host "Draft release created: $draftUrl"

try {
    $draftRelease = Get-MorphlyReleaseFromGitHub -Tag $tag
    Assert-MorphlyReleaseAssets `
        -Release $draftRelease `
        -ExpectedTag $tag `
        -Installer $installer `
        -Checksum $checksum `
        -InstallerSha256 $actualInstallerHash `
        -ChecksumSha256 $actualChecksumHash
} catch {
    throw "Draft $tag was created but did not pass remote verification. It remains a draft for manual inspection. $($_.Exception.Message)"
}

Write-Host "GitHub verified both uploaded assets, sizes, and available digests."
if (-not $Publish) {
    Write-Host "Release remains a draft. No public update was announced."
    return [pscustomobject]@{
        Version = $Version
        Tag = $tag
        ReleaseUrl = [string]$draftRelease.html_url
        Status = "draft-verified"
    }
}

[void](Invoke-MorphlyGh -Arguments @(
    "release",
    "edit",
    $tag,
    "--repo",
    $repository,
    "--draft=false",
    "--latest"
))
$publishedRelease = Get-MorphlyReleaseFromGitHub -Tag $tag
if ([bool]$publishedRelease.draft) {
    throw "GitHub did not publish $tag. The verified release still exists as a draft."
}
$latestPublishedRelease = Invoke-MorphlyGh -Arguments @(
    "api",
    "repos/$repository/releases/latest"
) | ConvertFrom-Json
if ([string]$latestPublishedRelease.tag_name -ne $tag) {
    throw "Release $tag is public but GitHub does not report it as the latest release."
}
Write-Host "Published Morphly Voice ${Version}: $($publishedRelease.html_url)"
return [pscustomobject]@{
    Version = $Version
    Tag = $tag
    ReleaseUrl = [string]$publishedRelease.html_url
    Status = "published"
}

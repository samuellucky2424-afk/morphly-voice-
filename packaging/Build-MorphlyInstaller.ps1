[CmdletBinding()]
param(
    [string]$Version,
    [string]$WorkRoot,
    [string]$OutputRoot,
    [string]$InnoCompilerPath,
    [switch]$ConfirmLargeBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $WorkRoot) {
    $WorkRoot = Join-Path $PSScriptRoot "work"
}
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $PSScriptRoot "output"
}

Import-Module (Join-Path $PSScriptRoot "MorphlyPackaging.psm1") -Force
$repositoryRoot = Get-MorphlyRepositoryRoot
$preflight = Test-MorphlyPackageSource -InnoCompilerPath $InnoCompilerPath

if (-not $Version) {
    $packageJson = Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$packageJson.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$') {
    throw "Version must be a semantic version such as 0.2.0: $Version"
}

if ($preflight.Estimate) {
    Write-Host "Estimated installed payload: $($preflight.Estimate.TotalGiB) GiB across $($preflight.Estimate.TotalFiles) files."
}
if (-not $preflight.SourceReady) {
    throw "Packaging preflight failed:`n - $($preflight.Errors -join "`n - ")"
}
if (-not $ConfirmLargeBuild) {
    throw "Large build confirmation is required. Re-run with -ConfirmLargeBuild after reviewing the preflight size and Beatrice redistribution notice."
}
if (-not $preflight.InstallerCompilerReady) {
    throw "Inno Setup 6 compiler was not found. Install it or pass -InnoCompilerPath with the full path to ISCC.exe."
}

function Invoke-MorphlyRobocopy {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination,
        [string[]]$ExcludedDirectories = @(),
        [string[]]$ExcludedFiles = @()
    )

    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw "Copy source directory is missing: $Source"
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    $arguments = @(
        $Source,
        $Destination,
        "/E",
        "/COPY:DAT",
        "/DCOPY:DAT",
        "/R:2",
        "/W:1",
        "/XJ",
        "/NP",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS"
    )
    if ($ExcludedDirectories.Count -gt 0) {
        $arguments += "/XD"
        $arguments += $ExcludedDirectories
    }
    if ($ExcludedFiles.Count -gt 0) {
        $arguments += "/XF"
        $arguments += $ExcludedFiles
    }

    & robocopy.exe @arguments | Out-Host
    $robocopyExitCode = $LASTEXITCODE
    if ($robocopyExitCode -gt 7) {
        throw "Robocopy failed with exit code $robocopyExitCode while copying $Source"
    }
}

function Test-MorphlyPathInside {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )

    $candidateFullPath = [IO.Path]::GetFullPath($Candidate).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $parentFullPath = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar)
    return $candidateFullPath.Equals($parentFullPath, [StringComparison]::OrdinalIgnoreCase) -or
        $candidateFullPath.StartsWith($parentFullPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

$resolvedWorkRoot = [IO.Path]::GetFullPath($WorkRoot)
$resolvedOutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$stageRoot = Join-Path $resolvedWorkRoot "MorphlyVoice-$Version"
$copySources = @(
    (Join-Path $repositoryRoot "server"),
    (Join-Path $repositoryRoot "client\demo\dist"),
    (Join-Path $repositoryRoot "Morphly-Voice-Dashboard\dist-static"),
    (Join-Path $repositoryRoot "engines\beatrice-v2"),
    $preflight.PythonRuntime.stdlib,
    $preflight.PythonRuntime.sitePackages,
    (Join-Path $preflight.PythonRuntime.basePrefix "DLLs")
)
foreach ($copySource in $copySources) {
    if (Test-MorphlyPathInside -Candidate $stageRoot -Parent $copySource) {
        throw "The staging directory cannot be inside a copied source directory: $stageRoot (source: $copySource)"
    }
}
if ((Test-MorphlyPathInside -Candidate $resolvedOutputRoot -Parent $stageRoot) -or
    (Test-MorphlyPathInside -Candidate $stageRoot -Parent $resolvedOutputRoot)) {
    throw "The staging and installer output directories must not contain one another. Stage: $stageRoot; output: $resolvedOutputRoot"
}
if (Test-Path -LiteralPath $stageRoot) {
    throw "Stage directory already exists. Remove it explicitly after verifying the path, or choose another -WorkRoot: $stageRoot"
}
$installer = Join-Path $resolvedOutputRoot "Morphly-Voice-Setup-$Version.exe"
if ((Test-Path -LiteralPath $installer) -or (Test-Path -LiteralPath "$installer.sha256")) {
    throw "Refusing to overwrite an existing installer or checksum: $installer"
}

New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
New-Item -ItemType Directory -Path $resolvedOutputRoot -Force | Out-Null

foreach ($file in @(
    "morphly_supervisor.py",
    "morphly_updater.py",
    "morphly_update_helper.ps1",
    "start_http.bat",
    "start_engine_mode.bat",
    "LICENSE",
    "LICENSE-NOTICE",
    "README.md"
)) {
    Copy-Item -LiteralPath (Join-Path $repositoryRoot $file) -Destination (Join-Path $stageRoot $file)
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "BEATRICE-REDISTRIBUTION-NOTICE.txt") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Verify-MorphlyInstallation.ps1") -Destination $stageRoot
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "runtime-manifest.json") -Destination (Join-Path $stageRoot "packaging-manifest.json")

& (Join-Path $PSScriptRoot "New-MorphlyIcon.ps1") `
    -SourceDirectory (Join-Path $repositoryRoot "Morphly-Voice-Dashboard\dist-static") `
    -OutputPath (Join-Path $stageRoot "MorphlyVoice.ico")

Invoke-MorphlyRobocopy `
    -Source (Join-Path $repositoryRoot "server") `
    -Destination (Join-Path $stageRoot "server") `
    -ExcludedDirectories @("__pycache__", "logs", "upload_dir", "tmp_dir") `
    -ExcludedFiles @("*.pyc", "vcclient.log", "stored_setting.json")
Invoke-MorphlyRobocopy `
    -Source (Join-Path $repositoryRoot "client\demo\dist") `
    -Destination (Join-Path $stageRoot "client\demo\dist")
Invoke-MorphlyRobocopy `
    -Source (Join-Path $repositoryRoot "Morphly-Voice-Dashboard\dist-static") `
    -Destination (Join-Path $stageRoot "Morphly-Voice-Dashboard\dist-static")
Invoke-MorphlyRobocopy `
    -Source (Join-Path $repositoryRoot "engines\beatrice-v2") `
    -Destination (Join-Path $stageRoot "engines\beatrice-v2") `
    -ExcludedDirectories @("__pycache__") `
    -ExcludedFiles @("*.pyc", "vcclient*.log")

$portablePython = Join-Path $stageRoot "runtime\python"
New-Item -ItemType Directory -Path $portablePython -Force | Out-Null
Invoke-MorphlyRobocopy `
    -Source $preflight.PythonRuntime.stdlib `
    -Destination (Join-Path $portablePython "Lib") `
    -ExcludedDirectories @("site-packages", "__pycache__", "test", "tests") `
    -ExcludedFiles @("*.pyc")
Invoke-MorphlyRobocopy `
    -Source (Join-Path $preflight.PythonRuntime.basePrefix "DLLs") `
    -Destination (Join-Path $portablePython "DLLs") `
    -ExcludedDirectories @("__pycache__") `
    -ExcludedFiles @("*.pyc")
Invoke-MorphlyRobocopy `
    -Source $preflight.PythonRuntime.sitePackages `
    -Destination (Join-Path $portablePython "Lib\site-packages") `
    -ExcludedDirectories @("__pycache__") `
    -ExcludedFiles @("*.pyc")

$pythonRuntimeFiles = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
foreach ($pattern in @("python.exe", "pythonw.exe", "python3.dll", "python*.dll", "vcruntime*.dll", "LICENSE.txt")) {
    Get-ChildItem -LiteralPath $preflight.PythonRuntime.basePrefix -File -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
        if ($pythonRuntimeFiles.Add($_.FullName)) {
            Copy-Item -LiteralPath $_.FullName -Destination $portablePython
        }
    }
}

Copy-Item -LiteralPath (Join-Path $PSScriptRoot "default-rvc-settings.json") -Destination (Join-Path $stageRoot "server\stored_setting.json")
foreach ($directory in @(
    "runtime-logs",
    "runtime-state",
    "server\logs",
    "server\upload_dir",
    "server\tmp_dir"
)) {
    New-Item -ItemType Directory -Path (Join-Path $stageRoot $directory) -Force | Out-Null
}

$manifestImports = ($preflight.Manifest.pythonImports | ForEach-Object { [string]$_ }) -join ", "
$previousPythonHome = $env:PYTHONHOME
$previousPythonNoUserSite = $env:PYTHONNOUSERSITE
$previousPythonDontWriteBytecode = $env:PYTHONDONTWRITEBYTECODE
$previousErrorActionPreference = $ErrorActionPreference
try {
    $env:PYTHONHOME = $portablePython
    $env:PYTHONNOUSERSITE = "1"
    $env:PYTHONDONTWRITEBYTECODE = "1"
    $ErrorActionPreference = "Continue"
    $stagedImportOutput = & (Join-Path $portablePython "python.exe") -W ignore -c "import $manifestImports" 2>&1
    $stagedImportExitCode = $LASTEXITCODE
    $compileProbe = "import pathlib, sys; [compile(pathlib.Path(p).read_bytes(), p, 'exec') for p in sys.argv[1:]]"
    $stagedCompileOutput = & (Join-Path $portablePython "python.exe") -W ignore -c $compileProbe `
        (Join-Path $stageRoot "morphly_supervisor.py") `
        (Join-Path $stageRoot "morphly_updater.py") `
        (Join-Path $stageRoot "server\MMVCServerSIO.py") 2>&1
    $stagedCompileExitCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousErrorActionPreference
    $env:PYTHONHOME = $previousPythonHome
    $env:PYTHONNOUSERSITE = $previousPythonNoUserSite
    $env:PYTHONDONTWRITEBYTECODE = $previousPythonDontWriteBytecode
}
if ($stagedImportExitCode -ne 0) {
    throw "The staged portable Python runtime failed its dependency import check: $($stagedImportOutput -join ' ')"
}
if ($stagedCompileExitCode -ne 0) {
    throw "The staged Morphly Python entrypoints failed their no-write syntax check: $($stagedCompileOutput -join ' ')"
}

$buildManifest = [ordered]@{
    schemaVersion = 1
    application = "Morphly Voice"
    version = $Version
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
    architecture = "x64"
    pythonVersion = [string]$preflight.PythonRuntime.version
    sourcePayloadBytes = $preflight.Estimate.TotalBytes
    layout = "One installer EXE; extracted on-disk runtime"
    beatriceRedistributionReviewRequired = $true
}
$buildManifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stageRoot "build-manifest.json") -Encoding UTF8

$checksumLines = New-Object System.Collections.Generic.List[string]
Get-ChildItem -LiteralPath $stageRoot -Recurse -File -Force |
    Where-Object {
        $_.Name -ne "checksums.sha256" -and
        $_.FullName -ne (Join-Path $stageRoot "server\stored_setting.json")
    } |
    Sort-Object FullName |
    ForEach-Object {
        $relativePath = $_.FullName.Substring($stageRoot.Length + 1).Replace('\', '/')
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToUpperInvariant()
        $checksumLines.Add("$hash *$relativePath")
    }
$checksumLines | Set-Content -LiteralPath (Join-Path $stageRoot "checksums.sha256") -Encoding UTF8

& (Join-Path $stageRoot "Verify-MorphlyInstallation.ps1") -ApplicationRoot $stageRoot
if ($LASTEXITCODE -ne 0) {
    throw "Staged checksum verification failed."
}

$innoScript = Join-Path $PSScriptRoot "MorphlyVoice.iss"
& $preflight.Tooling.InnoCompiler `
    "/DAppVersion=$Version" `
    "/DStageDir=$stageRoot" `
    "/DOutputDir=$resolvedOutputRoot" `
    $innoScript
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
    throw "Inno Setup reported success, but the expected installer is missing: $installer"
}
$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Set-Content -LiteralPath "$installer.sha256" -Value "$installerHash *$([IO.Path]::GetFileName($installer))" -Encoding ASCII

Write-Host "Installer: $installer"
Write-Host "SHA-256: $installerHash"

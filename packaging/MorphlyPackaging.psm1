Set-StrictMode -Version Latest

$script:PackagingRoot = Split-Path -Parent $PSCommandPath
$script:RepositoryRoot = Split-Path -Parent $script:PackagingRoot

function Get-MorphlyRepositoryRoot {
    return $script:RepositoryRoot
}

function Get-MorphlyPackagingManifest {
    $manifestPath = Join-Path $script:PackagingRoot "runtime-manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Packaging manifest is missing: $manifestPath"
    }
    return Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Resolve-MorphlyInnoCompiler {
    param([string]$ExplicitPath)

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($ExplicitPath) {
        $candidates.Add($ExplicitPath)
    }

    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) {
        $candidates.Add($command.Source)
    }

    $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
    $programFiles = [Environment]::GetFolderPath("ProgramFiles")
    $localPrograms = Join-Path $env:LOCALAPPDATA "Programs"
    foreach ($candidate in @(
        (Join-Path $programFilesX86 "Inno Setup 6\ISCC.exe"),
        (Join-Path $programFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $localPrograms "Inno Setup 6\ISCC.exe")
    )) {
        if ($candidate) {
            $candidates.Add($candidate)
        }
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

function Get-MorphlyPythonRuntimeInfo {
    $pythonCandidates = @(
        (Join-Path $script:RepositoryRoot ".venv\Scripts\python.exe"),
        (Join-Path $script:RepositoryRoot "runtime\python\python.exe")
    )
    $sourcePython = $pythonCandidates |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
        Select-Object -First 1
    if (-not $sourcePython) {
        throw "Source Python runtime is missing. Expected .venv\Scripts\python.exe or runtime\python\python.exe."
    }

    $pythonProbe = @'
import json
import platform
import struct
import sys
import sysconfig
print(json.dumps({
    'executable': sys.executable,
    'prefix': sys.prefix,
    'basePrefix': sys.base_prefix,
    'stdlib': sysconfig.get_path('stdlib'),
    'sitePackages': sysconfig.get_path('purelib'),
    'version': platform.python_version(),
    'bits': struct.calcsize('P') * 8,
}))
'@
    $probeOutput = & $sourcePython -c $pythonProbe 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect the source Python environment: $($probeOutput -join ' ')"
    }
    return ($probeOutput -join "`n") | ConvertFrom-Json
}

function Get-MorphlyDirectoryStats {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$ExcludedDirectoryNames = @()
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $excludedPattern = $null
    if ($ExcludedDirectoryNames.Count -gt 0) {
        $escaped = $ExcludedDirectoryNames | ForEach-Object { [Regex]::Escape($_) }
        $excludedPattern = "\\(" + ($escaped -join "|") + ")(\\|$)"
    }

    [int64]$bytes = 0
    [int64]$files = 0
    Get-ChildItem -LiteralPath $resolved -Recurse -File -Force -ErrorAction Stop | ForEach-Object {
        $relative = $_.FullName.Substring($resolved.Length)
        if (-not $excludedPattern -or $relative -notmatch $excludedPattern) {
            $bytes += $_.Length
            $files += 1
        }
    }

    return [pscustomobject]@{
        Path = $resolved
        Files = $files
        Bytes = $bytes
    }
}

function Get-MorphlyPayloadEstimate {
    param([Parameter(Mandatory = $true)]$PythonRuntime)

    $components = New-Object System.Collections.Generic.List[object]
    $componentDefinitions = @(
        @{ Name = "RVC server (user models excluded)"; Path = (Join-Path $script:RepositoryRoot "server"); Exclude = @("__pycache__", "logs", "model_dir", "pretrain", "upload_dir", "tmp_dir") },
        @{ Name = "RVC fallback frontend"; Path = (Join-Path $script:RepositoryRoot "client\demo\dist"); Exclude = @() },
        @{ Name = "Morphly dashboard"; Path = (Join-Path $script:RepositoryRoot "Morphly-Voice-Dashboard\dist-static"); Exclude = @() },
        @{ Name = "Electron desktop runtime"; Path = (Join-Path $script:RepositoryRoot "node_modules\electron\dist"); Exclude = @() },
        @{ Name = "Beatrice V2 runtime and models"; Path = (Join-Path $script:RepositoryRoot "engines\beatrice-v2"); Exclude = @("__pycache__", "logs", "settings", "upload_dir", "tmp_dir") },
        @{ Name = "Portable Python standard library"; Path = $PythonRuntime.stdlib; Exclude = @("site-packages", "__pycache__", "test", "tests") },
        @{ Name = "RVC Python packages"; Path = $PythonRuntime.sitePackages; Exclude = @("__pycache__") },
        @{ Name = "Portable Python DLLs"; Path = (Join-Path $PythonRuntime.basePrefix "DLLs"); Exclude = @("__pycache__") }
    )

    foreach ($definition in $componentDefinitions) {
        if (Test-Path -LiteralPath $definition.Path -PathType Container) {
            $stats = Get-MorphlyDirectoryStats -Path $definition.Path -ExcludedDirectoryNames $definition.Exclude
            $components.Add([pscustomobject]@{
                Name = $definition.Name
                Path = $stats.Path
                Files = $stats.Files
                Bytes = $stats.Bytes
            })
        }
    }

    $selectedPretrainFiles = @(
        (Join-Path $script:RepositoryRoot "server\pretrain\content_vec_500.onnx")
    )
    [int64]$selectedPretrainBytes = 0
    [int64]$selectedPretrainCount = 0
    foreach ($pretrainFile in $selectedPretrainFiles) {
        if (Test-Path -LiteralPath $pretrainFile -PathType Leaf) {
            $selectedPretrainBytes += (Get-Item -LiteralPath $pretrainFile).Length
            $selectedPretrainCount += 1
        }
    }
    $components.Add([pscustomobject]@{
        Name = "Required RVC ONNX pretrain"
        Path = (Join-Path $script:RepositoryRoot "server\pretrain")
        Files = $selectedPretrainCount
        Bytes = $selectedPretrainBytes
    })

    [int64]$baseFilesBytes = 0
    [int64]$baseFilesCount = 0
    $baseFiles = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
    foreach ($pattern in @("python.exe", "pythonw.exe", "python3.dll", "python*.dll", "vcruntime*.dll", "LICENSE.txt")) {
        Get-ChildItem -LiteralPath $PythonRuntime.basePrefix -File -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
            if ($baseFiles.Add($_.FullName)) {
                $baseFilesBytes += $_.Length
                $baseFilesCount += 1
            }
        }
    }
    $components.Add([pscustomobject]@{
        Name = "Portable Python executables"
        Path = $PythonRuntime.basePrefix
        Files = $baseFilesCount
        Bytes = $baseFilesBytes
    })

    [int64]$totalBytes = 0
    [int64]$totalFiles = 0
    foreach ($component in $components) {
        $totalBytes += $component.Bytes
        $totalFiles += $component.Files
    }

    return [pscustomobject]@{
        Components = $components.ToArray()
        TotalBytes = $totalBytes
        TotalFiles = $totalFiles
        TotalGiB = [Math]::Round($totalBytes / 1GB, 3)
    }
}

function Test-MorphlyPackageSource {
    param([string]$InnoCompilerPath)

    $manifest = Get-MorphlyPackagingManifest
    $errors = New-Object System.Collections.Generic.List[string]
    $warnings = New-Object System.Collections.Generic.List[string]

    foreach ($requirement in $manifest.requirements) {
        $fullPath = Join-Path $script:RepositoryRoot ([string]$requirement.path)
        $exists = $false
        if ($requirement.kind -eq "file") {
            $exists = Test-Path -LiteralPath $fullPath -PathType Leaf
        } elseif ($requirement.kind -eq "directory") {
            $exists = Test-Path -LiteralPath $fullPath -PathType Container
        }

        if (-not $exists) {
            $errors.Add("Missing $($requirement.purpose): $fullPath")
            continue
        }

        if ($requirement.kind -eq "directory") {
            if ($requirement.PSObject.Properties.Name -contains "minimumFiles") {
                $fileCount = @(Get-ChildItem -LiteralPath $fullPath -Recurse -File -Force -ErrorAction SilentlyContinue).Count
                if ($fileCount -lt [int]$requirement.minimumFiles) {
                    $errors.Add("$($requirement.purpose) contains $fileCount files; expected at least $($requirement.minimumFiles): $fullPath")
                }
            }

            if ($requirement.PSObject.Properties.Name -contains "patterns") {
                $matches = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
                foreach ($pattern in $requirement.patterns) {
                    Get-ChildItem -LiteralPath $fullPath -Recurse -File -Filter ([string]$pattern) -Force -ErrorAction SilentlyContinue | ForEach-Object {
                        [void]$matches.Add($_.FullName)
                    }
                }
                $minimumMatches = 1
                if ($requirement.PSObject.Properties.Name -contains "minimumMatches") {
                    $minimumMatches = [int]$requirement.minimumMatches
                }
                if ($matches.Count -lt $minimumMatches) {
                    $errors.Add("$($requirement.purpose) matched $($matches.Count) files; expected at least $minimumMatches in $fullPath")
                }
            }
        }
    }

    $pythonRuntime = $null
    try {
        $pythonRuntime = Get-MorphlyPythonRuntimeInfo
        if ([int]$pythonRuntime.bits -ne 64) {
            $errors.Add("The source Python runtime is $($pythonRuntime.bits)-bit; the installer requires x64 Python.")
        }
        foreach ($requiredPath in @(
            (Join-Path $pythonRuntime.basePrefix "python.exe"),
            (Join-Path $pythonRuntime.basePrefix "LICENSE.txt"),
            (Join-Path $pythonRuntime.basePrefix "DLLs"),
            $pythonRuntime.stdlib,
            $pythonRuntime.sitePackages
        )) {
            if (-not (Test-Path -LiteralPath $requiredPath)) {
                $errors.Add("Portable Python source component is missing: $requiredPath")
            }
        }

        $imports = ($manifest.pythonImports | ForEach-Object { [string]$_ }) -join ", "
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $importOutput = & $pythonRuntime.executable -W ignore -c "import $imports" 2>&1
            $importExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($importExitCode -ne 0) {
            $errors.Add("The RVC Python environment cannot import all required runtime modules: $($importOutput -join ' ')")
        }

        $syntaxTargets = @(
            (Join-Path $script:RepositoryRoot "morphly_supervisor.py"),
            (Join-Path $script:RepositoryRoot "server\MMVCServerSIO.py")
        )
        $compileProbe = "import pathlib, sys; [compile(pathlib.Path(p).read_bytes(), p, 'exec') for p in sys.argv[1:]]"
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            $compileOutput = & $pythonRuntime.executable -W ignore -c $compileProbe @syntaxTargets 2>&1
            $compileExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($compileExitCode -ne 0) {
            $errors.Add("A Morphly Python entrypoint failed its no-write syntax check: $($compileOutput -join ' ')")
        }
    } catch {
        $errors.Add($_.Exception.Message)
    }

    $innoCompiler = Resolve-MorphlyInnoCompiler -ExplicitPath $InnoCompilerPath
    $pyInstallerVersion = $null
    if ($pythonRuntime) {
        $pyInstallerProbe = "import importlib.metadata as m, importlib.util as u; print(m.version('pyinstaller') if u.find_spec('PyInstaller') else '')"
        $pyInstallerOutput = & $pythonRuntime.executable -c $pyInstallerProbe
        if ($LASTEXITCODE -eq 0 -and $pyInstallerOutput) {
            $pyInstallerVersion = ($pyInstallerOutput -join " ").Trim()
        }
    }
    $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue

    $estimate = $null
    if ($pythonRuntime -and $errors.Count -eq 0) {
        $estimate = Get-MorphlyPayloadEstimate -PythonRuntime $pythonRuntime
    }

    if (-not $innoCompiler) {
        $warnings.Add("Inno Setup 6 compiler (ISCC.exe) is not installed; staging can be prepared, but the installer EXE cannot be compiled.")
    }
    if (-not $pyInstallerVersion) {
        $warnings.Add("PyInstaller is not installed in the source Python runtime. It is optional for this portable-Python installer layout and is not used by the build script.")
    }
    if (-not $robocopy) {
        $errors.Add("robocopy.exe is required for reliable multi-gigabyte staging.")
    }
    $warnings.Add("Beatrice V2 redistribution permission must be reviewed before publishing; see packaging\BEATRICE-REDISTRIBUTION-NOTICE.txt.")
    $warnings.Add("RVC voice-model redistribution, consent, and publicity rights must be reviewed model by model before publishing; file presence is not permission.")
    $warnings.Add("The output is one installer EXE that expands to an on-disk application directory; it is not a one-file runtime executable.")

    return [pscustomobject]@{
        SourceReady = ($errors.Count -eq 0)
        InstallerCompilerReady = [bool]$innoCompiler
        ReadyToBuildInstaller = ($errors.Count -eq 0 -and [bool]$innoCompiler)
        RepositoryRoot = $script:RepositoryRoot
        Manifest = $manifest
        PythonRuntime = $pythonRuntime
        Estimate = $estimate
        Tooling = [pscustomobject]@{
            InnoCompiler = $innoCompiler
            PyInstallerVersion = $pyInstallerVersion
            Robocopy = if ($robocopy) { $robocopy.Source } else { $null }
        }
        Errors = @($errors)
        Warnings = @($warnings)
    }
}

Export-ModuleMember -Function @(
    "Get-MorphlyRepositoryRoot",
    "Get-MorphlyPackagingManifest",
    "Resolve-MorphlyInnoCompiler",
    "Get-MorphlyPythonRuntimeInfo",
    "Get-MorphlyDirectoryStats",
    "Get-MorphlyPayloadEstimate",
    "Test-MorphlyPackageSource"
)

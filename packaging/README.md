# Morphly Voice Windows installer foundation

This directory builds one Windows installer EXE. The installer expands Morphly
Voice into a normal, writable on-disk directory under the current user's local
application data. It is intentionally not a single-file runtime: RVC, Python,
native libraries, models, and Beatrice require their directory layouts at run
time.

## What is staged

- `morphly_supervisor.py` and the two Windows launchers;
- the built dashboard at `Morphly-Voice-Dashboard\dist-static`;
- the RVC Python server, fallback frontend, models, and pretrained assets;
- a portable Python 3.11 runtime assembled from the local base interpreter and
  `.venv\Lib\site-packages`;
- the complete Beatrice runtime/model layout, excluding only transient logs and
  Python bytecode caches;
- application, third-party, Beatrice, and bundled-component license notices;
- a multi-size Windows icon assembled from the dashboard's Morphly brand PNGs;
- a per-file SHA-256 manifest and an installation verification script.

The mutable `server\stored_setting.json` file is intentionally excluded from
the checksum manifest because normal device/model configuration rewrites it.
Runtime logs, state, uploads, and temporary directories are also outside the
release checksum set.

The build does not copy the machine-specific RVC `stored_setting.json`. It
installs `default-rvc-settings.json` with audio stopped and no device IDs so the
user must select devices valid on the installed computer.

## Preflight only

Run this before any multi-gigabyte staging operation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Test-MorphlyPackaging.ps1
```

The preflight fails when the dashboard, Python runtime, RVC engine/model,
pretrained content-vector model, Beatrice engine/model, or required license
files are missing. It also imports the required RVC Python modules, estimates
the installed payload, and reports whether `ISCC.exe`, PyInstaller, and
Robocopy are available.

PyInstaller is reported for completeness but is not required by this layout.
The build uses a portable Python directory because the RVC process and its
native dependencies need an on-disk runtime. Inno Setup 6 is required to create
the final installer EXE.

## Create the installer

After reviewing the estimated size and the Beatrice notice, install Inno Setup
6 and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Build-MorphlyInstaller.ps1 -Version 0.2.0 -ConfirmLargeBuild
```

If Inno Setup is installed in a nonstandard directory, add:

```powershell
-InnoCompilerPath "C:\Path\To\Inno Setup 6\ISCC.exe"
```

The expected outputs are:

- `packaging\output\Morphly-Voice-Setup-0.2.0.exe`
- `packaging\output\Morphly-Voice-Setup-0.2.0.exe.sha256`

For the draft-first GitHub Releases workflow used by the in-app updater, see
`packaging\RELEASING.md`.

The script refuses to overwrite an existing staging directory. This is a
safety feature; remove an old `packaging\work\MorphlyVoice-<version>` directory
only after manually verifying that exact path, or choose a different
`-WorkRoot`.

## Installation checksum verification

After installation, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Morphly Voice\Verify-MorphlyInstallation.ps1"
```

## Distribution gate

Do not publish an installer containing Beatrice until the distributor has
reviewed and documented the applicable redistribution rights. The package
preflight validates that notices exist; it cannot grant permission. See
`BEATRICE-REDISTRIBUTION-NOTICE.txt`.

The same principle applies to every bundled RVC voice model: the build only
checks that model files exist. It does not establish redistribution, consent,
voice-likeness, or publicity rights for those weights.

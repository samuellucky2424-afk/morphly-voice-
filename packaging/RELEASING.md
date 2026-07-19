# Publishing Morphly Voice updates

Morphly Voice updates are published as GitHub Releases in
`samuellucky2424-afk/morphly-voice-`. The installed application checks the
latest published, non-prerelease release. A commit on `main` is not an update
until a new versioned installer has been built, verified, and published.

Stable version tags are built by `.github/workflows/release-windows.yml` on a
GitHub-hosted Windows runner. Because the repository does not contain the full
Python runtime, engine binaries, or model files, the workflow verifies and
silently extracts the newest older Morphly installer that has both required
release assets. It uses that installed payload only as the runtime seed, then
overlays the tagged application source and rebuilds the dashboard, Electron
shell, manifests, checksums, and installer.

The Beatrice `base_library.zip` repair is tracked separately and pinned by
SHA-256 because installers before 0.2.2 accidentally omitted that file. Once a
workflow-built release is available, later releases automatically use the
newest qualifying installer as their runtime seed.

## Release contract

- Use a stable semantic version such as `0.2.0` in both `package.json` files
  and both corresponding `package-lock.json` root records.
- Use the Git tag `v<version>`.
- Upload exactly these two assets:
  - `Morphly-Voice-Setup-<version>.exe`
  - `Morphly-Voice-Setup-<version>.exe.sha256`
- Never replace an asset under an existing version. Fix the issue and publish
  a new version.
- Every release asset must be smaller than 2 GiB. The publisher rejects an
  installer at or above that limit.

The client uses GitHub's public Releases API. Do not add a personal access
token, `GITHUB_TOKEN`, or any other GitHub credential to the installer or
dashboard.

## Before building

1. Merge and test the intended source revision.
2. Set the new version consistently in:
   - `package.json`
   - `package-lock.json` (top-level and root package record)
   - `Morphly-Voice-Dashboard/package.json`
   - `Morphly-Voice-Dashboard/package-lock.json` (top-level and root package
     record)
3. Review and document permission to redistribute Beatrice V2 and every RVC
   voice model bundled in this installer. The build checks file presence; it
   cannot grant copyright, consent, publicity, or redistribution rights.
4. Build and verify the dashboard and application tests.

## Automated release build

Pushing a stable tag such as `v0.2.4` runs the Windows release workflow. The
workflow validates that every package version matches the tag, installs locked
JavaScript dependencies, restores and verifies the runtime seed, runs tests,
builds the installer, retains a workflow artifact, then creates a draft GitHub
Release. It publishes the release only after GitHub reports both exact assets
with the expected sizes and available SHA-256 digests.

The workflow may also be started manually for an existing tag. It never
overwrites a release asset: a public release with a missing or mismatched asset
causes the job to fail.

## Local fallback build

On a provisioned Windows packaging machine, run the packaging preflight and
then the large build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Test-MorphlyPackaging.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Build-MorphlyInstaller.ps1 -Version 0.2.0 -ConfirmLargeBuild
```

The build must produce the exact `.exe` and `.exe.sha256` names under
`packaging/output`. Code-sign and timestamp the installer before distribution;
if signing changes the executable, regenerate its SHA-256 sidecar afterward.

The installer treats RVC settings, Beatrice audio settings, and Beatrice slot 1
parameters as user-owned mutable data. Their neutral defaults are installed
only when the files do not already exist, so an in-place update does not reset
the user's selected devices, voice, pitch, or formant controls. Temporary
engine uploads and logs are not packaged.

## Validate without contacting GitHub

Run the focused publisher checks:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Test-PublishMorphlyRelease.ps1
```

Validate the real installer without making any GitHub request or change:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Publish-MorphlyRelease.ps1 -Version 0.2.0 -ValidateOnly
```

## Publish safely

Install GitHub CLI and authenticate the packaging machine with `gh auth login`.
Credentials remain in GitHub CLI's secure credential store; the publisher does
not read, print, or embed a token.

To upload a verified draft while keeping it private from application updaters:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Publish-MorphlyRelease.ps1 -Version 0.2.0
```

The script refuses an existing tag or release. A draft created by the command
above therefore remains for manual review and publication in GitHub; it is not
a rehearsal that should be rerun under the same version.

For the normal release operation, provide both explicit approval switches on
the first invocation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\Publish-MorphlyRelease.ps1 -Version 0.2.0 -Publish -ConfirmDistributionRights
```

Even with those switches, the script creates a draft first. It then re-queries
GitHub, requires both assets to be fully uploaded with their exact names and
sizes, validates any SHA-256 digests returned by GitHub, and only then makes the
release public and explicitly marks it as GitHub's latest release. It also
refuses to publish a version that is not newer than the current latest stable
release. If remote verification fails, the release remains a draft for
inspection.

`-Publish` without `-ConfirmDistributionRights` fails before GitHub is
contacted. `-ValidateOnly` never contacts or changes GitHub.

## After publication

1. Open the GitHub Release and confirm both assets and release notes.
2. On an installed older version, use **Settings > Check for updates**.
3. Confirm download progress, SHA-256 verification, and the explicit Install
   action.
4. Confirm the updated installation reports the new version and does not offer
   the same update again.

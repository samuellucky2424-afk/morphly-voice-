from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen


GITHUB_REPOSITORY = "samuellucky2424-afk/morphly-voice-"
GITHUB_API_URL = f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest"
GITHUB_WEB_ROOT = f"https://github.com/{GITHUB_REPOSITORY}"
GITHUB_ASSET_LIMIT_BYTES = 2 * 1024 * 1024 * 1024
MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024
MAX_CHECKSUM_RESPONSE_BYTES = 4096
DOWNLOAD_BUFFER_SIZE = 1024 * 1024
DOWNLOAD_DISK_RESERVE_BYTES = 256 * 1024 * 1024
HTTP_TIMEOUT_SECONDS = 30.0

_SEMVER_PATTERN = re.compile(r"^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$")
_SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
_ALLOWED_RELEASE_ASSET_REDIRECT_HOSTS = {
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
}


class HttpResponse(Protocol):
    status: int
    headers: Mapping[str, str]

    def read(self, amount: int = -1) -> bytes: ...

    def geturl(self) -> str: ...

    def __enter__(self) -> "HttpResponse": ...

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> object: ...


UrlOpener = Callable[[Request, float], HttpResponse]
FreeSpaceProvider = Callable[[Path], int]
ProcessLauncher = Callable[[list[str], Path], None]


class UpdaterError(RuntimeError):
    """Base class for errors safe to show in the updater UI."""


class UpdaterStateError(UpdaterError):
    """Raised when an updater action is invalid for the current phase."""


class UpdaterSecurityError(UpdaterError):
    """Raised when remote release metadata or content fails validation."""


@dataclass(frozen=True)
class ReleaseInfo:
    version: str
    tag: str
    name: str
    notes: str
    release_url: str
    installer_name: str
    installer_url: str
    installer_size: int
    installer_digest: str | None
    checksum_name: str
    checksum_url: str
    checksum_size: int


def parse_stable_semver(value: str) -> tuple[int, int, int]:
    match = _SEMVER_PATTERN.fullmatch(value.strip())
    if not match:
        raise ValueError(f"Version must be a stable semantic version: {value}")
    return tuple(int(part) for part in match.groups())  # type: ignore[return-value]


def normalize_stable_semver(value: str) -> str:
    major, minor, patch = parse_stable_semver(value)
    return f"{major}.{minor}.{patch}"


def load_current_version(application_root: Path) -> str:
    for filename in ("build-manifest.json", "package.json"):
        candidate = application_root / filename
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8-sig"))
            return normalize_stable_semver(str(payload["version"]))
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            continue
    raise UpdaterError("Morphly version metadata is missing or invalid.")


def default_update_root() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / "Morphly Voice" / "Updates"
    return Path.home() / ".local" / "share" / "Morphly Voice" / "Updates"


def _default_url_opener(request: Request, timeout: float) -> HttpResponse:
    return urlopen(request, timeout=timeout)  # type: ignore[return-value]


def _default_free_space_provider(path: Path) -> int:
    return shutil.disk_usage(path).free


def _default_process_launcher(arguments: list[str], working_directory: Path) -> None:
    creation_flags = 0
    if os.name == "nt":
        creation_flags = (
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            | getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    subprocess.Popen(
        arguments,
        cwd=str(working_directory),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
        close_fds=True,
        creationflags=creation_flags,
    )


def _utc_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _path_is_inside(candidate: Path, parent: Path) -> bool:
    try:
        candidate.relative_to(parent)
        return True
    except ValueError:
        return False


def _response_status(response: HttpResponse) -> int:
    status = getattr(response, "status", None)
    if isinstance(status, int):
        return status
    getcode = getattr(response, "getcode", None)
    if callable(getcode):
        value = getcode()
        if isinstance(value, int):
            return value
    raise UpdaterError("The update server returned an invalid HTTP response.")


def _header(response: HttpResponse, name: str) -> str | None:
    headers = getattr(response, "headers", {})
    value = headers.get(name)
    if value is None:
        value = headers.get(name.lower())
    return str(value) if value is not None else None


class MorphlyUpdater:
    def __init__(
        self,
        application_root: Path,
        *,
        current_version: str | None = None,
        update_root: Path | None = None,
        helper_source: Path | None = None,
        restart_launcher: Path | None = None,
        url_opener: UrlOpener = _default_url_opener,
        free_space_provider: FreeSpaceProvider = _default_free_space_provider,
        process_launcher: ProcessLauncher = _default_process_launcher,
        platform_supported: bool | None = None,
    ):
        self.application_root = application_root.resolve()
        self.update_root = (update_root or default_update_root()).resolve()
        self.helper_source = (helper_source or self.application_root / "morphly_update_helper.ps1").resolve()
        self.restart_launcher = (restart_launcher or self.application_root / "start_http.bat").resolve()
        self._url_opener = url_opener
        self._free_space_provider = free_space_provider
        self._process_launcher = process_launcher
        self._state_lock = threading.RLock()
        self._operation_lock = threading.Lock()
        self._download_thread: threading.Thread | None = None
        self._release: ReleaseInfo | None = None
        self._expected_sidecar_digest: str | None = None
        self._phase = "idle"
        self._downloaded_bytes = 0
        self._total_bytes = 0
        self._last_checked_at: str | None = None
        self._error: str | None = None

        try:
            self.current_version = normalize_stable_semver(current_version or load_current_version(self.application_root))
            if _path_is_inside(self.update_root, self.application_root):
                raise UpdaterError("The update download directory must be outside the Morphly installation directory.")
            if platform_supported is None:
                platform_supported = os.name == "nt"
            if not platform_supported:
                raise UpdaterError("Automatic installation is only supported by the Windows desktop application.")
            self._supported = True
        except (OSError, ValueError, UpdaterError) as exc:
            self.current_version = "0.0.0"
            self._supported = False
            self._phase = "error"
            self._error = str(exc)

    def status(self) -> dict[str, object]:
        with self._state_lock:
            release = self._release
            update_available = bool(
                release
                and parse_stable_semver(release.version) > parse_stable_semver(self.current_version)
                and self._phase in {"available", "downloading", "ready", "installing"}
            )
            installer_ready = bool(
                release
                and self._phase == "ready"
                and self._installer_path(release).is_file()
            )
            progress = 0
            if self._total_bytes > 0:
                progress = min(100, max(0, int(self._downloaded_bytes * 100 / self._total_bytes)))
            if self._phase in {"ready", "installing"}:
                progress = 100
            return {
                "ok": self._supported and self._phase != "error",
                "supported": self._supported,
                "phase": self._phase,
                "currentVersion": self.current_version,
                "latestVersion": release.version if release else None,
                "releaseName": release.name if release else None,
                "releaseNotes": release.notes if release else None,
                "releaseUrl": release.release_url if release else None,
                "downloadedBytes": self._downloaded_bytes,
                "totalBytes": self._total_bytes,
                "progressPercent": progress,
                "lastCheckedAt": self._last_checked_at,
                "error": self._error,
                "updateAvailable": update_available,
                "canInstall": installer_ready,
            }

    def check(self) -> dict[str, object]:
        if not self._supported:
            return self.status()
        with self._operation_lock:
            with self._state_lock:
                if self._phase in {"downloading", "installing"}:
                    return self.status()
                self._phase = "checking"
                self._error = None
                self._release = None
                self._expected_sidecar_digest = None
                self._downloaded_bytes = 0
                self._total_bytes = 0
            try:
                release = self._fetch_latest_release()
                checked_at = _utc_timestamp()
                cached_digest: str | None = None
                if (
                    release is not None
                    and parse_stable_semver(release.version) > parse_stable_semver(self.current_version)
                ):
                    cached_digest = self._verified_cached_digest(release)
                with self._state_lock:
                    self._last_checked_at = checked_at
                    if release is None:
                        self._phase = "up_to_date"
                        return self.status()
                    self._release = release
                    self._total_bytes = release.installer_size
                    if parse_stable_semver(release.version) <= parse_stable_semver(self.current_version):
                        self._phase = "up_to_date"
                    elif cached_digest:
                        self._expected_sidecar_digest = cached_digest
                        self._downloaded_bytes = release.installer_size
                        self._phase = "ready"
                    else:
                        self._phase = "available"
                    return self.status()
            except Exception as exc:
                return self._record_error(exc, checked=True)

    def start_download(self) -> dict[str, object]:
        if not self._supported:
            raise UpdaterStateError(self._error or "The updater is unavailable.")
        with self._operation_lock:
            with self._state_lock:
                if self._phase == "downloading":
                    return self.status()
                if self._phase == "ready":
                    return self.status()
                if self._phase != "available" or self._release is None:
                    raise UpdaterStateError("Check for an available update before downloading it.")
                release = self._release
                self.update_root.mkdir(parents=True, exist_ok=True)
                required_free_space = release.installer_size + max(
                    DOWNLOAD_DISK_RESERVE_BYTES,
                    release.installer_size // 20,
                )
                available_space = self._free_space_provider(self.update_root)
                if available_space < required_free_space:
                    error = UpdaterError(
                        "There is not enough free disk space to download the Morphly update. "
                        f"At least {required_free_space} bytes are required."
                    )
                    self._phase = "error"
                    self._error = str(error)
                    raise error
                self._phase = "downloading"
                self._error = None
                self._downloaded_bytes = 0
                self._total_bytes = release.installer_size
                thread = threading.Thread(
                    target=self._download_worker,
                    args=(release,),
                    name="morphly-update-download",
                    daemon=True,
                )
                self._download_thread = thread
                thread.start()
                return self.status()

    def wait_for_download(self, timeout: float | None = None) -> bool:
        with self._state_lock:
            thread = self._download_thread
        if thread is None:
            return True
        thread.join(timeout=timeout)
        return not thread.is_alive()

    def install(
        self,
        *,
        parent_pid: int | None = None,
        restart_after_install: bool = False,
    ) -> dict[str, object]:
        if not self._supported:
            raise UpdaterStateError(self._error or "The updater is unavailable.")
        with self._operation_lock:
            with self._state_lock:
                if self._phase != "ready" or self._release is None:
                    raise UpdaterStateError("Download and verify an update before installing it.")
                release = self._release

            installer_path = self._installer_path(release)
            checksum_path = self._checksum_path(release)
            if not installer_path.is_file() or not checksum_path.is_file():
                raise UpdaterStateError("The verified installer files are missing. Download the update again.")
            try:
                actual_digest = self._hash_file(installer_path, expected_size=release.installer_size)
                sidecar_digest = self._parse_checksum(checksum_path.read_bytes(), release.installer_name)
                if actual_digest != sidecar_digest:
                    raise UpdaterSecurityError("The installer no longer matches its SHA-256 checksum.")
                if self._expected_sidecar_digest and actual_digest != self._expected_sidecar_digest:
                    raise UpdaterSecurityError("The installer checksum changed after verification.")
                if release.installer_digest and actual_digest != release.installer_digest:
                    raise UpdaterSecurityError("The installer does not match GitHub's release digest.")
            except (OSError, UpdaterError) as exc:
                installer_path.unlink(missing_ok=True)
                checksum_path.unlink(missing_ok=True)
                error = exc if isinstance(exc, UpdaterError) else UpdaterError("The verified installer could not be read.")
                self._record_error(error)
                if error is exc:
                    raise
                raise error from exc
            if not self.helper_source.is_file():
                error = UpdaterError("The Morphly update helper is missing from this installation.")
                self._record_error(error)
                raise error
            if not self.restart_launcher.is_file():
                error = UpdaterError("The Morphly application launcher is missing from this installation.")
                self._record_error(error)
                raise error

            helper_path = self.update_root / f"Morphly-Voice-Updater-{release.version}.ps1"
            helper_part_path = helper_path.with_suffix(helper_path.suffix + ".part")
            try:
                shutil.copyfile(self.helper_source, helper_part_path)
                os.replace(helper_part_path, helper_path)
            except OSError as exc:
                helper_part_path.unlink(missing_ok=True)
                error = UpdaterError("The detached Morphly update helper could not be prepared.")
                self._record_error(error)
                raise error from exc
            powershell = Path(
                os.environ.get("SystemRoot", r"C:\Windows")
            ) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            arguments = [
                str(powershell if powershell.is_file() else "powershell.exe"),
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(helper_path),
                "-ParentPid",
                str(parent_pid or os.getpid()),
                "-InstallerPath",
                str(installer_path),
                "-ExpectedSha256",
                actual_digest,
                "-ApplicationRoot",
                str(self.application_root),
                "-RestartLauncher",
                str(self.restart_launcher),
            ]
            if restart_after_install:
                arguments.append("-RestartAfterInstall")
            try:
                self._process_launcher(arguments, self.update_root)
            except OSError as exc:
                error = UpdaterError("Windows could not start the detached Morphly update helper.")
                self._record_error(error)
                raise error from exc
            with self._state_lock:
                self._phase = "installing"
                self._error = None
                return self.status()

    def _fetch_latest_release(self) -> ReleaseInfo | None:
        request = Request(
            GITHUB_API_URL,
            headers={
                "Accept": "application/vnd.github+json",
                "Accept-Encoding": "identity",
                "User-Agent": "MorphlyVoiceUpdater/1.0",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            method="GET",
        )
        try:
            with self._url_opener(request, HTTP_TIMEOUT_SECONDS) as response:
                status = _response_status(response)
                if status == 404:
                    return None
                if status != 200:
                    raise UpdaterError(f"GitHub returned HTTP {status} while checking for updates.")
                self._validate_api_response_url(response.geturl())
                payload_bytes = response.read(MAX_RELEASE_RESPONSE_BYTES + 1)
        except HTTPError as exc:
            if exc.code == 404:
                return None
            raise UpdaterError(f"GitHub returned HTTP {exc.code} while checking for updates.") from exc
        except (OSError, URLError) as exc:
            raise UpdaterError("Morphly could not contact GitHub to check for updates.") from exc
        if len(payload_bytes) > MAX_RELEASE_RESPONSE_BYTES:
            raise UpdaterSecurityError("The GitHub release response is unexpectedly large.")
        try:
            payload = json.loads(payload_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UpdaterSecurityError("GitHub returned invalid release metadata.") from exc
        if not isinstance(payload, dict):
            raise UpdaterSecurityError("GitHub returned invalid release metadata.")
        return self._parse_release(payload)

    def _parse_release(self, payload: dict[str, object]) -> ReleaseInfo:
        if payload.get("draft") is not False or payload.get("prerelease") is not False:
            raise UpdaterSecurityError("The latest GitHub release is not a stable published release.")
        tag = str(payload.get("tag_name", "")).strip()
        version = normalize_stable_semver(tag)
        installer_name = f"Morphly-Voice-Setup-{version}.exe"
        checksum_name = f"{installer_name}.sha256"
        release_url = str(payload.get("html_url", "")).strip()
        self._validate_release_page_url(release_url, tag)
        assets = payload.get("assets")
        if not isinstance(assets, list):
            raise UpdaterSecurityError("The GitHub release does not contain an asset list.")
        matching_installers = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == installer_name]
        matching_checksums = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == checksum_name]
        if len(matching_installers) != 1 or len(matching_checksums) != 1:
            raise UpdaterSecurityError(
                f"The release must contain exactly one {installer_name} and one {checksum_name} asset."
            )
        installer = matching_installers[0]
        checksum = matching_checksums[0]
        if installer.get("state") != "uploaded" or checksum.get("state") != "uploaded":
            raise UpdaterSecurityError("The GitHub release assets have not finished uploading.")
        installer_url = str(installer.get("browser_download_url", "")).strip()
        checksum_url = str(checksum.get("browser_download_url", "")).strip()
        self._validate_release_asset_url(installer_url, tag, installer_name)
        self._validate_release_asset_url(checksum_url, tag, checksum_name)
        try:
            installer_size = int(installer["size"])
            checksum_size = int(checksum["size"])
        except (KeyError, TypeError, ValueError) as exc:
            raise UpdaterSecurityError("The GitHub release asset size is invalid.") from exc
        if installer_size <= 0 or installer_size >= GITHUB_ASSET_LIMIT_BYTES:
            raise UpdaterSecurityError("The installer size is outside GitHub's supported release-asset range.")
        if checksum_size <= 0 or checksum_size > MAX_CHECKSUM_RESPONSE_BYTES:
            raise UpdaterSecurityError("The installer checksum asset has an invalid size.")
        digest_value = installer.get("digest")
        installer_digest: str | None = None
        if digest_value not in (None, ""):
            digest_text = str(digest_value).strip()
            if not digest_text.startswith("sha256:") or not _SHA256_PATTERN.fullmatch(digest_text[7:]):
                raise UpdaterSecurityError("GitHub returned an unsupported installer digest.")
            installer_digest = digest_text[7:].lower()
        name = str(payload.get("name") or f"Morphly Voice {version}").strip()[:200]
        notes = str(payload.get("body") or "").strip()[:65536]
        return ReleaseInfo(
            version=version,
            tag=tag,
            name=name,
            notes=notes,
            release_url=release_url,
            installer_name=installer_name,
            installer_url=installer_url,
            installer_size=installer_size,
            installer_digest=installer_digest,
            checksum_name=checksum_name,
            checksum_url=checksum_url,
            checksum_size=checksum_size,
        )

    def _download_worker(self, release: ReleaseInfo) -> None:
        installer_path = self._installer_path(release)
        installer_part_path = installer_path.with_suffix(installer_path.suffix + ".part")
        checksum_path = self._checksum_path(release)
        checksum_part_path = checksum_path.with_suffix(checksum_path.suffix + ".part")
        try:
            for stale_path in (installer_part_path, checksum_part_path):
                stale_path.unlink(missing_ok=True)
            checksum_bytes = self._download_small_asset(
                release.checksum_url,
                expected_size=release.checksum_size,
                maximum_size=MAX_CHECKSUM_RESPONSE_BYTES,
            )
            sidecar_digest = self._parse_checksum(checksum_bytes, release.installer_name)
            checksum_part_path.write_bytes(checksum_bytes)

            request = Request(
                release.installer_url,
                headers={
                    "Accept": "application/octet-stream",
                    "Accept-Encoding": "identity",
                    "User-Agent": "MorphlyVoiceUpdater/1.0",
                },
                method="GET",
            )
            digest = hashlib.sha256()
            downloaded = 0
            with self._url_opener(request, HTTP_TIMEOUT_SECONDS) as response:
                status = _response_status(response)
                if status != 200:
                    raise UpdaterError(f"GitHub returned HTTP {status} while downloading the installer.")
                self._validate_asset_response_url(response.geturl())
                content_length = _header(response, "Content-Length")
                if content_length is not None:
                    try:
                        response_size = int(content_length)
                    except ValueError as exc:
                        raise UpdaterSecurityError("The installer download length is invalid.") from exc
                    if response_size != release.installer_size:
                        raise UpdaterSecurityError("The installer download length does not match the GitHub release.")
                with installer_part_path.open("wb") as destination:
                    while True:
                        chunk = response.read(DOWNLOAD_BUFFER_SIZE)
                        if not chunk:
                            break
                        downloaded += len(chunk)
                        if downloaded > release.installer_size or downloaded >= GITHUB_ASSET_LIMIT_BYTES:
                            raise UpdaterSecurityError("The installer download exceeded its declared size.")
                        destination.write(chunk)
                        digest.update(chunk)
                        with self._state_lock:
                            self._downloaded_bytes = downloaded
            if downloaded != release.installer_size:
                raise UpdaterSecurityError("The installer download ended before its declared size.")
            actual_digest = digest.hexdigest().lower()
            if actual_digest != sidecar_digest:
                raise UpdaterSecurityError("The installer does not match its SHA-256 checksum asset.")
            if release.installer_digest and actual_digest != release.installer_digest:
                raise UpdaterSecurityError("The installer does not match GitHub's release digest.")
            os.replace(checksum_part_path, checksum_path)
            os.replace(installer_part_path, installer_path)
            with self._state_lock:
                if self._release != release:
                    raise UpdaterStateError("The selected update changed while it was downloading.")
                self._expected_sidecar_digest = sidecar_digest
                self._downloaded_bytes = downloaded
                self._phase = "ready"
                self._error = None
        except Exception as exc:
            installer_part_path.unlink(missing_ok=True)
            checksum_part_path.unlink(missing_ok=True)
            self._record_error(exc)

    def _download_small_asset(self, url: str, *, expected_size: int, maximum_size: int) -> bytes:
        request = Request(
            url,
            headers={
                "Accept": "application/octet-stream",
                "Accept-Encoding": "identity",
                "User-Agent": "MorphlyVoiceUpdater/1.0",
            },
            method="GET",
        )
        with self._url_opener(request, HTTP_TIMEOUT_SECONDS) as response:
            status = _response_status(response)
            if status != 200:
                raise UpdaterError(f"GitHub returned HTTP {status} while downloading the checksum.")
            self._validate_asset_response_url(response.geturl())
            content = response.read(maximum_size + 1)
        if len(content) > maximum_size:
            raise UpdaterSecurityError("The installer checksum response is unexpectedly large.")
        if len(content) != expected_size:
            raise UpdaterSecurityError("The installer checksum length does not match the GitHub release.")
        return content

    def _verified_cached_digest(self, release: ReleaseInfo) -> str | None:
        installer_path = self._installer_path(release)
        checksum_path = self._checksum_path(release)
        if not installer_path.exists() and not checksum_path.exists():
            return None
        try:
            if not installer_path.is_file() or not checksum_path.is_file():
                raise UpdaterSecurityError("The cached update is incomplete.")
            if checksum_path.stat().st_size != release.checksum_size:
                raise UpdaterSecurityError("The cached checksum size is invalid.")
            sidecar_digest = self._parse_checksum(checksum_path.read_bytes(), release.installer_name)
            actual_digest = self._hash_file(installer_path, expected_size=release.installer_size)
            if actual_digest != sidecar_digest:
                raise UpdaterSecurityError("The cached installer does not match its checksum.")
            if release.installer_digest and actual_digest != release.installer_digest:
                raise UpdaterSecurityError("The cached installer does not match GitHub's release digest.")
            return actual_digest
        except (OSError, UpdaterError):
            installer_path.unlink(missing_ok=True)
            checksum_path.unlink(missing_ok=True)
            return None

    @staticmethod
    def _parse_checksum(content: bytes, installer_name: str) -> str:
        try:
            lines = [line.strip() for line in content.decode("utf-8-sig").splitlines() if line.strip()]
        except UnicodeDecodeError as exc:
            raise UpdaterSecurityError("The installer checksum asset is not valid UTF-8.") from exc
        if len(lines) != 1:
            raise UpdaterSecurityError("The installer checksum asset must contain exactly one checksum.")
        pattern = re.compile(rf"^([0-9a-fA-F]{{64}})\s+\*?{re.escape(installer_name)}$")
        match = pattern.fullmatch(lines[0])
        if not match:
            raise UpdaterSecurityError("The installer checksum asset has an invalid format or filename.")
        return match.group(1).lower()

    @staticmethod
    def _hash_file(path: Path, *, expected_size: int) -> str:
        digest = hashlib.sha256()
        total = 0
        with path.open("rb") as source:
            while chunk := source.read(DOWNLOAD_BUFFER_SIZE):
                total += len(chunk)
                if total > expected_size:
                    raise UpdaterSecurityError("The installer file is larger than its verified release size.")
                digest.update(chunk)
        if total != expected_size:
            raise UpdaterSecurityError("The installer file size changed after verification.")
        return digest.hexdigest().lower()

    def _installer_path(self, release: ReleaseInfo) -> Path:
        return self.update_root / release.installer_name

    def _checksum_path(self, release: ReleaseInfo) -> Path:
        return self.update_root / release.checksum_name

    @staticmethod
    def _validate_api_response_url(url: str) -> None:
        parsed = urlsplit(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "api.github.com"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.query
            or parsed.fragment
            or unquote(parsed.path).rstrip("/") != f"/repos/{GITHUB_REPOSITORY}/releases/latest"
        ):
            raise UpdaterSecurityError("GitHub redirected the release check to an unexpected URL.")

    @staticmethod
    def _validate_release_page_url(url: str, tag: str) -> None:
        parsed = urlsplit(url)
        expected_path = f"/{GITHUB_REPOSITORY}/releases/tag/{tag}"
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.query
            or parsed.fragment
            or unquote(parsed.path).rstrip("/") != expected_path
        ):
            raise UpdaterSecurityError("The GitHub release page URL is invalid.")

    @staticmethod
    def _validate_release_asset_url(url: str, tag: str, filename: str) -> None:
        parsed = urlsplit(url)
        expected_path = f"/{GITHUB_REPOSITORY}/releases/download/{tag}/{filename}"
        if (
            parsed.scheme != "https"
            or parsed.hostname != "github.com"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or parsed.query
            or parsed.fragment
            or unquote(parsed.path) != expected_path
        ):
            raise UpdaterSecurityError(f"The GitHub release asset URL for {filename} is invalid.")

    @staticmethod
    def _validate_asset_response_url(url: str) -> None:
        parsed = urlsplit(url)
        hostname = (parsed.hostname or "").lower()
        if (
            parsed.scheme != "https"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.port not in (None, 443)
            or hostname not in _ALLOWED_RELEASE_ASSET_REDIRECT_HOSTS
        ):
            raise UpdaterSecurityError("GitHub redirected an update asset to an unexpected host.")

    def _record_error(self, exc: Exception, *, checked: bool = False) -> dict[str, object]:
        message = str(exc).strip() or "The update operation failed."
        with self._state_lock:
            self._phase = "error"
            self._error = message[:1000]
            if checked:
                self._last_checked_at = _utc_timestamp()
            return self.status()

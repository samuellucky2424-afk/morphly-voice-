from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request

import pytest

from morphly_updater import (
    GITHUB_API_URL,
    GITHUB_ASSET_LIMIT_BYTES,
    MorphlyUpdater,
    UpdaterStateError,
    load_current_version,
    normalize_stable_semver,
    parse_stable_semver,
)


VERSION = "0.2.0"
TAG = f"v{VERSION}"
INSTALLER_NAME = f"Morphly-Voice-Setup-{VERSION}.exe"
CHECKSUM_NAME = f"{INSTALLER_NAME}.sha256"
INSTALLER_URL = (
    f"https://github.com/samuellucky2424-afk/morphly-voice-/releases/download/{TAG}/{INSTALLER_NAME}"
)
CHECKSUM_URL = f"{INSTALLER_URL}.sha256"
STATUS_KEYS = {
    "ok",
    "supported",
    "phase",
    "currentVersion",
    "latestVersion",
    "releaseName",
    "releaseNotes",
    "releaseUrl",
    "downloadedBytes",
    "totalBytes",
    "progressPercent",
    "lastCheckedAt",
    "error",
    "updateAvailable",
    "canInstall",
}


class FakeResponse:
    def __init__(
        self,
        body: bytes,
        *,
        url: str,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ):
        self._body = io.BytesIO(body)
        self._url = url
        self.status = status
        self.headers = headers or {}

    def read(self, amount: int = -1) -> bytes:
        return self._body.read(amount)

    def geturl(self) -> str:
        return self._url

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
        return None


class FakeOpener:
    def __init__(self, responses: dict[str, list[FakeResponse] | Exception]):
        self.responses = responses
        self.requests: list[Request] = []

    def __call__(self, request: Request, _timeout: float) -> FakeResponse:
        self.requests.append(request)
        result = self.responses.get(request.full_url)
        if isinstance(result, Exception):
            raise result
        if not result:
            raise AssertionError(f"Unexpected network request: {request.full_url}")
        return result.pop(0)


def release_payload(
    installer: bytes,
    checksum: bytes,
    *,
    installer_url: str = INSTALLER_URL,
    installer_size: int | None = None,
    digest: str | None = None,
    prerelease: bool = False,
) -> dict[str, object]:
    actual_digest = hashlib.sha256(installer).hexdigest()
    return {
        "tag_name": TAG,
        "name": "Morphly Voice 0.2.0",
        "body": "Secure updater release",
        "html_url": f"https://github.com/samuellucky2424-afk/morphly-voice-/releases/tag/{TAG}",
        "draft": False,
        "prerelease": prerelease,
        "assets": [
            {
                "name": INSTALLER_NAME,
                "state": "uploaded",
                "size": len(installer) if installer_size is None else installer_size,
                "digest": f"sha256:{digest or actual_digest}",
                "browser_download_url": installer_url,
            },
            {
                "name": CHECKSUM_NAME,
                "state": "uploaded",
                "size": len(checksum),
                "browser_download_url": CHECKSUM_URL,
            },
        ],
    }


def release_response(payload: dict[str, object]) -> FakeResponse:
    return FakeResponse(json.dumps(payload).encode(), url=GITHUB_API_URL)


def create_manager(
    tmp_path: Path,
    opener: FakeOpener,
    *,
    update_root: Path | None = None,
    process_launcher=None,
) -> MorphlyUpdater:
    app_root = tmp_path / "app"
    app_root.mkdir(exist_ok=True)
    (app_root / "morphly_update_helper.ps1").write_text("# test helper\n", encoding="utf-8")
    (app_root / "start_http.bat").write_text("@echo off\n", encoding="utf-8")
    return MorphlyUpdater(
        app_root,
        current_version="0.1.0",
        update_root=update_root or tmp_path / "local-data" / "Updates",
        url_opener=opener,
        free_space_provider=lambda _path: 10 * 1024 * 1024 * 1024,
        process_launcher=process_launcher or (lambda _arguments, _cwd: None),
        platform_supported=True,
    )


def test_stable_semver_and_manifest_version_loading(tmp_path: Path):
    assert parse_stable_semver("v1.2.3") == (1, 2, 3)
    assert normalize_stable_semver("v1.2.3") == "1.2.3"
    for invalid in ("1.2", "1.2.3-beta", "01.2.3", "1.2.3+build"):
        with pytest.raises(ValueError):
            parse_stable_semver(invalid)

    (tmp_path / "package.json").write_text('{"version":"0.1.0"}', encoding="utf-8")
    assert load_current_version(tmp_path) == "0.1.0"
    (tmp_path / "build-manifest.json").write_text('{"version":"0.2.0"}', encoding="utf-8")
    assert load_current_version(tmp_path) == "0.2.0"


def test_latest_release_404_is_nonfatal_up_to_date(tmp_path: Path):
    not_found = HTTPError(GITHUB_API_URL, 404, "Not Found", hdrs=None, fp=None)
    updater = create_manager(tmp_path, FakeOpener({GITHUB_API_URL: not_found}))

    status = updater.check()

    assert set(status) == STATUS_KEYS
    assert status["ok"] is True
    assert status["supported"] is True
    assert status["phase"] == "up_to_date"
    assert status["currentVersion"] == "0.1.0"
    assert status["latestVersion"] is None
    assert status["updateAvailable"] is False
    assert status["canInstall"] is False
    assert status["error"] is None
    assert status["lastCheckedAt"]


@pytest.mark.parametrize(
    ("payload_patch", "expected_error"),
    [
        ({"prerelease": True}, "not a stable published release"),
        ({"installer_url": "https://evil.example/Morphly-Voice-Setup-0.2.0.exe"}, "asset URL"),
        ({"installer_size": GITHUB_ASSET_LIMIT_BYTES}, "outside GitHub's supported"),
    ],
)
def test_check_rejects_unsafe_or_unsupported_releases(tmp_path: Path, payload_patch, expected_error):
    installer = b"installer"
    checksum = f"{hashlib.sha256(installer).hexdigest()} *{INSTALLER_NAME}\n".encode()
    payload = release_payload(
        installer,
        checksum,
        installer_url=payload_patch.get("installer_url", INSTALLER_URL),
        installer_size=payload_patch.get("installer_size"),
        prerelease=payload_patch.get("prerelease", False),
    )
    updater = create_manager(tmp_path, FakeOpener({GITHUB_API_URL: [release_response(payload)]}))

    status = updater.check()

    assert status["ok"] is False
    assert status["phase"] == "error"
    assert expected_error in str(status["error"])
    assert status["canInstall"] is False


def test_async_download_verifies_both_hashes_and_atomically_promotes_files(tmp_path: Path):
    installer = (b"Morphly installer payload" * 1024) + b"end"
    digest = hashlib.sha256(installer).hexdigest()
    checksum = f"{digest} *{INSTALLER_NAME}\n".encode()
    payload = release_payload(installer, checksum)
    opener = FakeOpener(
        {
            GITHUB_API_URL: [release_response(payload)],
            CHECKSUM_URL: [
                FakeResponse(
                    checksum,
                    url="https://release-assets.githubusercontent.com/checksum",
                    headers={"Content-Length": str(len(checksum))},
                )
            ],
            INSTALLER_URL: [
                FakeResponse(
                    installer,
                    url="https://release-assets.githubusercontent.com/installer",
                    headers={"Content-Length": str(len(installer))},
                )
            ],
        }
    )
    updater = create_manager(tmp_path, opener)

    assert updater.check()["phase"] == "available"
    assert updater.start_download()["phase"] == "downloading"
    assert updater.wait_for_download(timeout=5)
    status = updater.status()

    update_root = tmp_path / "local-data" / "Updates"
    assert status["phase"] == "ready"
    assert status["progressPercent"] == 100
    assert status["downloadedBytes"] == len(installer)
    assert status["canInstall"] is True
    assert (update_root / INSTALLER_NAME).read_bytes() == installer
    assert (update_root / CHECKSUM_NAME).read_bytes() == checksum
    assert not list(update_root.glob("*.part"))


def test_check_reuses_verified_complete_download_and_removes_invalid_cache(tmp_path: Path):
    installer = b"cached installer"
    digest = hashlib.sha256(installer).hexdigest()
    checksum = f"{digest} *{INSTALLER_NAME}\n".encode()
    payload = release_payload(installer, checksum)
    update_root = tmp_path / "downloads"
    update_root.mkdir()
    (update_root / INSTALLER_NAME).write_bytes(installer)
    (update_root / CHECKSUM_NAME).write_bytes(checksum)

    updater = create_manager(
        tmp_path,
        FakeOpener({GITHUB_API_URL: [release_response(payload)]}),
        update_root=update_root,
    )
    status = updater.check()
    assert status["phase"] == "ready"
    assert status["canInstall"] is True
    assert status["downloadedBytes"] == len(installer)

    (update_root / INSTALLER_NAME).write_bytes(b"tampered")
    second = create_manager(
        tmp_path,
        FakeOpener({GITHUB_API_URL: [release_response(payload)]}),
        update_root=update_root,
    )
    second_status = second.check()
    assert second_status["phase"] == "available"
    assert second_status["canInstall"] is False
    assert not (update_root / INSTALLER_NAME).exists()
    assert not (update_root / CHECKSUM_NAME).exists()


def test_hash_mismatch_never_exposes_installer_as_ready(tmp_path: Path):
    installer = b"installer"
    wrong_digest = hashlib.sha256(b"different").hexdigest()
    checksum = f"{wrong_digest} *{INSTALLER_NAME}\n".encode()
    payload = release_payload(installer, checksum)
    opener = FakeOpener(
        {
            GITHUB_API_URL: [release_response(payload)],
            CHECKSUM_URL: [FakeResponse(checksum, url="https://release-assets.githubusercontent.com/checksum")],
            INSTALLER_URL: [
                FakeResponse(
                    installer,
                    url="https://release-assets.githubusercontent.com/installer",
                    headers={"Content-Length": str(len(installer))},
                )
            ],
        }
    )
    updater = create_manager(tmp_path, opener)

    updater.check()
    updater.start_download()
    assert updater.wait_for_download(timeout=5)
    status = updater.status()

    assert status["phase"] == "error"
    assert status["canInstall"] is False
    assert "checksum" in str(status["error"]).lower()
    assert not (tmp_path / "local-data" / "Updates" / INSTALLER_NAME).exists()


def test_install_reverifies_and_launches_detached_helper_explicitly(tmp_path: Path):
    installer = b"verified installer"
    digest = hashlib.sha256(installer).hexdigest()
    checksum = f"{digest} *{INSTALLER_NAME}\n".encode()
    payload = release_payload(installer, checksum)
    update_root = tmp_path / "updates"
    update_root.mkdir()
    (update_root / INSTALLER_NAME).write_bytes(installer)
    (update_root / CHECKSUM_NAME).write_bytes(checksum)
    launches: list[tuple[list[str], Path]] = []
    updater = create_manager(
        tmp_path,
        FakeOpener({GITHUB_API_URL: [release_response(payload)]}),
        update_root=update_root,
        process_launcher=lambda arguments, cwd: launches.append((arguments, cwd)),
    )

    assert updater.check()["phase"] == "ready"
    status = updater.install(parent_pid=456, restart_after_install=True)

    assert status["phase"] == "installing"
    assert status["canInstall"] is False
    assert len(launches) == 1
    arguments, cwd = launches[0]
    assert cwd == update_root.resolve()
    assert arguments[arguments.index("-ParentPid") + 1] == "456"
    assert arguments[arguments.index("-ExpectedSha256") + 1] == digest
    assert "-RestartAfterInstall" in arguments
    helper_path = Path(arguments[arguments.index("-File") + 1])
    assert helper_path.parent == update_root.resolve()
    assert helper_path.is_file()

    with pytest.raises(UpdaterStateError):
        updater.install(parent_pid=456)

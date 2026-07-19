from __future__ import annotations

import argparse
import atexit
import base64
import contextlib
import http.client
import ipaddress
import json
import math
import mimetypes
import os
import re
import signal
import socket
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import timezone
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Callable
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from morphly_updater import MorphlyUpdater, UpdaterError, UpdaterStateError


REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_DASHBOARD_ROOT = REPO_ROOT / "Morphly-Voice-Dashboard" / "dist-static"
DEFAULT_LAUNCHER = REPO_ROOT / "start_engine_mode.bat"
DEFAULT_STATE_FILE = REPO_ROOT / "runtime-state" / "engine-mode.json"
DEFAULT_LOG_ROOT = REPO_ROOT / "runtime-logs"

VALID_MODES = ("rvc", "beatrice")
COPY_BUFFER_SIZE = 1024 * 1024
JSON_LIMIT = 64 * 1024
MAX_FIREBASE_TOKEN_LENGTH = 32 * 1024
MAX_CERTIFICATE_RESPONSE_BYTES = 1024 * 1024
DEFAULT_FIREBASE_PROJECT_ID = "vdc-c3a79"
GOOGLE_SECURE_TOKEN_CERTIFICATES_URL = (
    "https://www.googleapis.com/robot/v1/metadata/x509/"
    "securetoken@system.gserviceaccount.com"
)

HOP_BY_HOP_HEADERS = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

ENGINE_BOUNDARY_HEADERS = {
    "authorization",
    "cookie",
    "forwarded",
    "host",
    "origin",
    "referer",
    "x-http-method-override",
}

ENGINE_BOUNDARY_HEADER_PREFIXES = (
    "x-firebase-",
    "x-forwarded-",
    "x-morphly-",
)

ENGINE_ROUTE_PREFIXES = (
    "/api/",
    "/socket.io/",
    "/info",
    "/performance",
    "/upload_file",
    "/concat_uploaded_file",
    "/update_settings",
    "/load_model",
    "/onnx",
    "/merge_model",
    "/update_model_default",
    "/update_model_info",
    "/upload_model_assets",
    "/test",
    "/tmp/",
    "/upload_dir/",
    "/model_dir/",
    "/model_dir_static/",
)

HEALTH_PATHS = {
    "rvc": ("/info",),
    "beatrice": ("/api/server-properties/properties",),
}

UPDATER_ROUTE_PREFIX = "/api/morphly/updater/"
UPDATER_ROUTES = {
    f"{UPDATER_ROUTE_PREFIX}status",
    f"{UPDATER_ROUTE_PREFIX}check",
    f"{UPDATER_ROUTE_PREFIX}download",
    f"{UPDATER_ROUTE_PREFIX}install",
}


class FirebaseTokenVerificationError(ValueError):
    """Raised when a Firebase ID token cannot be authenticated."""


CertificateFetcher = Callable[[], tuple[dict[str, str], int]]


def _certificate_cache_seconds(cache_control: str | None, age: str | None = None) -> int:
    default_seconds = 3600
    directives = [directive.strip() for directive in (cache_control or "").split(",") if directive.strip()]
    if any(directive.lower() in {"no-cache", "no-store"} for directive in directives):
        return 0

    max_ages: list[int] = []
    for directive in directives:
        match = re.fullmatch(r'max-age\s*=\s*(?:"(\d+)"|(\d+))', directive, re.IGNORECASE)
        if match:
            max_ages.append(int(match.group(1) or match.group(2)))
    cache_seconds = min(max_ages) if max_ages else default_seconds

    if age and re.fullmatch(r"\d+", age.strip()):
        cache_seconds -= int(age.strip())
    return max(0, min(cache_seconds, 24 * 60 * 60))


def fetch_google_secure_token_certificates(
    *,
    url: str = GOOGLE_SECURE_TOKEN_CERTIFICATES_URL,
    timeout: float = 5.0,
) -> tuple[dict[str, str], int]:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "MorphlyGateway/1.0"},
        method="GET",
    )
    context = ssl.create_default_context()
    with urlopen(request, timeout=timeout, context=context) as response:  # noqa: S310 - fixed HTTPS endpoint
        body = response.read(MAX_CERTIFICATE_RESPONSE_BYTES + 1)
        if len(body) > MAX_CERTIFICATE_RESPONSE_BYTES:
            raise FirebaseTokenVerificationError("Firebase certificate response is too large.")
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            raise FirebaseTokenVerificationError("Firebase certificate response is invalid.") from exc
        if not isinstance(payload, dict) or not payload:
            raise FirebaseTokenVerificationError("Firebase certificate response is empty.")
        certificates = {
            str(key): value
            for key, value in payload.items()
            if isinstance(key, str) and key and isinstance(value, str) and value.startswith("-----BEGIN CERTIFICATE-----")
        }
        if not certificates:
            raise FirebaseTokenVerificationError("Firebase certificate response has no usable certificates.")
        return certificates, _certificate_cache_seconds(
            response.headers.get("Cache-Control"),
            response.headers.get("Age"),
        )


class FirebaseIdTokenVerifier:
    def __init__(
        self,
        project_id: str,
        *,
        certificate_fetcher: CertificateFetcher | None = None,
        clock: Callable[[], float] = time.time,
        monotonic_clock: Callable[[], float] = time.monotonic,
        clock_skew_seconds: float = 30.0,
        unknown_kid_refresh_cooldown_seconds: float = 60.0,
    ) -> None:
        if not isinstance(project_id, str):
            raise ValueError("Firebase project ID is required.")
        normalized_project_id = project_id.strip()
        if not normalized_project_id:
            raise ValueError("Firebase project ID is required.")
        self.project_id = normalized_project_id
        self.expected_issuer = f"https://securetoken.google.com/{normalized_project_id}"
        self._certificate_fetcher = certificate_fetcher or fetch_google_secure_token_certificates
        self._clock = clock
        self._monotonic_clock = monotonic_clock
        self._clock_skew_seconds = max(0.0, float(clock_skew_seconds))
        self._unknown_kid_refresh_cooldown_seconds = max(
            0.0,
            float(unknown_kid_refresh_cooldown_seconds),
        )
        self._cache_lock = threading.Lock()
        self._public_keys: dict[str, rsa.RSAPublicKey] = {}
        self._cache_expires_at = 0.0
        self._unknown_kid_refresh_allowed_at = 0.0

    @staticmethod
    def _decode_segment(segment: str, label: str) -> bytes:
        if not segment:
            raise FirebaseTokenVerificationError(f"Firebase token {label} is empty.")
        if re.fullmatch(r"[A-Za-z0-9_-]+", segment) is None:
            raise FirebaseTokenVerificationError(f"Firebase token {label} is not valid base64url.")
        try:
            padding_length = (-len(segment)) % 4
            return base64.b64decode(
                segment + "=" * padding_length,
                altchars=b"-_",
                validate=True,
            )
        except (ValueError, TypeError) as exc:
            raise FirebaseTokenVerificationError(f"Firebase token {label} is not valid base64url.") from exc

    @classmethod
    def _decode_json_segment(cls, segment: str, label: str) -> dict[str, object]:
        try:
            value = json.loads(cls._decode_segment(segment, label).decode("utf-8"))
        except (UnicodeDecodeError, ValueError, TypeError) as exc:
            if isinstance(exc, FirebaseTokenVerificationError):
                raise
            raise FirebaseTokenVerificationError(f"Firebase token {label} is not valid JSON.") from exc
        if not isinstance(value, dict):
            raise FirebaseTokenVerificationError(f"Firebase token {label} must be a JSON object.")
        return value

    @staticmethod
    def _numeric_date(claims: dict[str, object], name: str) -> float:
        value = claims.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise FirebaseTokenVerificationError(f"Firebase token {name} claim is invalid.")
        numeric = float(value)
        if not math.isfinite(numeric):
            raise FirebaseTokenVerificationError(f"Firebase token {name} claim is invalid.")
        return numeric

    def _load_public_keys(self) -> tuple[dict[str, rsa.RSAPublicKey], float]:
        try:
            certificates, max_age_seconds = self._certificate_fetcher()
        except FirebaseTokenVerificationError:
            raise
        except Exception as exc:
            raise FirebaseTokenVerificationError("Firebase signing certificates are unavailable.") from exc

        if not isinstance(certificates, dict) or not certificates:
            raise FirebaseTokenVerificationError("Firebase signing certificate response is invalid.")

        public_keys: dict[str, rsa.RSAPublicKey] = {}
        certificate_validity_seconds: list[float] = []
        wall_now = self._clock()
        try:
            for kid, certificate_pem in certificates.items():
                if not isinstance(kid, str) or not kid or not isinstance(certificate_pem, str):
                    raise FirebaseTokenVerificationError("Firebase signing certificate response is invalid.")
                certificate = x509.load_pem_x509_certificate(certificate_pem.encode("ascii"))
                public_key = certificate.public_key()
                if not isinstance(public_key, rsa.RSAPublicKey):
                    raise FirebaseTokenVerificationError("Firebase signing certificate is not RSA.")
                not_valid_after = certificate.not_valid_after
                if not_valid_after.tzinfo is None:
                    not_valid_after = not_valid_after.replace(tzinfo=timezone.utc)
                valid_for_seconds = not_valid_after.timestamp() - wall_now
                if valid_for_seconds <= 0:
                    continue
                public_keys[kid] = public_key
                certificate_validity_seconds.append(valid_for_seconds)
        except (ValueError, TypeError, UnicodeEncodeError) as exc:
            raise FirebaseTokenVerificationError("Firebase signing certificate is invalid.") from exc
        if not public_keys:
            raise FirebaseTokenVerificationError("Firebase signing certificate cache is empty.")
        try:
            cache_seconds = max(0, min(int(max_age_seconds), 24 * 60 * 60))
        except (TypeError, ValueError, OverflowError) as exc:
            raise FirebaseTokenVerificationError("Firebase certificate cache lifetime is invalid.") from exc
        cache_seconds = min(float(cache_seconds), min(certificate_validity_seconds))
        return public_keys, self._monotonic_clock() + max(0.0, cache_seconds)

    def _public_key(self, kid: str) -> rsa.RSAPublicKey:
        with self._cache_lock:
            now = self._monotonic_clock()
            refreshed = False
            if not self._public_keys or now >= self._cache_expires_at:
                public_keys, expires_at = self._load_public_keys()
                self._public_keys = public_keys
                self._cache_expires_at = expires_at
                refreshed = True
            public_key = self._public_keys.get(kid)
            if (
                public_key is None
                and not refreshed
                and now >= self._unknown_kid_refresh_allowed_at
            ):
                self._unknown_kid_refresh_allowed_at = (
                    now + self._unknown_kid_refresh_cooldown_seconds
                )
                public_keys, expires_at = self._load_public_keys()
                self._public_keys = public_keys
                self._cache_expires_at = expires_at
                public_key = public_keys.get(kid)
        if public_key is None:
            raise FirebaseTokenVerificationError("Firebase token signing key is unknown.")
        return public_key

    def verify(self, token: str) -> dict[str, object]:
        if not isinstance(token, str) or not token or len(token) > MAX_FIREBASE_TOKEN_LENGTH:
            raise FirebaseTokenVerificationError("Firebase token is missing or too large.")
        segments = token.split(".")
        if len(segments) != 3:
            raise FirebaseTokenVerificationError("Firebase token must contain three segments.")
        encoded_header, encoded_claims, encoded_signature = segments
        header = self._decode_json_segment(encoded_header, "header")
        claims = self._decode_json_segment(encoded_claims, "claims")

        if header.get("alg") != "RS256":
            raise FirebaseTokenVerificationError("Firebase token algorithm must be RS256.")
        kid = header.get("kid")
        if not isinstance(kid, str) or not kid or len(kid) > 256:
            raise FirebaseTokenVerificationError("Firebase token signing key ID is invalid.")

        signature = self._decode_segment(encoded_signature, "signature")
        signing_input = f"{encoded_header}.{encoded_claims}".encode("ascii")
        try:
            self._public_key(kid).verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
        except InvalidSignature as exc:
            raise FirebaseTokenVerificationError("Firebase token signature is invalid.") from exc

        if claims.get("aud") != self.project_id:
            raise FirebaseTokenVerificationError("Firebase token audience is invalid.")
        if claims.get("iss") != self.expected_issuer:
            raise FirebaseTokenVerificationError("Firebase token issuer is invalid.")
        subject = claims.get("sub")
        if not isinstance(subject, str) or not subject or len(subject) > 128:
            raise FirebaseTokenVerificationError("Firebase token subject is invalid.")
        expires_at = self._numeric_date(claims, "exp")
        issued_at = self._numeric_date(claims, "iat")
        authenticated_at = self._numeric_date(claims, "auth_time")
        now = self._clock()
        if expires_at <= now - self._clock_skew_seconds:
            raise FirebaseTokenVerificationError("Firebase token has expired.")
        if issued_at > now + self._clock_skew_seconds:
            raise FirebaseTokenVerificationError("Firebase token was issued in the future.")
        if authenticated_at > now + self._clock_skew_seconds:
            raise FirebaseTokenVerificationError("Firebase token authentication time is in the future.")
        if expires_at <= issued_at:
            raise FirebaseTokenVerificationError("Firebase token lifetime is invalid.")
        return claims

    def verify_authorization_header(self, authorization: str | None) -> dict[str, object]:
        if not authorization:
            raise FirebaseTokenVerificationError("Bearer Firebase token is required.")
        parts = authorization.strip().split()
        if len(parts) != 2 or parts[0].lower() != "bearer":
            raise FirebaseTokenVerificationError("Authorization header must use Bearer authentication.")
        return self.verify(parts[1])


@dataclass(frozen=True)
class GatewayConfig:
    public_host: str
    public_port: int
    engine_host: str
    engine_port: int
    dashboard_root: Path
    launcher: Path
    state_file: Path
    log_root: Path
    startup_timeout: float
    default_mode: str

    @property
    def public_origin(self) -> str:
        return f"http://{self.public_host}:{self.public_port}"

    @property
    def engine_origin(self) -> str:
        return f"http://{self.engine_host}:{self.engine_port}"


class EngineSwitchError(RuntimeError):
    def __init__(self, message: str, status: dict[str, object]):
        super().__init__(message)
        self.status = status


class EngineSupervisor:
    def __init__(self, config: GatewayConfig):
        self.config = config
        self._state_lock = threading.RLock()
        self._switch_lock = threading.Lock()
        self._process: subprocess.Popen[bytes] | None = None
        self._log_handle: BinaryIO | None = None
        self._mode = self._load_mode()
        self._requested_mode = self._mode
        self._phase = "idle"
        self._ready = False
        self._error: str | None = None
        self._shutdown_requested = False
        self._generation = 0

    def _load_mode(self) -> str:
        try:
            payload = json.loads(self.config.state_file.read_text(encoding="utf-8"))
            mode = str(payload.get("mode", "")).lower()
            if mode in VALID_MODES:
                return mode
        except (OSError, ValueError, TypeError):
            pass
        return self.config.default_mode

    def _persist_mode(self, mode: str) -> None:
        self.config.state_file.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config.state_file.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"mode": mode, "updatedAt": int(time.time())}, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.config.state_file)

    def start_initial_async(self) -> None:
        thread = threading.Thread(
            target=self._start_initial,
            name="morphly-initial-engine",
            daemon=True,
        )
        thread.start()

    def _start_initial(self) -> None:
        try:
            self.switch_mode(self._mode, force=True, allow_rollback=False)
        except EngineSwitchError as exc:
            print(f"[Morphly] Initial engine failed: {exc}", file=sys.stderr, flush=True)

    def status(self) -> dict[str, object]:
        with self._state_lock:
            process = self._process
            exit_code = process.poll() if process is not None else None
            if process is not None and exit_code is not None and self._ready:
                self._ready = False
                self._phase = "failed"
                self._error = f"Engine process exited with code {exit_code}."

            return {
                "mode": self._mode,
                "requestedMode": self._requested_mode,
                "ready": self._ready,
                "switching": self._phase in {"stopping", "starting", "rolling-back"},
                "phase": self._phase,
                "error": self._error,
                "pid": process.pid if process is not None and process.poll() is None else None,
                "publicPort": self.config.public_port,
                "enginePort": self.config.engine_port,
                "availableModes": list(VALID_MODES),
                "dashboardReady": (self.config.dashboard_root / "index.html").is_file(),
                "generation": self._generation,
            }

    def can_proxy(self) -> bool:
        with self._state_lock:
            return bool(
                self._ready
                and self._process is not None
                and self._process.poll() is None
            )

    def switch_mode(
        self,
        mode: str,
        *,
        force: bool = False,
        allow_rollback: bool = False,
    ) -> dict[str, object]:
        normalized_mode = mode.strip().lower()
        if normalized_mode not in VALID_MODES:
            raise EngineSwitchError(
                f"Unsupported engine mode: {mode}",
                self.status(),
            )

        # Status polling and React development lifecycles can submit the same
        # selection more than once. Do not queue an identical request behind a
        # cold start: if the first attempt times out, the queued call would
        # otherwise kill it and restart the expensive imports from zero.
        with self._state_lock:
            if (
                not force
                and self._requested_mode == normalized_mode
                and self._phase in {"starting", "rolling-back"}
                and self._process is not None
                and self._process.poll() is None
            ):
                return self.status()

        with self._switch_lock:
            with self._state_lock:
                if self._shutdown_requested:
                    raise EngineSwitchError("The Morphly supervisor is shutting down.", self.status())
                previous_mode = self._mode
                already_ready = (
                    self._ready
                    and self._process is not None
                    and self._process.poll() is None
                )
                if not force and previous_mode == normalized_mode and already_ready:
                    return self.status()
                self._requested_mode = normalized_mode
                self._error = None

            self._stop_process(phase="stopping")

            try:
                self._launch_and_wait(normalized_mode, phase="starting")
                self._persist_mode(normalized_mode)
                with self._state_lock:
                    self._mode = normalized_mode
                    self._requested_mode = normalized_mode
                    self._phase = "ready"
                    self._ready = True
                    self._error = None
                    self._generation += 1
                return self.status()
            except Exception as exc:
                failure_message = str(exc) or exc.__class__.__name__
                self._stop_process(phase="failed")

                rollback_error: str | None = None
                if allow_rollback and previous_mode in VALID_MODES and previous_mode != normalized_mode:
                    try:
                        with self._state_lock:
                            self._phase = "rolling-back"
                            self._requested_mode = previous_mode
                        self._launch_and_wait(previous_mode, phase="rolling-back")
                        self._persist_mode(previous_mode)
                        with self._state_lock:
                            self._mode = previous_mode
                            self._requested_mode = previous_mode
                            self._phase = "ready"
                            self._ready = True
                            self._error = (
                                f"Could not start {normalized_mode}; restored {previous_mode}. "
                                f"{failure_message}"
                            )
                            self._generation += 1
                    except Exception as rollback_exc:
                        rollback_error = str(rollback_exc) or rollback_exc.__class__.__name__
                        self._stop_process(phase="failed")

                with self._state_lock:
                    if not self._ready:
                        self._phase = "failed"
                        self._error = f"Could not start {normalized_mode}: {failure_message}"
                        if rollback_error:
                            self._error += f" Rollback also failed: {rollback_error}"
                raise EngineSwitchError(self._error or failure_message, self.status()) from exc

    def _launch_and_wait(self, mode: str, *, phase: str) -> None:
        if not self.config.launcher.is_file():
            raise FileNotFoundError(f"Engine launcher is missing: {self.config.launcher}")
        if self._engine_port_is_open():
            raise RuntimeError(
                f"Internal engine port {self.config.engine_host}:{self.config.engine_port} "
                "is already in use by a process outside this supervisor."
            )

        self.config.log_root.mkdir(parents=True, exist_ok=True)
        log_path = self.config.log_root / f"engine-{mode}.log"
        log_handle = log_path.open("ab", buffering=0)
        log_handle.write(
            f"\r\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Starting {mode}\r\n".encode("utf-8")
        )

        if mode == "rvc":
            command = [
                sys.executable,
                "-m",
                "uvicorn",
                "MMVCServerSIO:app_socketio",
                "--host",
                self.config.engine_host,
                "--port",
                str(self.config.engine_port),
                "--log-level",
                "error",
                "--no-access-log",
            ]
            engine_cwd = REPO_ROOT / "server"
        else:
            beatrice_executable = REPO_ROOT / "engines" / "beatrice-v2" / "main.exe"
            if not beatrice_executable.is_file():
                raise FileNotFoundError(f"Beatrice runtime is missing: {beatrice_executable}")
            command = [
                str(beatrice_executable),
                "start",
                "--host",
                self.config.engine_host,
                "-p",
                str(self.config.engine_port),
                "--https=False",
                "--launch_client=False",
            ]
            engine_cwd = beatrice_executable.parent
        environment = os.environ.copy()
        environment.update(
            {
                "MORPHLY_ENGINE_MODE": mode,
                "MORPHLY_ENGINE_HOST": self.config.engine_host,
                "MORPHLY_ENGINE_PORT": str(self.config.engine_port),
                "MORPHLY_PUBLIC_HOST": self.config.public_host,
                "MORPHLY_PUBLIC_PORT": str(self.config.public_port),
                "PYTHONUNBUFFERED": "1",
            }
        )

        popen_options: dict[str, object] = {
            "cwd": str(engine_cwd),
            "env": environment,
            "stdin": subprocess.DEVNULL,
            "stdout": log_handle,
            "stderr": subprocess.STDOUT,
            "shell": False,
        }
        if os.name == "nt":
            popen_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            popen_options["start_new_session"] = True

        try:
            process = subprocess.Popen(command, **popen_options)  # type: ignore[arg-type]
        except Exception:
            log_handle.close()
            raise

        with self._state_lock:
            self._process = process
            self._log_handle = log_handle
            self._mode = mode
            self._requested_mode = mode
            self._phase = phase
            self._ready = False
            self._error = None

        deadline = time.monotonic() + self.config.startup_timeout
        last_health_error = "The engine has not answered its health endpoint."
        while time.monotonic() < deadline:
            if self._shutdown_requested:
                raise RuntimeError("Engine startup cancelled because the supervisor is shutting down.")
            exit_code = process.poll()
            if exit_code is not None:
                raise RuntimeError(
                    f"{mode} exited with code {exit_code}. See {log_path.name} for details."
                )

            ready, detail = self._health_check(mode)
            if ready:
                return
            if detail:
                last_health_error = detail
            time.sleep(0.5)

        raise TimeoutError(
            f"{mode} did not become ready within {self.config.startup_timeout:.0f} seconds. "
            f"{last_health_error} See {log_path.name} for details."
        )

    def _health_check(self, mode: str) -> tuple[bool, str | None]:
        for path in HEALTH_PATHS[mode]:
            connection = http.client.HTTPConnection(
                self.config.engine_host,
                self.config.engine_port,
                timeout=1.5,
            )
            try:
                connection.request(
                    "GET",
                    path,
                    headers={"Host": f"{self.config.engine_host}:{self.config.engine_port}"},
                )
                response = connection.getresponse()
                response.read(1024)
                if 200 <= response.status < 400:
                    return True, None
                detail = f"Health endpoint {path} returned HTTP {response.status}."
            except (OSError, http.client.HTTPException) as exc:
                detail = f"Health endpoint {path} is not ready: {exc}"
            finally:
                connection.close()
        return False, detail

    def _stop_process(self, *, phase: str) -> None:
        with self._state_lock:
            process = self._process
            log_handle = self._log_handle
            self._phase = phase
            self._ready = False
            self._process = None
            self._log_handle = None

        if process is not None and process.poll() is None:
            if os.name == "nt":
                try:
                    taskkill_result = subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        check=False,
                        timeout=6,
                    )
                    if taskkill_result.returncode != 0:
                        with contextlib.suppress(OSError):
                            process.terminate()
                except (OSError, subprocess.TimeoutExpired):
                    with contextlib.suppress(OSError):
                        process.terminate()
            else:
                with contextlib.suppress(OSError):
                    os.killpg(process.pid, signal.SIGTERM)

            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(OSError):
                    process.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=2)

        if log_handle is not None:
            with contextlib.suppress(OSError):
                log_handle.close()

        if process is not None:
            self._wait_for_engine_port_to_close(timeout=3)

    def _engine_port_is_open(self) -> bool:
        try:
            with socket.create_connection(
                (self.config.engine_host, self.config.engine_port),
                timeout=0.25,
            ):
                return True
        except OSError:
            return False

    def _wait_for_engine_port_to_close(self, *, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(
                    (self.config.engine_host, self.config.engine_port),
                    timeout=0.25,
                ):
                    time.sleep(0.2)
            except OSError:
                return

    def shutdown(self) -> None:
        with self._state_lock:
            if self._shutdown_requested:
                return
            self._shutdown_requested = True
            self._phase = "stopping"

        acquired = self._switch_lock.acquire(timeout=5)
        try:
            self._stop_process(phase="stopped")
        finally:
            if acquired:
                self._switch_lock.release()


class MorphlyGatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MorphlyGateway/1.0"
    config: GatewayConfig
    supervisor: EngineSupervisor
    token_verifier: FirebaseIdTokenVerifier
    updater: MorphlyUpdater | None

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch()

    def do_HEAD(self) -> None:  # noqa: N802
        self._dispatch()

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch()

    def do_PATCH(self) -> None:  # noqa: N802
        self._dispatch()

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch()

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._dispatch()

    def log_message(self, message_format: str, *args: object) -> None:
        print(
            f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] "
            f"{self.client_address[0]} {message_format % args}",
            flush=True,
        )

    def handle_expect_100(self) -> bool:
        parsed = urlsplit(self.path)
        path = parsed.path or "/"
        if self._request_requires_engine_authentication(path):
            if not self._require_engine_authentication():
                return False
        return super().handle_expect_100()

    def _dispatch(self) -> None:
        parsed = urlsplit(self.path)
        path = parsed.path or "/"

        if self.command == "OPTIONS":
            self._send_preflight()
            return

        if self._request_requires_engine_authentication(path):
            if not self._require_engine_authentication():
                return

        if path == "/api/morphly/engine-status":
            if self.command in {"GET", "HEAD"}:
                self._send_json(200, {"ok": True, **self.supervisor.status()})
            else:
                self._send_json(405, {"ok": False, "error": "Method not allowed."})
            return

        if path == "/api/morphly/engine-mode":
            if self.command == "POST":
                self._handle_engine_switch()
            else:
                self._send_json(405, {"ok": False, "error": "Method not allowed."})
            return

        if path in UPDATER_ROUTES:
            self._handle_updater_request(path)
            return

        if self.headers.get("Upgrade"):
            self._send_json(
                501,
                {
                    "ok": False,
                    "error": "WebSocket proxying is not available through the Morphly HTTP gateway.",
                },
            )
            return

        if self._is_engine_route(path) or self.command not in {"GET", "HEAD"}:
            self._proxy_to_engine()
            return

        self._serve_dashboard(path)

    def _handle_updater_request(self, path: str) -> None:
        if not self._client_is_loopback():
            self._send_json(403, self._updater_error_payload("Software updates are loopback-only."))
            return
        if self.updater is None:
            self._send_json(503, self._unsupported_updater_status())
            return

        if path == f"{UPDATER_ROUTE_PREFIX}status":
            if self.command in {"GET", "HEAD"}:
                self._send_json(200, self.updater.status())
            else:
                self._send_json(405, self._updater_error_payload("Method not allowed."))
            return
        if self.command != "POST":
            self._send_json(405, self._updater_error_payload("Method not allowed."))
            return
        if not self._consume_updater_request_body():
            return

        try:
            if path == f"{UPDATER_ROUTE_PREFIX}check":
                self._send_json(200, self.updater.check())
                return
            if path == f"{UPDATER_ROUTE_PREFIX}download":
                self._send_json(202, self.updater.start_download())
                return
            if path == f"{UPDATER_ROUTE_PREFIX}install":
                status = self.updater.install(parent_pid=os.getpid(), restart_after_install=True)
                self.close_connection = True
                self._send_json(202, status, response_headers={"Connection": "close"})
                threading.Thread(
                    target=self._shutdown_for_update_install,
                    name="morphly-update-shutdown",
                    daemon=True,
                ).start()
                return
        except UpdaterStateError as exc:
            self._send_json(409, self._updater_error_payload(str(exc)))
            return
        except UpdaterError as exc:
            self._send_json(503, self._updater_error_payload(str(exc)))
            return

        self._send_json(404, self._updater_error_payload("Updater route not found."))

    def _consume_updater_request_body(self) -> bool:
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            self._send_json(
                400,
                self._updater_error_payload("Chunked updater requests are not supported."),
                response_headers={"Connection": "close"},
            )
            return False
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = -1
        if content_length < 0 or content_length > JSON_LIMIT:
            self.close_connection = True
            self._send_json(
                400,
                self._updater_error_payload("Updater requests must have a small request body."),
                response_headers={"Connection": "close"},
            )
            return False
        if content_length:
            content = self.rfile.read(content_length)
            if len(content) != content_length:
                self.close_connection = True
                self._send_json(
                    400,
                    self._updater_error_payload("The updater request body ended early."),
                    response_headers={"Connection": "close"},
                )
                return False
        return True

    def _shutdown_for_update_install(self) -> None:
        # Give the HTTP response time to leave the socket before stopping the
        # engine and server. The detached helper waits for this process to exit.
        time.sleep(0.25)
        self.supervisor.shutdown()
        self.server.shutdown()

    def _updater_error_payload(self, message: str) -> dict[str, object]:
        payload = self.updater.status() if self.updater is not None else self._unsupported_updater_status()
        payload["ok"] = False
        payload["error"] = message
        return payload

    @staticmethod
    def _unsupported_updater_status() -> dict[str, object]:
        return {
            "ok": False,
            "supported": False,
            "phase": "error",
            "currentVersion": None,
            "latestVersion": None,
            "releaseName": None,
            "releaseNotes": None,
            "releaseUrl": None,
            "downloadedBytes": 0,
            "totalBytes": 0,
            "progressPercent": 0,
            "lastCheckedAt": None,
            "error": "The Morphly desktop updater is not configured.",
            "updateAvailable": False,
            "canInstall": False,
        }

    def _handle_engine_switch(self) -> None:
        if not self._client_is_loopback():
            self._send_json(403, {"ok": False, "error": "Engine switching is loopback-only."})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_json(400, {"ok": False, "error": "Invalid Content-Length."})
            return
        if content_length <= 0 or content_length > JSON_LIMIT:
            self._send_json(400, {"ok": False, "error": "A small JSON request body is required."})
            return

        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
            mode = str(payload["mode"])
        except (UnicodeDecodeError, ValueError, TypeError, KeyError):
            self._send_json(400, {"ok": False, "error": "Expected JSON with mode rvc or beatrice."})
            return

        try:
            # Do not make the user wait through a second cold start when the
            # requested engine fails. A retry is explicit and predictable.
            status = self.supervisor.switch_mode(mode)
        except EngineSwitchError as exc:
            self._send_json(503, {"ok": False, "error": str(exc), **exc.status})
            return
        self._send_json(200, {"ok": True, **status})

    def _request_requires_engine_authentication(self, path: str) -> bool:
        return (
            path in {"/api/morphly/engine-status", "/api/morphly/engine-mode"}
            or self._is_engine_route(path)
            or self.command not in {"GET", "HEAD", "OPTIONS"}
        )

    def _require_engine_authentication(self) -> bool:
        try:
            authorization_headers = self.headers.get_all("Authorization", [])
            if len(authorization_headers) != 1:
                raise FirebaseTokenVerificationError("Exactly one Authorization header is required.")
            self.token_verifier.verify_authorization_header(authorization_headers[0])
        except Exception:
            response_headers = {"WWW-Authenticate": "Bearer"}
            if self.command not in {"GET", "HEAD", "OPTIONS"}:
                response_headers["Connection"] = "close"
                self.close_connection = True
            self._send_json(
                401,
                {
                    "ok": False,
                    "error": "A valid signed-in Morphly account is required for this operation.",
                },
                response_headers=response_headers,
            )
            return False
        return True

    def _client_is_loopback(self) -> bool:
        try:
            address = ipaddress.ip_address(self.client_address[0])
            if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
                address = address.ipv4_mapped
            return address.is_loopback
        except ValueError:
            return False

    @staticmethod
    def _is_engine_route(path: str) -> bool:
        return any(path == prefix.rstrip("/") or path.startswith(prefix) for prefix in ENGINE_ROUTE_PREFIXES)

    def _serve_dashboard(self, url_path: str) -> None:
        dashboard_root = self.config.dashboard_root.resolve()
        index_path = dashboard_root / "index.html"
        if not index_path.is_file():
            self._send_json(
                503,
                {
                    "ok": False,
                    "error": "Morphly dashboard build is missing.",
                    "expected": "Morphly-Voice-Dashboard/dist-static/index.html",
                },
            )
            return

        try:
            decoded_path = unquote(url_path)
            pure_path = PurePosixPath(decoded_path.lstrip("/"))
            if ".." in pure_path.parts or "\\" in decoded_path or "\x00" in decoded_path:
                raise ValueError("Unsafe path")
            candidate = dashboard_root.joinpath(*pure_path.parts).resolve()
            if os.path.commonpath((str(dashboard_root), str(candidate))) != str(dashboard_root):
                raise ValueError("Path escaped dashboard root")
        except (OSError, ValueError):
            self._send_json(400, {"ok": False, "error": "Invalid dashboard path."})
            return

        if candidate.is_dir():
            candidate = candidate / "index.html"

        if not candidate.is_file():
            suffix = PurePosixPath(decoded_path).suffix
            if suffix or decoded_path.startswith(("/assets/", "/_next/")):
                self._send_json(404, {"ok": False, "error": "Dashboard asset not found."})
                return
            candidate = index_path

        try:
            stat_result = candidate.stat()
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(stat_result.st_size))
            self.send_header("Last-Modified", formatdate(stat_result.st_mtime, usegmt=True))
            if candidate.name == "index.html":
                self.send_header("Cache-Control", "no-store, max-age=0")
            elif re.search(r"[-.][0-9A-Za-z_]{8,}\.", candidate.name):
                self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            else:
                self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if self.command != "HEAD":
                with candidate.open("rb") as source:
                    while chunk := source.read(COPY_BUFFER_SIZE):
                        self.wfile.write(chunk)
        except (OSError, BrokenPipeError, ConnectionResetError) as exc:
            if not self.wfile.closed:
                self.close_connection = True
            print(f"[Morphly] Static response failed: {exc}", file=sys.stderr, flush=True)

    def _proxy_to_engine(self) -> None:
        if not self.supervisor.can_proxy():
            self._send_json(
                503,
                {
                    "ok": False,
                    "error": "The selected voice engine is not ready.",
                    "engine": self.supervisor.status(),
                },
            )
            return

        connection = http.client.HTTPConnection(
            self.config.engine_host,
            self.config.engine_port,
            timeout=300,
        )
        response_started = False
        try:
            request_connection_tokens = self._connection_tokens(self.headers.get("Connection"))
            incoming_chunked = "chunked" in self.headers.get("Transfer-Encoding", "").lower()

            connection.putrequest(
                self.command,
                self.path,
                skip_host=True,
                skip_accept_encoding=True,
            )
            for key, value in self.headers.items():
                lowered = key.lower()
                if lowered in HOP_BY_HOP_HEADERS or lowered in request_connection_tokens:
                    continue
                if lowered in ENGINE_BOUNDARY_HEADERS or lowered.startswith(ENGINE_BOUNDARY_HEADER_PREFIXES):
                    continue
                connection.putheader(key, value)

            connection.putheader("Host", f"{self.config.engine_host}:{self.config.engine_port}")
            connection.putheader("Connection", "close")
            if self.headers.get("Origin"):
                connection.putheader("Origin", self.config.engine_origin)
            if self.headers.get("Referer"):
                connection.putheader("Referer", self.config.engine_origin + "/")
            if incoming_chunked:
                connection.putheader("Transfer-Encoding", "chunked")
            connection.endheaders()

            if incoming_chunked:
                self._forward_chunked_request(connection)
            else:
                self._forward_content_length_request(connection)

            upstream = connection.getresponse()
            response_connection_tokens = self._connection_tokens(upstream.getheader("Connection"))
            self.send_response(upstream.status, upstream.reason)
            location_header: str | None = None
            has_content_length = False
            for key, value in upstream.getheaders():
                lowered = key.lower()
                if lowered in HOP_BY_HOP_HEADERS or lowered in response_connection_tokens:
                    continue
                if lowered == "access-control-allow-origin":
                    continue
                if lowered == "set-cookie":
                    continue
                if lowered == "location":
                    location_header = value.replace(self.config.engine_origin, self.config.public_origin)
                    continue
                if lowered == "content-length":
                    has_content_length = True
                self.send_header(key, value)

            if location_header:
                self.send_header("Location", location_header)
            request_origin = self.headers.get("Origin")
            if request_origin:
                self.send_header("Access-Control-Allow-Origin", request_origin)
                self.send_header("Vary", "Origin")
            if not has_content_length and self.command != "HEAD":
                self.send_header("Connection", "close")
                self.close_connection = True
            self.end_headers()
            response_started = True

            if self.command != "HEAD":
                while chunk := upstream.read(COPY_BUFFER_SIZE):
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException, ValueError) as exc:
            if response_started:
                self.close_connection = True
            else:
                self._send_json(502, {"ok": False, "error": f"Engine proxy failed: {exc}"})
        finally:
            connection.close()

    def _forward_content_length_request(self, connection: http.client.HTTPConnection) -> None:
        raw_length = self.headers.get("Content-Length")
        if not raw_length:
            return
        remaining = int(raw_length)
        if remaining < 0:
            raise ValueError("Invalid negative Content-Length")
        while remaining:
            chunk = self.rfile.read(min(COPY_BUFFER_SIZE, remaining))
            if not chunk:
                raise ConnectionError("Client request body ended early")
            connection.send(chunk)
            remaining -= len(chunk)

    def _forward_chunked_request(self, connection: http.client.HTTPConnection) -> None:
        while True:
            size_line = self.rfile.readline(65537)
            if not size_line or len(size_line) > 65536:
                raise ValueError("Invalid chunked request body")
            connection.send(size_line)
            try:
                size = int(size_line.split(b";", 1)[0].strip(), 16)
            except ValueError as exc:
                raise ValueError("Invalid chunk size") from exc

            if size == 0:
                while True:
                    trailer_line = self.rfile.readline(65537)
                    if not trailer_line or len(trailer_line) > 65536:
                        raise ValueError("Invalid chunk trailer")
                    connection.send(trailer_line)
                    if trailer_line in {b"\r\n", b"\n"}:
                        return

            remaining = size + 2
            while remaining:
                chunk = self.rfile.read(min(COPY_BUFFER_SIZE, remaining))
                if not chunk:
                    raise ConnectionError("Client chunked body ended early")
                connection.send(chunk)
                remaining -= len(chunk)

    @staticmethod
    def _connection_tokens(raw_header: str | None) -> set[str]:
        if not raw_header:
            return set()
        return {token.strip().lower() for token in raw_header.split(",") if token.strip()}

    def _send_preflight(self) -> None:
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def _send_json(
        self,
        status_code: int,
        payload: dict[str, object],
        *,
        response_headers: dict[str, str] | None = None,
    ) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (response_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            with contextlib.suppress(BrokenPipeError, ConnectionResetError):
                self.wfile.write(encoded)


class MorphlyGatewayServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def build_handler(
    config: GatewayConfig,
    supervisor: EngineSupervisor,
    token_verifier: FirebaseIdTokenVerifier,
    updater: MorphlyUpdater | None = None,
) -> type[MorphlyGatewayHandler]:
    class ConfiguredMorphlyGatewayHandler(MorphlyGatewayHandler):
        pass

    ConfiguredMorphlyGatewayHandler.config = config
    ConfiguredMorphlyGatewayHandler.supervisor = supervisor
    ConfiguredMorphlyGatewayHandler.token_verifier = token_verifier
    ConfiguredMorphlyGatewayHandler.updater = updater
    return ConfiguredMorphlyGatewayHandler


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Morphly local dashboard and voice-engine gateway")
    parser.add_argument("--public-host", default=os.environ.get("MORPHLY_PUBLIC_HOST", "127.0.0.1"))
    parser.add_argument("--public-port", type=int, default=int(os.environ.get("MORPHLY_PUBLIC_PORT", "18000")))
    parser.add_argument("--engine-host", default=os.environ.get("MORPHLY_ENGINE_HOST", "127.0.0.1"))
    parser.add_argument("--engine-port", type=int, default=int(os.environ.get("MORPHLY_ENGINE_PORT", "18001")))
    parser.add_argument("--dashboard-root", type=Path, default=DEFAULT_DASHBOARD_ROOT)
    parser.add_argument("--launcher", type=Path, default=DEFAULT_LAUNCHER)
    parser.add_argument("--state-file", type=Path, default=DEFAULT_STATE_FILE)
    parser.add_argument("--log-root", type=Path, default=DEFAULT_LOG_ROOT)
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=float(os.environ.get("MORPHLY_ENGINE_STARTUP_TIMEOUT", "50")),
    )
    parser.add_argument(
        "--default-mode",
        choices=VALID_MODES,
        default=os.environ.get("MORPHLY_DEFAULT_ENGINE", "rvc").lower(),
    )
    parser.add_argument(
        "--firebase-project-id",
        default=os.environ.get(
            "MORPHLY_FIREBASE_PROJECT_ID",
            os.environ.get("FIREBASE_PROJECT_ID", DEFAULT_FIREBASE_PROJECT_ID),
        ),
        help="Firebase project whose signed ID tokens authorize local engine mutations.",
    )
    return parser.parse_args()


def main() -> int:
    arguments = parse_arguments()
    if arguments.public_port == arguments.engine_port and arguments.public_host == arguments.engine_host:
        print("Public and internal engine addresses must be different.", file=sys.stderr)
        return 2

    config = GatewayConfig(
        public_host=arguments.public_host,
        public_port=arguments.public_port,
        engine_host=arguments.engine_host,
        engine_port=arguments.engine_port,
        dashboard_root=arguments.dashboard_root.resolve(),
        launcher=arguments.launcher.resolve(),
        state_file=arguments.state_file.resolve(),
        log_root=arguments.log_root.resolve(),
        startup_timeout=arguments.startup_timeout,
        default_mode=arguments.default_mode,
    )
    supervisor = EngineSupervisor(config)
    updater = MorphlyUpdater(REPO_ROOT)
    try:
        token_verifier = FirebaseIdTokenVerifier(arguments.firebase_project_id)
    except ValueError as exc:
        print(f"Invalid Firebase project configuration: {exc}", file=sys.stderr)
        return 2
    handler = build_handler(config, supervisor, token_verifier, updater)

    try:
        server = MorphlyGatewayServer((config.public_host, config.public_port), handler)
    except OSError as exc:
        print(
            f"Could not bind Morphly dashboard to {config.public_origin}: {exc}",
            file=sys.stderr,
        )
        return 1

    stopping = threading.Event()

    def request_shutdown(_signal_number: int, _frame: object) -> None:
        if stopping.is_set():
            return
        stopping.set()
        threading.Thread(target=server.shutdown, name="morphly-http-shutdown", daemon=True).start()

    if threading.current_thread() is threading.main_thread():
        signal.signal(signal.SIGINT, request_shutdown)
        with contextlib.suppress(AttributeError):
            signal.signal(signal.SIGTERM, request_shutdown)

    atexit.register(supervisor.shutdown)
    print(f"[Morphly] Dashboard: {config.public_origin}", flush=True)
    print(f"[Morphly] Internal engine: {config.engine_origin}", flush=True)
    print(f"[Morphly] Dashboard files: {config.dashboard_root}", flush=True)
    print(f"[Morphly] Firebase gateway authorization: {token_verifier.project_id}", flush=True)
    supervisor.start_initial_async()

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        supervisor.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

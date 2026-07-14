from __future__ import annotations

import base64
import http.client
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import NameOID

from morphly_supervisor import (
    FirebaseIdTokenVerifier,
    FirebaseTokenVerificationError,
    GatewayConfig,
    MorphlyGatewayServer,
    _certificate_cache_seconds,
    build_handler,
)


PROJECT_ID = "vdc-c3a79"
NOW = 1_800_000_000.0
KEY_ID = "test-key"


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _certificate(
    private_key: rsa.RSAPrivateKey,
    *,
    not_valid_after: datetime | None = None,
) -> str:
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Morphly test signer")])
    reference_time = datetime.fromtimestamp(NOW, timezone.utc)
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(reference_time - timedelta(days=1))
        .not_valid_after(not_valid_after or reference_time + timedelta(days=7))
        .sign(private_key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.PEM).decode("ascii")


def _claims(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "aud": PROJECT_ID,
        "iss": f"https://securetoken.google.com/{PROJECT_ID}",
        "sub": "firebase-user-123",
        "auth_time": NOW - 20,
        "iat": NOW - 10,
        "exp": NOW + 3600,
    }
    value.update(overrides)
    return value


def _token(
    private_key: rsa.RSAPrivateKey,
    *,
    claims: dict[str, object] | None = None,
    kid: str = KEY_ID,
    alg: str = "RS256",
) -> str:
    header = _base64url(json.dumps({"alg": alg, "kid": kid}, separators=(",", ":")).encode())
    payload = _base64url(json.dumps(claims or _claims(), separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode("ascii")
    signature = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_base64url(signature)}"


@pytest.fixture
def signing_material() -> tuple[rsa.RSAPrivateKey, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, _certificate(private_key)


def test_verifier_accepts_valid_token_and_respects_certificate_max_age(signing_material):
    private_key, certificate = signing_material
    current_time = [NOW]
    monotonic_time = [100.0]
    fetch_count = [0]

    def fetch_certificates() -> tuple[dict[str, str], int]:
        fetch_count[0] += 1
        return {KEY_ID: certificate}, 60

    verifier = FirebaseIdTokenVerifier(
        PROJECT_ID,
        certificate_fetcher=fetch_certificates,
        clock=lambda: current_time[0],
        monotonic_clock=lambda: monotonic_time[0],
        clock_skew_seconds=0,
    )
    token = _token(private_key)

    assert verifier.verify(token)["sub"] == "firebase-user-123"
    assert verifier.verify_authorization_header(f"Bearer {token}")["aud"] == PROJECT_ID
    assert fetch_count[0] == 1

    current_time[0] += 61
    monotonic_time[0] += 61
    assert verifier.verify(token)["iss"] == f"https://securetoken.google.com/{PROJECT_ID}"
    assert fetch_count[0] == 2


def test_verifier_rejects_invalid_signature_header_and_claims(signing_material):
    private_key, certificate = signing_material
    verifier = FirebaseIdTokenVerifier(
        PROJECT_ID,
        certificate_fetcher=lambda: ({KEY_ID: certificate}, 300),
        clock=lambda: NOW,
        clock_skew_seconds=0,
    )
    other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    missing_auth_time = _claims()
    del missing_auth_time["auth_time"]

    invalid_tokens = [
        _token(private_key, alg="HS256"),
        _token(private_key, kid="unknown-key"),
        _token(other_key),
        _token(private_key, claims=_claims(aud="another-project")),
        _token(private_key, claims=_claims(iss="https://securetoken.google.com/another-project")),
        _token(private_key, claims=_claims(sub="")),
        _token(private_key, claims=_claims(exp=NOW - 1)),
        _token(private_key, claims=_claims(iat=NOW + 1)),
        _token(private_key, claims=_claims(auth_time=NOW + 1)),
        _token(private_key, claims=_claims(auth_time=True)),
        _token(private_key, claims=missing_auth_time),
        _token(private_key, claims=_claims(iat=NOW + 10, exp=NOW + 5)),
    ]
    for token in invalid_tokens:
        with pytest.raises(FirebaseTokenVerificationError):
            verifier.verify(token)

    for authorization in (None, "", "Basic abc", "Bearer", "Bearer one two"):
        with pytest.raises(FirebaseTokenVerificationError):
            verifier.verify_authorization_header(authorization)


def test_cache_control_max_age_parser():
    assert _certificate_cache_seconds("public, max-age=1234, must-revalidate") == 1234
    assert _certificate_cache_seconds('public, max-age="120"', "20") == 100
    assert _certificate_cache_seconds("max-age=120, MAX-AGE=60") == 60
    assert _certificate_cache_seconds("MAX-AGE=0") == 0
    assert _certificate_cache_seconds(None) == 3600
    assert _certificate_cache_seconds("no-cache") == 0


def test_certificate_cache_uses_monotonic_time_and_certificate_expiry():
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    certificate = _certificate(
        private_key,
        not_valid_after=datetime.fromtimestamp(NOW + 20, timezone.utc),
    )
    wall_time = [NOW]
    monotonic_time = [500.0]
    fetch_count = [0]

    def fetch_certificates() -> tuple[dict[str, str], int]:
        fetch_count[0] += 1
        return {KEY_ID: certificate}, 300

    verifier = FirebaseIdTokenVerifier(
        PROJECT_ID,
        certificate_fetcher=fetch_certificates,
        clock=lambda: wall_time[0],
        monotonic_clock=lambda: monotonic_time[0],
        clock_skew_seconds=0,
    )

    assert verifier.verify(_token(private_key))["sub"] == "firebase-user-123"
    assert fetch_count[0] == 1

    wall_time[0] += 10_000
    monotonic_time[0] += 19
    assert verifier._public_key(KEY_ID) is not None
    assert fetch_count[0] == 1

    wall_time[0] = NOW
    monotonic_time[0] += 2
    assert verifier._public_key(KEY_ID) is not None
    assert fetch_count[0] == 2


def test_unknown_kid_refresh_is_single_flight_and_rate_limited():
    old_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    new_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    certificates = {
        "old-key": _certificate(old_key),
        "new-key": _certificate(new_key),
    }
    monotonic_time = [100.0]
    fetch_count = [0]
    fetch_lock = threading.Lock()

    def fetch_certificates() -> tuple[dict[str, str], int]:
        with fetch_lock:
            fetch_count[0] += 1
            call_number = fetch_count[0]
        if call_number == 1:
            return {"old-key": certificates["old-key"]}, 300
        return dict(certificates), 300

    verifier = FirebaseIdTokenVerifier(
        PROJECT_ID,
        certificate_fetcher=fetch_certificates,
        clock=lambda: NOW,
        monotonic_clock=lambda: monotonic_time[0],
        clock_skew_seconds=0,
        unknown_kid_refresh_cooldown_seconds=60,
    )
    assert verifier.verify(_token(old_key, kid="old-key"))["sub"] == "firebase-user-123"
    assert fetch_count[0] == 1

    new_token = _token(new_key, kid="new-key")
    barrier = threading.Barrier(8)

    def verify_rotated_key() -> str:
        barrier.wait(timeout=5)
        return str(verifier.verify(new_token)["sub"])

    with ThreadPoolExecutor(max_workers=8) as executor:
        assert list(executor.map(lambda _index: verify_rotated_key(), range(8))) == [
            "firebase-user-123"
        ] * 8
    assert fetch_count[0] == 2

    attacker_token = _token(new_key, kid="attacker-controlled-kid")
    for _ in range(5):
        with pytest.raises(FirebaseTokenVerificationError):
            verifier.verify(attacker_token)
    assert fetch_count[0] == 2

    monotonic_time[0] += 61
    with pytest.raises(FirebaseTokenVerificationError):
        verifier.verify(attacker_token)
    assert fetch_count[0] == 3


class _FakeSupervisor:
    def __init__(self) -> None:
        self.switches: list[str] = []

    def can_proxy(self) -> bool:
        return True

    def status(self) -> dict[str, object]:
        return {"mode": "rvc", "ready": True, "phase": "ready"}

    def switch_mode(self, mode: str) -> dict[str, object]:
        self.switches.append(mode)
        return {"mode": mode, "ready": True, "phase": "ready"}


class _CapturingEngineHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    captured: list[dict[str, object]] = []

    def do_GET(self) -> None:  # noqa: N802
        self._respond()

    def do_HEAD(self) -> None:  # noqa: N802
        self._respond()

    def do_POST(self) -> None:  # noqa: N802
        self._respond()

    def _respond(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length else b""
        type(self).captured.append(
            {
                "method": self.command,
                "path": self.path,
                "headers": {key.lower(): value for key, value in self.headers.items()},
                "body": body,
            },
        )
        payload = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Set-Cookie", "engine-cookie=must-not-escape; Path=/")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        pass


def _request(
    port: int,
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


def test_gateway_protects_engine_routes_and_strips_identity_headers(tmp_path: Path, signing_material):
    private_key, certificate = signing_material
    verifier = FirebaseIdTokenVerifier(
        PROJECT_ID,
        certificate_fetcher=lambda: ({KEY_ID: certificate}, 300),
        clock=lambda: NOW,
        clock_skew_seconds=0,
    )
    valid_token = _token(private_key)
    invalid_token = _token(rsa.generate_private_key(public_exponent=65537, key_size=2048))
    dashboard = tmp_path / "dashboard"
    dashboard.mkdir()
    (dashboard / "index.html").write_text("<h1>Morphly</h1>", encoding="utf-8")

    _CapturingEngineHandler.captured = []
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), _CapturingEngineHandler)
    upstream_thread = threading.Thread(target=upstream.serve_forever, daemon=True)
    upstream_thread.start()

    config = GatewayConfig(
        public_host="127.0.0.1",
        public_port=0,
        engine_host="127.0.0.1",
        engine_port=upstream.server_port,
        dashboard_root=dashboard,
        launcher=tmp_path / "unused-launcher.bat",
        state_file=tmp_path / "state.json",
        log_root=tmp_path / "logs",
        startup_timeout=1,
        default_mode="rvc",
    )
    supervisor = _FakeSupervisor()
    gateway = MorphlyGatewayServer(("127.0.0.1", 0), build_handler(config, supervisor, verifier))
    gateway_thread = threading.Thread(target=gateway.serve_forever, daemon=True)
    gateway_thread.start()

    try:
        status, _, body = _request(gateway.server_port, "GET", "/")
        assert status == 200
        assert b"Morphly" in body

        status, headers, _ = _request(gateway.server_port, "GET", "/api/morphly/engine-status")
        assert status == 401
        assert headers["WWW-Authenticate"] == "Bearer"

        status, _, _ = _request(
            gateway.server_port,
            "GET",
            "/api/morphly/engine-status",
            headers={"Authorization": f"Bearer {valid_token}"},
        )
        assert status == 200

        status, _, _ = _request(gateway.server_port, "GET", "/info")
        assert status == 401
        assert _CapturingEngineHandler.captured == []

        status, _, _ = _request(gateway.server_port, "GET", "/onnx")
        assert status == 401
        assert _CapturingEngineHandler.captured == []

        status, headers, _ = _request(gateway.server_port, "OPTIONS", "/update_settings")
        assert status == 204
        assert "Authorization" in headers["Access-Control-Allow-Headers"]

        captured_before = len(_CapturingEngineHandler.captured)
        status, headers, _ = _request(gateway.server_port, "POST", "/update_settings", body=b"{}")
        assert status == 401
        assert headers["Connection"] == "close"
        assert headers["WWW-Authenticate"] == "Bearer"
        assert len(_CapturingEngineHandler.captured) == captured_before

        status, _, _ = _request(
            gateway.server_port,
            "POST",
            "/update_settings",
            body=b"{}",
            headers={"Authorization": f"Bearer {invalid_token}", "Content-Type": "application/json"},
        )
        assert status == 401
        assert len(_CapturingEngineHandler.captured) == captured_before

        status, response_headers, _ = _request(
            gateway.server_port,
            "POST",
            "/update_settings",
            body=b"{}",
            headers={
                "Authorization": f"Bearer {valid_token}",
                "Content-Type": "application/json",
                "Cookie": "firebase-session=secret",
                "Forwarded": "for=198.51.100.8;proto=https",
                "X-Forwarded-For": "198.51.100.8",
                "X-Firebase-Uid": "spoofed-user",
                "X-Morphly-Uid": "spoofed-user",
                "X-HTTP-Method-Override": "DELETE",
            },
        )
        assert status == 200
        assert "Set-Cookie" not in response_headers
        upstream_headers = _CapturingEngineHandler.captured[-1]["headers"]
        for header_name in (
            "authorization",
            "cookie",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-firebase-uid",
            "x-morphly-uid",
            "x-http-method-override",
        ):
            assert header_name not in upstream_headers
        assert _CapturingEngineHandler.captured[-1]["body"] == b"{}"

        status, _, _ = _request(
            gateway.server_port,
            "GET",
            "/info",
            headers={"Authorization": f"Bearer {valid_token}"},
        )
        assert status == 200
        assert "authorization" not in _CapturingEngineHandler.captured[-1]["headers"]

        switch_payload = json.dumps({"mode": "beatrice"}).encode()
        status, _, _ = _request(
            gateway.server_port,
            "POST",
            "/api/morphly/engine-mode",
            body=switch_payload,
            headers={"Content-Type": "application/json"},
        )
        assert status == 401
        assert supervisor.switches == []

        status, _, _ = _request(
            gateway.server_port,
            "POST",
            "/api/morphly/engine-mode",
            body=switch_payload,
            headers={"Authorization": f"Bearer {valid_token}", "Content-Type": "application/json"},
        )
        assert status == 200
        assert supervisor.switches == ["beatrice"]
    finally:
        gateway.shutdown()
        gateway.server_close()
        gateway_thread.join(timeout=5)
        upstream.shutdown()
        upstream.server_close()
        upstream_thread.join(timeout=5)

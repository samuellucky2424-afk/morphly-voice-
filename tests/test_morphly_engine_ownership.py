from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from morphly_supervisor import EngineSupervisor, GatewayConfig, WindowsProcessInfo


pytestmark = pytest.mark.skipif(os.name != "nt", reason="Windows engine ownership recovery")


def _supervisor(tmp_path: Path) -> EngineSupervisor:
    return EngineSupervisor(
        GatewayConfig(
            public_host="127.0.0.1",
            public_port=18000,
            engine_host="127.0.0.1",
            engine_port=18001,
            dashboard_root=tmp_path / "dashboard",
            launcher=tmp_path / "launcher.bat",
            state_file=tmp_path / "runtime-state" / "engine-mode.json",
            log_root=tmp_path / "logs",
            startup_timeout=1,
            default_mode="rvc",
        )
    )


def test_engine_owner_record_is_atomic_and_only_owner_clears_it(tmp_path: Path) -> None:
    supervisor = _supervisor(tmp_path)
    process = SimpleNamespace(pid=4321)

    supervisor._persist_engine_owner(  # type: ignore[arg-type]
        process=process,
        mode="rvc",
        executable=Path(sys.executable),
    )

    owner_path = supervisor.config.engine_owner_file
    owner = json.loads(owner_path.read_text(encoding="utf-8"))
    assert owner["supervisorPid"] == os.getpid()
    assert owner["enginePid"] == 4321
    assert owner["enginePort"] == 18001
    assert owner["mode"] == "rvc"
    assert not owner_path.with_suffix(".tmp").exists()

    supervisor._clear_engine_owner(engine_pid=9999)
    assert owner_path.exists()
    supervisor._clear_engine_owner(engine_pid=4321)
    assert not owner_path.exists()


@pytest.mark.parametrize(
    "mode,payload,expected",
    [
        ("rvc", {"modelSlots": None}, False),
        ("rvc", {"modelSlots": []}, True),
        ("rvc", {"modelSlots": [{"slotIndex": 0, "modelFile": "voice.pth"}]}, True),
        ("beatrice", {"voice_changer_type": "Beatrice_v2", "model_info": {"voice": {}}}, False),
        (
            "beatrice",
            {"voice_changer_type": "Beatrice_v2", "model_info": {"voice": {"0": {"name": "jvs001"}}}},
            True,
        ),
    ],
)
def test_engine_health_waits_for_voice_catalog(mode: str, payload: dict[str, object], expected: bool) -> None:
    ready, _ = EngineSupervisor._health_payload_ready(mode, json.dumps(payload).encode("utf-8"))
    assert ready is expected


def test_recorded_engine_is_recovered_when_its_supervisor_is_stale(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    supervisor = _supervisor(tmp_path)
    engine_pid = 4321
    owner = {
        "supervisorPid": 9876,
        "enginePid": engine_pid,
        "engineHost": "127.0.0.1",
        "enginePort": 18001,
        "mode": "rvc",
        "executable": str(Path(sys.executable).resolve()),
    }
    supervisor.config.engine_owner_file.parent.mkdir(parents=True)
    supervisor.config.engine_owner_file.write_text(json.dumps(owner), encoding="utf-8")
    killed: list[int] = []

    def process_info(pid: int) -> WindowsProcessInfo | None:
        if pid == engine_pid:
            return WindowsProcessInfo(pid, 9876, Path(sys.executable).resolve())
        return None

    monkeypatch.setattr(supervisor, "_windows_listener_pids", lambda: {engine_pid})
    monkeypatch.setattr(supervisor, "_windows_process_info", process_info)
    monkeypatch.setattr(
        supervisor,
        "_terminate_windows_process_tree",
        lambda pid: not killed.append(pid),
    )
    monkeypatch.setattr(supervisor, "_wait_for_engine_port_to_close", lambda **_: True)

    assert supervisor._recover_orphaned_engine() is True
    assert killed == [engine_pid]
    assert not supervisor.config.engine_owner_file.exists()


def test_unrecorded_rvc_process_is_never_terminated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    supervisor = _supervisor(tmp_path)
    engine_pid = 4321
    killed: list[int] = []
    monkeypatch.setattr(supervisor, "_windows_listener_pids", lambda: {engine_pid})
    monkeypatch.setattr(
        supervisor,
        "_windows_process_info",
        lambda pid: WindowsProcessInfo(pid, 9876, Path(sys.executable).resolve()),
    )
    monkeypatch.setattr(
        supervisor,
        "_terminate_windows_process_tree",
        lambda pid: not killed.append(pid),
    )

    assert supervisor._recover_orphaned_engine() is False
    assert killed == []


@pytest.mark.parametrize("parent_is_alive,expected", [(False, True), (True, False)])
def test_v025_unrecorded_beatrice_is_only_recovered_when_parent_is_gone(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    parent_is_alive: bool,
    expected: bool,
) -> None:
    supervisor = _supervisor(tmp_path)
    engine_pid = 4321
    parent_pid = 9876
    beatrice = supervisor._expected_engine_executable("beatrice")
    assert beatrice is not None
    killed: list[int] = []

    def process_info(pid: int) -> WindowsProcessInfo | None:
        if pid == engine_pid:
            return WindowsProcessInfo(pid, parent_pid, beatrice)
        if pid == parent_pid and parent_is_alive:
            return WindowsProcessInfo(pid, 1, Path("C:/Windows/System32/example.exe"))
        return None

    monkeypatch.setattr(supervisor, "_windows_listener_pids", lambda: {engine_pid})
    monkeypatch.setattr(supervisor, "_windows_process_info", process_info)
    monkeypatch.setattr(
        supervisor,
        "_terminate_windows_process_tree",
        lambda pid: not killed.append(pid),
    )
    monkeypatch.setattr(supervisor, "_wait_for_engine_port_to_close", lambda **_: True)

    assert supervisor._recover_orphaned_engine() is expected
    assert killed == ([engine_pid] if expected else [])

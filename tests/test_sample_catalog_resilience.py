from __future__ import annotations

import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parents[1] / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from downloader import SampleDownloader  # noqa: E402


def test_missing_optional_sample_catalog_does_not_break_engine_info(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(
        SampleDownloader,
        "getSampleJsonAndModelIds",
        lambda _mode: (["https://example.invalid/missing-samples.json"], []),
    )

    assert SampleDownloader.getSampleInfos("production") == []


def test_malformed_optional_sample_catalog_does_not_break_engine_info(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "bad-samples.json").write_text("not-json", encoding="utf-8")
    monkeypatch.setattr(
        SampleDownloader,
        "getSampleJsonAndModelIds",
        lambda _mode: (["https://example.invalid/bad-samples.json"], []),
    )

    assert SampleDownloader.getSampleInfos("production") == []

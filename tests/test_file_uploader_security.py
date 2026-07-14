from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]
SERVER_ROOT = REPO_ROOT / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from restapi.mods.FileUploader import (  # noqa: E402
    MAX_UPLOAD_CHUNK_BYTES,
    concat_file_chunks,
    sanitize_filename,
    upload_file,
)


class MemoryUpload:
    def __init__(self, content: bytes):
        self.file = io.BytesIO(content)


@pytest.mark.parametrize("filename", ["../model.pth", "folder/model.pth", "folder\\model.pth", "", ".", ".."])
def test_sanitize_filename_rejects_paths_and_empty_names(filename: str) -> None:
    with pytest.raises(ValueError):
        sanitize_filename(filename)


def test_chunk_upload_and_concat_stay_inside_upload_directory(tmp_path: Path) -> None:
    upload_file(str(tmp_path), MemoryUpload(b"first"), "voice.pth_0")
    upload_file(str(tmp_path), MemoryUpload(b"second"), "voice.pth_1")

    result = concat_file_chunks(str(tmp_path), "voice.pth", 2, str(tmp_path))

    assert result["status"] == "OK"
    assert (tmp_path / "voice.pth").read_bytes() == b"firstsecond"
    assert not (tmp_path / "voice.pth_0").exists()
    assert not (tmp_path / "voice.pth_1").exists()


def test_chunk_upload_rejects_oversized_request_and_removes_partial_file(tmp_path: Path) -> None:
    filename = "oversized.pth_0"
    content = b"x" * (MAX_UPLOAD_CHUNK_BYTES + 1)

    with pytest.raises(ValueError, match="8 MB"):
        upload_file(str(tmp_path), MemoryUpload(content), filename)

    assert not (tmp_path / filename).exists()


def test_concat_rejects_missing_chunks(tmp_path: Path) -> None:
    (tmp_path / "voice.onnx_0").write_bytes(b"model")

    with pytest.raises(ValueError, match="missing"):
        concat_file_chunks(str(tmp_path), "voice.onnx", 2, str(tmp_path))

    assert not (tmp_path / "voice.onnx").exists()

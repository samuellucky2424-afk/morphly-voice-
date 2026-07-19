from __future__ import annotations

import json
from pathlib import Path


def test_default_beatrice_slot_is_bom_free_and_contains_voices() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    slot_path = repository_root / "packaging" / "default-beatrice-slot-1-params.json"
    slot_bytes = slot_path.read_bytes()

    assert not slot_bytes.startswith(b"\xef\xbb\xbf")
    slot = json.loads(slot_bytes.decode("utf-8"))
    assert slot["voice_changer_type"] == "Beatrice_v2"
    assert len(slot["model_info"]["voice"]) == 100

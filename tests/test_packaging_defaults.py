from __future__ import annotations

import hashlib
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


def test_default_rvc_slot_contains_the_pinned_model() -> None:
    repository_root = Path(__file__).resolve().parents[1]
    slot_root = repository_root / "packaging" / "default-rvc-slot"
    slot = json.loads((slot_root / "params.json").read_text(encoding="utf-8"))
    model_path = slot_root / slot["modelFile"]

    assert slot["slotIndex"] == 0
    assert slot["voiceChangerType"] == "RVC"
    assert slot["name"]
    assert slot["speakers"]
    assert model_path.stat().st_size == 55_226_939
    assert hashlib.sha256(model_path.read_bytes()).hexdigest() == (
        "56d344ddb09e674a2fc5059a54a956aecce9de8e6700cceb89946052b3dd6d99"
    )

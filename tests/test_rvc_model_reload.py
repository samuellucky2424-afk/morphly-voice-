from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import Mock

SERVER_ROOT = Path(__file__).resolve().parents[1] / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from voice_changer.VoiceChangerManager import (  # noqa: E402
    VoiceChangerManager,
    VoiceChangerManagerSettings,
)


def test_selecting_loaded_rvc_slot_does_not_rebuild_pipeline() -> None:
    manager = object.__new__(VoiceChangerManager)
    manager.settings = VoiceChangerManagerSettings()
    manager.settings.modelSlotIndex = 7
    manager.voiceChanger = Mock()
    manager.generateVoiceChanger = Mock()
    manager.store_setting = Mock()
    manager.get_info = Mock(return_value={"status": "OK"})

    result = manager.update_settings("modelSlotIndex", "7")

    assert result == {"status": "OK"}
    manager.generateVoiceChanger.assert_not_called()
    manager.voiceChanger.update_settings.assert_not_called()

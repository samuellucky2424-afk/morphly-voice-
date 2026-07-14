from pathlib import Path
import sys

import numpy as np


SERVER_ROOT = Path(__file__).resolve().parents[1] / "server"
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

from voice_changer.Local.ServerDevice import ServerDevice, _AudioFrameFifo  # noqa: E402


class _UnusedCallbacks:
    pass


def test_fifo_preserves_surplus_and_zero_fills_underflow():
    fifo = _AudioFrameFifo()
    fifo.put(np.arange(6, dtype=np.int16))

    np.testing.assert_array_equal(fifo.read(4), np.array([0, 1, 2, 3], dtype=np.float32))
    assert fifo.available_frames == 2
    np.testing.assert_array_equal(fifo.read(4), np.array([4, 5, 0, 0], dtype=np.float32))
    assert fifo.available_frames == 0


def test_fifo_downmixes_multichannel_pcm_by_frame():
    fifo = _AudioFrameFifo()
    fifo.put(np.array([[2, 4], [6, 10], [-4, 4]], dtype=np.int16))

    np.testing.assert_array_equal(fifo.read(3), np.array([3, 8, 0], dtype=np.float32))


def test_output_callback_fills_requested_stereo_frames_and_keeps_remainder():
    device = ServerDevice(_UnusedCallbacks())
    device.settings.serverOutputAudioGain = 0.5
    device.outQueue.put(np.array([-32768, 0, 16384, 8192, 4096, 2048], dtype=np.int16))

    first = np.full((4, 2), np.nan, dtype=np.float32)
    device.audioOutput_callback(first, 4, None, None)
    expected_first = np.array([-0.5, 0.0, 0.25, 0.125], dtype=np.float32)
    np.testing.assert_allclose(first, np.repeat(expected_first[:, None], 2, axis=1))
    assert device.outQueue.available_frames == 2

    second = np.full((4, 2), np.nan, dtype=np.float32)
    device.audioOutput_callback(second, 4, None, None)
    expected_second = np.array([0.0625, 0.03125, 0.0, 0.0], dtype=np.float32)
    np.testing.assert_allclose(second, np.repeat(expected_second[:, None], 2, axis=1))
    assert device.outQueue.available_frames == 0


def test_stop_setting_clears_output_and_monitor_state():
    device = ServerDevice(_UnusedCallbacks())
    device.get_info = lambda: {}  # Avoid hardware enumeration in this unit test.
    device.outQueue.put(np.ones(8, dtype=np.int16))
    device.monQueue.put(np.ones(5, dtype=np.int16))

    device.update_settings("serverAudioStated", 0)

    assert device.outQueue.available_frames == 0
    assert device.monQueue.available_frames == 0

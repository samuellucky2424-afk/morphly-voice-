import librosa
import numpy as np

from const import PitchExtractorType
from voice_changer.RVC.pitchExtractor.PitchExtractor import PitchExtractor


class PmPitchExtractor(PitchExtractor):
    def __init__(self):
        super().__init__()
        self.pitchExtractorType: PitchExtractorType = "pm"

    def extract(self, audio, pitchf, f0_up_key, sr, window, silence_front=0):
        audio = audio.detach().cpu().numpy().astype(np.float64)
        start_frame = int(silence_front * sr / window)
        real_silence_front = start_frame * window / sr
        silence_front_offset = max(
            min(int(np.round(real_silence_front * sr)), len(audio) - 3000),
            0,
        )
        audio = audio[silence_front_offset:]

        f0_min = 50
        f0_max = 1100
        f0_mel_min = 1127 * np.log(1 + f0_min / 700)
        f0_mel_max = 1127 * np.log(1 + f0_max / 700)
        hop_length = max(1, int(window))
        frame_length = int(2 ** np.ceil(np.log2(max(2048, hop_length * 4))))

        if len(audio) < frame_length:
            audio = np.pad(audio, (0, frame_length - len(audio)))

        f0 = librosa.yin(
            audio,
            fmin=f0_min,
            fmax=f0_max,
            sr=sr,
            frame_length=frame_length,
            hop_length=hop_length,
        )
        f0 = np.nan_to_num(f0, nan=0.0, posinf=0.0, neginf=0.0)
        f0 = self._smooth_f0(f0)
        f0 *= pow(2, f0_up_key / 12)

        if f0.shape[0] > 0:
            pitchf[-f0.shape[0] :] = f0[: pitchf.shape[0]]

        f0bak = pitchf.copy()
        f0_mel = 1127 * np.log(1 + f0bak / 700)
        f0_mel[f0_mel > 0] = (
            (f0_mel[f0_mel > 0] - f0_mel_min)
            * 254
            / (f0_mel_max - f0_mel_min)
            + 1
        )
        f0_mel[f0_mel <= 1] = 1
        f0_mel[f0_mel > 255] = 255
        pitch_coarse = np.rint(f0_mel).astype(int)

        return pitch_coarse, pitchf

    def _smooth_f0(self, f0):
        if f0.shape[0] < 3:
            return f0

        padded = np.pad(f0, (1, 1), mode="edge")
        median = np.array(
            [
                np.median(padded[index : index + 3])
                for index in range(f0.shape[0])
            ]
        )
        smoothed = median.copy()

        previous = 0.0
        for index, value in enumerate(smoothed):
            if value <= 0:
                smoothed[index] = previous
                continue

            if previous > 0:
                lower = previous * 0.82
                upper = previous * 1.22
                smoothed[index] = min(max(value, lower), upper)

            previous = smoothed[index]

        return smoothed

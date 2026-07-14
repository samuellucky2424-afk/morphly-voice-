import numpy as np
import onnxruntime
import torch
from torch import device

from const import EmbedderType
from voice_changer.RVC.deviceManager.DeviceManager import DeviceManager
from voice_changer.RVC.embedder.Embedder import Embedder


class OnnxContentvec(Embedder):

    def loadModel(self, file: str, dev: device, embedderType: EmbedderType = "hubert_base", gpu: int = -1) -> Embedder:
        super().setProps(embedderType, file, dev, False)

        providers, provider_options = DeviceManager.get_instance().getOnnxExecutionProvider(gpu)
        session_options = DeviceManager.get_instance().getOnnxSessionOptions()
        self.onnx_session = onnxruntime.InferenceSession(
            file,
            sess_options=session_options,
            providers=providers,
            provider_options=provider_options,
        )
        self.input_name = self.onnx_session.get_inputs()[0].name
        self.output_names = [output.name for output in self.onnx_session.get_outputs()]
        self.model = self.onnx_session
        return self

    def getEmbedderInfo(self):
        info = super().getEmbedderInfo()
        info["onnxExecutionProvider"] = self.onnx_session.get_providers()
        return info

    def extractFeatures(
        self, feats: torch.Tensor, embOutputLayer=9, useFinalProj=True
    ) -> torch.Tensor:
        audio = feats.detach().float().cpu().numpy()
        if audio.ndim == 1:
            audio = np.expand_dims(audio, axis=0)

        outputs = self.onnx_session.run(
            self.output_names,
            {self.input_name: audio.astype(np.float32)},
        )
        output_map = dict(zip(self.output_names, outputs))

        if embOutputLayer == 9 or useFinalProj:
            features = output_map.get("units9")
        elif embOutputLayer == 12:
            features = output_map.get("unit12")
        else:
            features = output_map.get("unit12")
            if features is None:
                features = output_map.get("units9")

        if features is None:
            features = next(iter(output_map.values()))

        return torch.from_numpy(features).to(self.dev)

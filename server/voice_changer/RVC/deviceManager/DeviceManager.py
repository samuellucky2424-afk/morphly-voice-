import torch
import onnxruntime
import os


class DeviceManager(object):
    _instance = None
    forceTensor: bool = False

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        self.gpu_num = torch.cuda.device_count()
        self.mps_enabled: bool = (
            getattr(torch.backends, "mps", None) is not None
            and torch.backends.mps.is_available()
        )

    def getDevice(self, id: int):
        if id < 0 or self.gpu_num == 0:
            if self.mps_enabled is False:
                dev = torch.device("cpu")
            else:
                dev = torch.device("mps")
        else:
            if id < self.gpu_num:
                dev = torch.device("cuda", index=id)
            else:
                print("[Voice Changer] device detection error, fallback to cpu")
                dev = torch.device("cpu")
        return dev

    def getOnnxExecutionProvider(self, gpu: int):
        availableProviders = onnxruntime.get_available_providers()
        devNum = torch.cuda.device_count()
        cpuThreads = self.getCpuThreadCount()
        if gpu >= 0 and "CUDAExecutionProvider" in availableProviders and devNum > 0:
            if gpu < devNum:  # ひとつ前のif文で弾いてもよいが、エラーの解像度を上げるため一段下げ。
                return ["CUDAExecutionProvider"], [{"device_id": gpu}]
            else:
                print("[Voice Changer] device detection error, fallback to cpu")
                return ["CPUExecutionProvider"], [
                    {
                        "intra_op_num_threads": cpuThreads,
                        "execution_mode": onnxruntime.ExecutionMode.ORT_PARALLEL,
                        "inter_op_num_threads": max(1, min(2, cpuThreads)),
                    }
                ]
        elif gpu >= 0 and "DmlExecutionProvider" in availableProviders:
            return ["DmlExecutionProvider"], [{"device_id": gpu}]
        else:
            return ["CPUExecutionProvider"], [
                {
                    "intra_op_num_threads": cpuThreads,
                    "execution_mode": onnxruntime.ExecutionMode.ORT_PARALLEL,
                    "inter_op_num_threads": max(1, min(2, cpuThreads)),
                }
            ]

    def setForceTensor(self, forceTensor: bool):
        self.forceTensor = forceTensor

    def getCpuThreadCount(self):
        env_threads = os.getenv("MORPHLY_CPU_THREADS")
        if env_threads:
            try:
                return max(1, int(env_threads))
            except Exception:
                pass

        cpu_count = os.cpu_count() or 2
        if cpu_count <= 2:
            return cpu_count

        return max(1, min(4, cpu_count - 1))

    def getOnnxSessionOptions(self):
        so = onnxruntime.SessionOptions()
        cpuThreads = self.getCpuThreadCount()

        so.log_severity_level = 3
        so.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        so.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
        so.enable_mem_pattern = "DmlExecutionProvider" not in onnxruntime.get_available_providers()
        so.intra_op_num_threads = cpuThreads
        so.inter_op_num_threads = 1

        try:
            so.add_session_config_entry("session.intra_op.allow_spinning", "0")
            so.add_session_config_entry("session.inter_op.allow_spinning", "0")
        except Exception:
            pass

        return so

    def halfPrecisionAvailable(self, id: int):
        if self.gpu_num == 0:
            return False
        if id < 0:
            return False
        if self.forceTensor:
            return False

        try:
            gpuName = torch.cuda.get_device_name(id).upper()
            if (
                ("16" in gpuName and "V100" not in gpuName)
                or "P40" in gpuName.upper()
                or "1070" in gpuName
                or "1080" in gpuName
            ):
                return False
        except Exception as e:
            print(e)
            return False

        cap = torch.cuda.get_device_capability(id)
        if cap[0] < 7:  # コンピューティング機能が7以上の場合half precisionが使えるとされている（が例外がある？T500とか）
            return False

        return True

    def getDeviceMemory(self, id: int):
        try:
            return torch.cuda.get_device_properties(id).total_memory
        except Exception as e:
            # except:
            print(e)
            return 0

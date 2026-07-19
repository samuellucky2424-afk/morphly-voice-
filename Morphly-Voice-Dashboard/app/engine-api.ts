export type EngineMode = "rvc" | "beatrice";

export type GatewayStatus = {
  mode: EngineMode;
  ready: boolean;
  switching: boolean;
  pid?: number | null;
  message?: string | null;
  error?: string | null;
};

export type EngineDevice = {
  index: number;
  name: string;
  hostAPI: string;
  defaultSampleRate: number;
  availableSampleRates: number[];
  maxInputChannels: number;
  maxOutputChannels: number;
};

export type VoiceGender = "male" | "female" | "other";

export type EngineVoice = {
  id: string;
  slot: number;
  speaker: number;
  name: string;
  gender: VoiceGender;
  voiceChangerType: string;
  modelName: string;
  runtimeLabel: string;
};

export type EngineInfo = {
  mode: EngineMode;
  raw: Record<string, unknown>;
  slots: Record<string, unknown>[];
  voices: EngineVoice[];
  inputDevices: EngineDevice[];
  outputDevices: EngineDevice[];
  selectedSlot: number;
  selectedSpeaker: number;
  selectedInputDevice: number;
  selectedOutputDevice: number;
  inputGain: number;
  outputGain: number;
  pitch: number;
  indexRatio: number;
  sampleRate: number;
  chunkSize: number;
  f0Detector: string;
  running: boolean;
  passThrough: boolean;
};

export type RuntimeSettings = {
  inputDevice: number;
  outputDevice: number;
  sampleRate: number;
  inputGain: number;
  outputGain: number;
  pitch: number;
  indexRatio: number;
  chunkSize: number;
  f0Detector: string;
};

export class EngineApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "EngineApiError";
    this.status = status;
  }
}

const REQUEST_TIMEOUT = 12_000;
const RVC_SETTINGS_TIMEOUT = 60_000;
const RVC_MODEL_TIMEOUT = 120_000;
const RVC_UPLOAD_TIMEOUT = 120_000;
const RVC_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
const RVC_UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
let engineAuthorizationToken = "";

export function setEngineAuthorizationToken(token: string | null) {
  engineAuthorizationToken = token?.trim() || "";
}

function numeric(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  if (value === undefined || value === null) return fallback;
  return Number(value) === 1;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

async function requestJson<T>(path: string, options: RequestInit = {}, timeout = REQUEST_TIMEOUT): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(engineAuthorizationToken ? { Authorization: `Bearer ${engineAuthorizationToken}` } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload: unknown = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const detail =
        payload && typeof payload === "object"
          ? String((payload as Record<string, unknown>).error || (payload as Record<string, unknown>).detail || "")
          : String(payload || "");
      throw new EngineApiError(detail || `Engine request failed (${response.status}).`, response.status);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof EngineApiError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new EngineApiError("The voice engine did not respond in time.");
    }
    throw new EngineApiError(error instanceof Error ? error.message : "The voice engine is unavailable.");
  } finally {
    window.clearTimeout(timer);
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function normalizeDevice(device: Record<string, unknown>): EngineDevice {
  const rates = (device.available_samplerates || device.availableSamplerates || []) as unknown;
  const defaultSampleRate = numeric(device.default_samplerate ?? device.defaultSamplerate, 48_000);

  return {
    index: numeric(device.index ?? device.id, -1),
    name: String(device.name || "Audio device"),
    hostAPI: String(device.host_api || device.hostAPI || device.hostAPIName || ""),
    defaultSampleRate,
    availableSampleRates: Array.from(
      new Set([
        defaultSampleRate,
        ...(Array.isArray(rates) ? rates.map((rate) => numeric(rate, -1)) : []),
      ]),
    ).filter((rate) => rate > 0),
    maxInputChannels: numeric(device.max_input_channels ?? device.maxInputChannels, 0),
    maxOutputChannels: numeric(device.max_output_channels ?? device.maxOutputChannels, 0),
  };
}

function isUnsafeDevice(device: EngineDevice) {
  const name = device.name.toLowerCase();
  return name.includes("sound mapper") || name.includes("primary sound");
}

function normalizeDevices(devices: unknown, kind: "input" | "output") {
  if (!Array.isArray(devices)) return [];
  return devices
    .map((device) => normalizeDevice(device as Record<string, unknown>))
    .filter((device) => {
      if (device.index < 0 || isUnsafeDevice(device)) return false;
      const channelCount = kind === "input" ? device.maxInputChannels : device.maxOutputChannels;
      return channelCount === 0 || channelCount > 0;
    });
}

function normalizeSlot(slot: Record<string, unknown>) {
  const rawName = String(slot.name || "");
  const modelFile = String(slot.zip_file || slot.toml_file || slot.modelFile || rawName || "");
  const modelInfo = slot.model_info || slot.modelInfo;
  const isLoaded = Boolean(
    modelFile.trim()
    || rawName.trim()
    || (modelInfo && typeof modelInfo === "object" && Object.keys(modelInfo as Record<string, unknown>).length),
  );
  return {
    ...slot,
    slotIndex: numeric(slot.slot_index ?? slot.slotIndex, -1),
    voiceChangerType: String(slot.voice_changer_type || slot.voiceChangerType || "Voice model"),
    name: rawName || modelFile || "Voice model",
    modelFile,
    isLoaded,
  };
}

function runtimeLabel(slot: Record<string, unknown>, mode: EngineMode) {
  const type = String(slot.voiceChangerType || "").toLowerCase();
  const modelFile = String(slot.modelFile || "").toLowerCase();
  if (mode === "beatrice" || type.includes("beatrice")) return "Beatrice V2 low-latency";
  if (type.includes("rvc") && modelFile.endsWith(".onnx")) return "RVC ONNX CPU";
  if (type.includes("rvc")) return "RVC PyTorch · Slow on CPU";
  return String(slot.voiceChangerType || "Local model");
}

// Official JVS speaker gender tags (CC BY-SA 4.0):
// https://sites.google.com/site/shinnosuketakamichi/research-topics/jvs_corpus
const femaleJvsSpeakers = new Set([
  "jvs002", "jvs004", "jvs007", "jvs008", "jvs010", "jvs014", "jvs015", "jvs016", "jvs017",
  "jvs018", "jvs019", "jvs024", "jvs025", "jvs026", "jvs027", "jvs029", "jvs030", "jvs035",
  "jvs036", "jvs038", "jvs039", "jvs040", "jvs043", "jvs051", "jvs053", "jvs055", "jvs056",
  "jvs057", "jvs058", "jvs059", "jvs060", "jvs061", "jvs062", "jvs063", "jvs064", "jvs065",
  "jvs066", "jvs067", "jvs069", "jvs072", "jvs082", "jvs083", "jvs084", "jvs085", "jvs090",
  "jvs091", "jvs092", "jvs093", "jvs094", "jvs095", "jvs096",
]);

const femaleRvcVoices = ["hatsunemiku", "hatsune miku", "voice nell", "manon"];
const maleRvcVoices = ["elon musk", "barack obama", "future"];

function voiceGender(name: string, modelName: string, mode: EngineMode): VoiceGender {
  const searchableName = `${name} ${modelName}`.toLowerCase();

  if (mode === "beatrice") {
    const match = searchableName.match(/\bjvs(\d{3})\b/);
    if (match) {
      const speakerNumber = Number(match[1]);
      if (speakerNumber >= 1 && speakerNumber <= 100) {
        return femaleJvsSpeakers.has(`jvs${match[1]}`) ? "female" : "male";
      }
    }
  }

  if (femaleRvcVoices.some((voiceName) => searchableName.includes(voiceName))) return "female";
  if (maleRvcVoices.some((voiceName) => searchableName.includes(voiceName))) return "male";
  return "other";
}

function voicesFromSlots(slots: Record<string, unknown>[], mode: EngineMode): EngineVoice[] {
  return slots.flatMap((slot) => {
    const slotIndex = numeric(slot.slotIndex, -1);
    const modelName = String(slot.name || `Slot ${slotIndex}`);
    const voiceChangerType = String(slot.voiceChangerType || (mode === "beatrice" ? "Beatrice_v2" : "RVC"));
    const modelInfo = (slot.model_info || slot.modelInfo || {}) as Record<string, unknown>;
    const modelVoices = modelInfo.voice as Record<string, unknown> | undefined;
    const speakers = (slot.speakers || {}) as Record<string, unknown>;
    const entries = modelVoices && Object.keys(modelVoices).length ? Object.entries(modelVoices) : Object.entries(speakers);
    const fallbackSpeaker = numeric(slot.dst_id ?? slot.dstId, 0);
    const voiceEntries = entries.length ? entries : [[String(fallbackSpeaker), modelName] as [string, unknown]];

    if (slotIndex < 0 || slot.isLoaded !== true) return [];

    return voiceEntries.map(([speakerKey, voice]) => {
      const speaker = numeric(speakerKey, fallbackSpeaker);
      const voiceRecord = voice && typeof voice === "object" ? (voice as Record<string, unknown>) : null;
      const name = String(voiceRecord?.name || voice || modelName);
      return {
        id: `slot-${slotIndex}-speaker-${speaker}`,
        slot: slotIndex,
        speaker,
        name,
        gender: voiceGender(name, modelName, mode),
        voiceChangerType,
        modelName,
        runtimeLabel: runtimeLabel(slot, mode),
      };
    });
  });
}

function findSlot(slots: Record<string, unknown>[], slotIndex: number) {
  return slots.find((slot) => numeric(slot.slotIndex, -1) === slotIndex);
}

function rvcUploadFilename(file: File) {
  const basename = file.name.replace(/\\/g, "/").split("/").pop()?.trim() || "";
  const sanitized = basename.replace(/[^A-Za-z0-9._ -]/g, "_").slice(-180);
  if (!sanitized || sanitized === "." || sanitized === "..") {
    throw new EngineApiError("The selected model has an invalid filename.");
  }
  return sanitized;
}

function assertRvcUploadFile(file: File, extensions: string[], label: string) {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  if (!extensions.includes(extension)) {
    throw new EngineApiError(`${label} must be ${extensions.map((item) => `.${item}`).join(" or ")}. Extract ZIP downloads before selecting the model files.`);
  }
  if (file.size <= 0) throw new EngineApiError(`${label} is empty.`);
  if (file.size > RVC_UPLOAD_MAX_FILE_BYTES) throw new EngineApiError(`${label} is larger than the 2 GB upload limit.`);
}

function emptyRvcSlot(info: EngineInfo) {
  const slot = info.slots.find((candidate) => {
    const slotIndex = numeric(candidate.slotIndex, -1);
    return Number.isSafeInteger(slotIndex) && slotIndex >= 0 && candidate.isLoaded !== true;
  });
  const slotIndex = slot ? numeric(slot.slotIndex, -1) : -1;
  if (slotIndex < 0) throw new EngineApiError("Every RVC model slot is already in use. Remove an unused model before uploading another voice.");
  return slotIndex;
}

async function uploadRvcFile(file: File, filename: string, completedBytes: number, totalBytes: number, onProgress: (percent: number) => void) {
  const chunkCount = Math.ceil(file.size / RVC_UPLOAD_CHUNK_BYTES);
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * RVC_UPLOAD_CHUNK_BYTES;
    const chunk = file.slice(start, Math.min(file.size, start + RVC_UPLOAD_CHUNK_BYTES));
    const body = new FormData();
    body.append("file", chunk, `${filename}.part`);
    body.append("filename", `${filename}_${index}`);
    await requestJson("/upload_file", { method: "POST", body }, RVC_UPLOAD_TIMEOUT);
    const uploadedBytes = Math.min(file.size, start + chunk.size);
    onProgress(Math.min(90, Math.round(((completedBytes + uploadedBytes) / totalBytes) * 90)));
  }

  const concatBody = new FormData();
  concatBody.append("filename", filename);
  concatBody.append("filenameChunkNum", String(chunkCount));
  await requestJson("/concat_uploaded_file", { method: "POST", body: concatBody }, RVC_UPLOAD_TIMEOUT);
}

function commonEngineInfo(
  mode: EngineMode,
  raw: Record<string, unknown>,
  rawSlots: unknown,
  rawInputs: unknown,
  rawOutputs: unknown,
  runtime: {
    selectedSlot: number;
    selectedSpeaker: number;
    selectedInputDevice: number;
    selectedOutputDevice: number;
    inputGain: number;
    outputGain: number;
    pitch: number;
    indexRatio: number;
    sampleRate: number;
    chunkSize: number;
    f0Detector: string;
    running: boolean;
    passThrough: boolean;
  },
): EngineInfo {
  const slots = (Array.isArray(rawSlots) ? rawSlots : []).map((slot) => normalizeSlot(slot as Record<string, unknown>));
  return {
    mode,
    raw,
    slots,
    voices: voicesFromSlots(slots, mode),
    inputDevices: normalizeDevices(rawInputs, "input"),
    outputDevices: normalizeDevices(rawOutputs, "output"),
    ...runtime,
  };
}

export async function getGatewayStatus() {
  return requestJson<GatewayStatus>("/api/morphly/engine-status");
}

export async function switchGatewayMode(mode: EngineMode) {
  return requestJson<GatewayStatus>("/api/morphly/engine-mode", jsonRequest("POST", { mode }), 65_000);
}

async function getRvcInfo(): Promise<EngineInfo> {
  const info = await requestJson<Record<string, unknown>>("/info");
  return commonEngineInfo(
    "rvc",
    info,
    info.modelSlots,
    info.serverAudioInputDevices,
    info.serverAudioOutputDevices,
    {
      selectedSlot: numeric(info.modelSlotIndex, -1),
      selectedSpeaker: numeric(info.dstId, 0),
      selectedInputDevice: numeric(info.serverInputDeviceId, -1),
      selectedOutputDevice: numeric(info.serverOutputDeviceId, -1),
      inputGain: numeric(info.serverInputAudioGain, 1),
      outputGain: numeric(info.serverOutputAudioGain, 1),
      pitch: numeric(info.tran, 0),
      indexRatio: numeric(info.indexRatio, 0),
      sampleRate: numeric(info.serverAudioSampleRate, 48_000),
      chunkSize: numeric(info.serverReadChunkSize, 128),
      f0Detector: String(info.f0Detector || "pm"),
      running: numeric(info.enableServerAudio, 0) === 1 && numeric(info.serverAudioStated, 0) === 1,
      passThrough: booleanValue(info.passThrough),
    },
  );
}

async function optionalRequest(path: string) {
  try {
    return await requestJson<unknown>(path);
  } catch {
    return [];
  }
}

async function getBeatriceInfo(): Promise<EngineInfo> {
  const [properties, configuration, slots, localInterface] = await Promise.all([
    requestJson<Record<string, unknown>>("/api/server-properties/properties"),
    requestJson<Record<string, unknown>>("/api/configuration-manager/configuration"),
    requestJson<Record<string, unknown>[]>("/api/slot-manager/slots"),
    requestJson<Record<string, unknown>>("/api/local-voice-changer-interface/information"),
  ]);
  const reload = booleanValue(localInterface.local_voice_changer_interface_active) ? "" : "?reload=true";
  const [inputs, outputs] = await Promise.all([
    optionalRequest(`/api/audio-device-manager/input_devices${reload}`),
    optionalRequest(`/api/audio-device-manager/output_devices${reload}`),
  ]);
  const selectedSlot = numeric(configuration.current_slot_index, -1);
  const normalizedSlots = slots.map(normalizeSlot);
  const activeSlot = findSlot(normalizedSlots, selectedSlot) || {};
  const speaker = numeric(activeSlot.dst_id ?? activeSlot.dstId, 0);
  const pitchShifts = activeSlot.pitch_shifts as unknown;

  return commonEngineInfo(
    "beatrice",
    { properties, configuration, localInterface },
    slots,
    inputs,
    outputs,
    {
      selectedSlot,
      selectedSpeaker: speaker,
      selectedInputDevice: numeric(configuration.audio_input_device_index, -1),
      selectedOutputDevice: numeric(configuration.audio_output_device_index, -1),
      inputGain: numeric(configuration.audio_input_device_gain, 1),
      outputGain: numeric(configuration.audio_output_device_gain, 1),
      pitch: Array.isArray(pitchShifts) ? numeric(pitchShifts[speaker], numeric(activeSlot.pitch_shift, 0)) : numeric(activeSlot.pitch_shift, 0),
      indexRatio: 0,
      sampleRate: numeric(configuration.input_sample_rate ?? configuration.audio_input_device_sample_rate, 48_000),
      chunkSize: Math.round(numeric(activeSlot.chunk_sec, 0.12) * 1000),
      f0Detector: "Beatrice neural pitch",
      running: booleanValue(localInterface.local_voice_changer_interface_active),
      passThrough: booleanValue(configuration.pass_through),
    },
  );
}

export function getEngineInfo(mode: EngineMode) {
  return mode === "rvc" ? getRvcInfo() : getBeatriceInfo();
}

export type RvcModelUpload = {
  model: File;
  index?: File | null;
};

export type RvcModelUploadProgress = {
  phase: "uploading" | "installing";
  percent: number;
};

export async function uploadRvcModel(
  info: EngineInfo,
  files: RvcModelUpload,
  onProgress: (progress: RvcModelUploadProgress) => void,
) {
  if (info.mode !== "rvc") throw new EngineApiError("Switch to the RVC engine before uploading an RVC voice.");
  assertRvcUploadFile(files.model, ["pth", "onnx"], "RVC model");
  if (files.index) assertRvcUploadFile(files.index, ["index", "bin"], "RVC index");

  const slot = emptyRvcSlot(info);
  const modelName = rvcUploadFilename(files.model);
  const indexName = files.index ? rvcUploadFilename(files.index) : null;
  const totalBytes = files.model.size + (files.index?.size || 0);
  let completedBytes = 0;

  onProgress({ phase: "uploading", percent: 0 });
  await uploadRvcFile(files.model, modelName, completedBytes, totalBytes, (percent) => onProgress({ phase: "uploading", percent }));
  completedBytes += files.model.size;
  if (files.index && indexName) {
    await uploadRvcFile(files.index, indexName, completedBytes, totalBytes, (percent) => onProgress({ phase: "uploading", percent }));
  }

  onProgress({ phase: "installing", percent: 95 });
  const params = {
    voiceChangerType: "RVC",
    slot,
    isSampleMode: false,
    sampleId: null,
    files: [
      { name: modelName, kind: "rvcModel", dir: "" },
      ...(indexName ? [{ name: indexName, kind: "rvcIndex", dir: "" }] : []),
    ],
    params: {},
  };
  const body = new FormData();
  body.append("slot", String(slot));
  body.append("isHalf", "false");
  body.append("params", JSON.stringify(params));
  await requestJson("/load_model", { method: "POST", body }, RVC_MODEL_TIMEOUT);

  const refreshed = await getRvcInfo();
  const installed = refreshed.slots.find((candidate) => numeric(candidate.slotIndex, -1) === slot && candidate.isLoaded === true);
  if (!installed) throw new EngineApiError("The RVC engine received the files but could not install this model. Confirm it is a compatible RVC .pth or .onnx file.");
  onProgress({ phase: "installing", percent: 100 });
  return { info: refreshed, slot };
}

async function updateRvcSetting(key: string, value: unknown, timeout = REQUEST_TIMEOUT) {
  const body = new URLSearchParams({ key, val: String(value) });
  return requestJson<Record<string, unknown>>("/update_settings", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  }, timeout);
}

async function updateRvcSettings(settings: Record<string, unknown>, timeout = REQUEST_TIMEOUT) {
  let result: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(settings)) {
    if (value !== undefined && value !== null) result = await updateRvcSetting(key, value, timeout);
  }
  return result;
}

async function getBeatriceConfiguration() {
  return requestJson<Record<string, unknown>>("/api/configuration-manager/configuration");
}

async function updateBeatriceConfiguration(patch: Record<string, unknown>) {
  const current = await getBeatriceConfiguration();
  const next = { ...current, ...patch };
  await requestJson("/api/configuration-manager/configuration", jsonRequest("PUT", next));
  return next;
}

function arrayWithValue(values: unknown, index: number, value: number, minimumLength = 1) {
  const next = Array.isArray(values) ? values.map((item) => numeric(item, 0)) : [];
  while (next.length < Math.max(index + 1, minimumLength)) next.push(0);
  next[index] = value;
  return next;
}

async function putBeatriceVoiceProperties(voice: EngineVoice, pitch: number, chunkSize: number) {
  const current = await requestJson<Record<string, unknown>>(`/api/slot-manager/slots/${voice.slot}`);
  const voiceInfo = ((current.model_info || current.modelInfo || {}) as Record<string, unknown>).voice as Record<string, unknown> | undefined;
  const speakerCount = Math.max(
    Object.keys(voiceInfo || {}).length,
    Object.keys((current.speakers || {}) as Record<string, unknown>).length,
    Array.isArray(current.pitch_shifts) ? current.pitch_shifts.length : 0,
    voice.speaker + 1,
    1,
  );
  const normalizedChunk = clamp(chunkSize, 60, 240);
  const patch: Record<string, unknown> = {
    dst_id: voice.speaker,
    pitch_shift: pitch,
    chunk_sec: Number((normalizedChunk / 1000).toFixed(3)),
    vq_neighbor_count: clamp(Math.round(3 + ((normalizedChunk - 60) / 180) * 5), 3, 8),
    auto_pitch_shift: false,
  };

  if (booleanValue(current.use_merged_speaker_embedding)) {
    const mergedSpeaker = Math.max(0, Math.round(numeric(current.merged_speaker_id, 0)));
    patch.merged_speaker_pitch_shifts = arrayWithValue(current.merged_speaker_pitch_shifts, mergedSpeaker, pitch, mergedSpeaker + 1);
  } else {
    patch.pitch_shifts = arrayWithValue(current.pitch_shifts, voice.speaker, pitch, speakerCount);
  }

  const next = { ...current, ...patch };
  await requestJson(`/api/slot-manager/slots/${voice.slot}`, jsonRequest("PUT", next));
}

async function updateBeatriceVoice(
  voice: EngineVoice,
  pitch: number,
  chunkSize: number,
  configurationPatch: Record<string, unknown> = {},
) {
  // A fresh Beatrice process starts on an empty slot with no pipeline. The
  // slot must be activated before its properties can be updated.
  await updateBeatriceConfiguration({
    current_slot_index: voice.slot,
    voice_changer_input_mode: "server",
    ...configurationPatch,
  });
  await putBeatriceVoiceProperties(voice, pitch, chunkSize);
}

export async function selectVoice(mode: EngineMode, voice: EngineVoice, pitch: number, chunkSize: number) {
  if (mode === "rvc") {
    // Loading a model can take well over the normal request timeout on CPU.
    // Keep the UI waiting for the real result instead of reporting a false
    // failure while the engine continues loading in the background.
    await updateRvcSetting("modelSlotIndex", voice.slot, RVC_MODEL_TIMEOUT);
    await updateRvcSettings({
      dstId: voice.speaker,
      tran: pitch,
      passThrough: false,
    }, RVC_SETTINGS_TIMEOUT);
  } else {
    await updateBeatriceVoice(voice, pitch, chunkSize, { pass_through: false });
  }
}

function selectedDevice(devices: EngineDevice[], index: number, label: string) {
  const device = devices.find((candidate) => candidate.index === index);
  if (!device) throw new EngineApiError(`Choose a valid ${label} before starting.`);
  return device;
}

function compatibleSampleRate(input: EngineDevice, output: EngineDevice, preferred: number) {
  const choices = [preferred, 48_000, 44_100, input.defaultSampleRate, output.defaultSampleRate];
  return choices.find((rate) => {
    const inputSupports = input.availableSampleRates.length === 0 || input.availableSampleRates.includes(rate);
    const outputSupports = output.availableSampleRates.length === 0 || output.availableSampleRates.includes(rate);
    return rate > 0 && inputSupports && outputSupports;
  }) || input.defaultSampleRate || 48_000;
}

export async function startConversion(mode: EngineMode, info: EngineInfo, voice: EngineVoice, settings: RuntimeSettings) {
  const input = selectedDevice(info.inputDevices, settings.inputDevice, "microphone");
  const output = selectedDevice(info.outputDevices, settings.outputDevice, "output device");
  const sampleRate = compatibleSampleRate(input, output, settings.sampleRate);

  if (mode === "rvc") {
    if (info.selectedSlot !== voice.slot) {
      await updateRvcSetting("modelSlotIndex", voice.slot, RVC_MODEL_TIMEOUT);
    }
    await updateRvcSettings({
      dstId: voice.speaker,
      tran: settings.pitch,
      passThrough: false,
    }, RVC_SETTINGS_TIMEOUT);
    await updateRvcSetting("serverAudioStated", 0, RVC_SETTINGS_TIMEOUT);
    await updateRvcSettings({
      serverInputDeviceId: input.index,
      serverOutputDeviceId: output.index,
      serverMonitorDeviceId: -1,
      serverAudioSampleRate: sampleRate,
      serverInputAudioSampleRate: sampleRate,
      serverOutputAudioSampleRate: sampleRate,
      serverInputAudioGain: settings.inputGain,
      serverOutputAudioGain: settings.outputGain,
      serverMonitorAudioGain: 0,
      serverReadChunkSize: clamp(Math.round(settings.chunkSize), 64, 512),
      f0Detector: settings.f0Detector,
      indexRatio: clamp(settings.indexRatio, 0, 1),
      enableServerAudio: 1,
      passThrough: false,
      serverAudioStated: 1,
    }, RVC_SETTINGS_TIMEOUT);
    return getRvcInfo();
  }

  try {
    await requestJson("/api/local-voice-changer-interface/operation/stop", jsonRequest("POST", null));
  } catch {
    // The local interface may already be stopped.
  }

  await new Promise((resolve) => window.setTimeout(resolve, 500));
  await updateBeatriceConfiguration({
    current_slot_index: voice.slot,
    voice_changer_input_mode: "server",
    audio_input_device_index: input.index,
    audio_output_device_index: output.index,
    audio_monitor_device_index: -1,
    audio_input_device_sample_rate: sampleRate,
    audio_output_device_sample_rate: sampleRate,
    audio_monitor_device_sample_rate: -1,
    input_sample_rate: sampleRate,
    output_sample_rate: sampleRate,
    monitor_sample_rate: -1,
    audio_input_device_gain: settings.inputGain,
    audio_output_device_gain: settings.outputGain,
    audio_monitor_device_gain: 0,
    server_device_trancate_buffer_ratio: clamp(settings.chunkSize / 120, 0.5, 4),
    gpu_device_id_int: -1,
    wasapi_exclude_emabled: false,
    pass_through: false,
  });
  await putBeatriceVoiceProperties(voice, settings.pitch, settings.chunkSize);
  await requestJson("/api/local-voice-changer-interface/operation/start", jsonRequest("POST", null), 25_000);
  return getBeatriceInfo();
}

export async function stopConversion(mode: EngineMode) {
  if (mode === "rvc") {
    await updateRvcSettings({ serverAudioStated: 0, enableServerAudio: 0, passThrough: true }, RVC_SETTINGS_TIMEOUT);
    return getRvcInfo();
  }

  try {
    await requestJson("/api/local-voice-changer-interface/operation/stop", jsonRequest("POST", null));
  } finally {
    await updateBeatriceConfiguration({ pass_through: true });
  }
  return getBeatriceInfo();
}

export function stopConversionOnPageHide(mode: EngineMode) {
  const headers: Record<string, string> = {
    ...(engineAuthorizationToken ? { Authorization: `Bearer ${engineAuthorizationToken}` } : {}),
  };
  if (mode === "rvc") {
    const body = new URLSearchParams({ key: "serverAudioStated", val: "0" });
    return fetch("/update_settings", {
      method: "POST",
      keepalive: true,
      cache: "no-store",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: body.toString(),
    });
  }
  return fetch("/api/local-voice-changer-interface/operation/stop", {
    method: "POST",
    keepalive: true,
    cache: "no-store",
    headers: { ...headers, "Content-Type": "application/json" },
    body: "null",
  });
}

export async function updateRuntimeSettings(
  mode: EngineMode,
  voice: EngineVoice | null,
  patch: Partial<RuntimeSettings>,
) {
  if (mode === "rvc") {
    const settings: Record<string, unknown> = {};
    if (patch.inputGain !== undefined) settings.serverInputAudioGain = patch.inputGain;
    if (patch.outputGain !== undefined) settings.serverOutputAudioGain = patch.outputGain;
    if (patch.pitch !== undefined) settings.tran = patch.pitch;
    if (patch.indexRatio !== undefined) settings.indexRatio = clamp(patch.indexRatio, 0, 1);
    if (patch.chunkSize !== undefined) settings.serverReadChunkSize = clamp(Math.round(patch.chunkSize), 64, 512);
    if (patch.f0Detector !== undefined) settings.f0Detector = patch.f0Detector;
    if (patch.inputDevice !== undefined) settings.serverInputDeviceId = patch.inputDevice;
    if (patch.outputDevice !== undefined) settings.serverOutputDeviceId = patch.outputDevice;
    if (patch.sampleRate !== undefined) {
      settings.serverAudioSampleRate = patch.sampleRate;
      settings.serverInputAudioSampleRate = patch.sampleRate;
      settings.serverOutputAudioSampleRate = patch.sampleRate;
    }
    await updateRvcSettings(settings, RVC_SETTINGS_TIMEOUT);
    return;
  }

  const configuration: Record<string, unknown> = voice
    ? {
        current_slot_index: voice.slot,
        voice_changer_input_mode: "server",
      }
    : {};
  if (patch.inputGain !== undefined) configuration.audio_input_device_gain = patch.inputGain;
  if (patch.outputGain !== undefined) configuration.audio_output_device_gain = patch.outputGain;
  if (patch.inputDevice !== undefined) configuration.audio_input_device_index = patch.inputDevice;
  if (patch.outputDevice !== undefined) configuration.audio_output_device_index = patch.outputDevice;
  if (patch.sampleRate !== undefined) {
    configuration.audio_input_device_sample_rate = patch.sampleRate;
    configuration.audio_output_device_sample_rate = patch.sampleRate;
    configuration.input_sample_rate = patch.sampleRate;
    configuration.output_sample_rate = patch.sampleRate;
  }
  if (patch.chunkSize !== undefined) configuration.server_device_trancate_buffer_ratio = clamp(patch.chunkSize / 120, 0.5, 4);
  if (Object.keys(configuration).length) await updateBeatriceConfiguration(configuration);
  if (voice && (patch.pitch !== undefined || patch.chunkSize !== undefined)) {
    await putBeatriceVoiceProperties(voice, patch.pitch ?? 0, patch.chunkSize ?? 120);
  }
}

export async function getRvcPerformance() {
  try {
    const values = await requestJson<unknown[]>("/performance", {}, 4_000);
    const finite = Array.isArray(values) ? values.map((value) => numeric(value, -1)).filter((value) => value >= 0) : [];
    return finite.length ? finite.reduce((sum, value) => sum + value, 0) : null;
  } catch {
    return null;
  }
}

"use client";

import {
  AudioLines,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Coins,
  Cpu,
  ExternalLink,
  Gauge,
  Headphones,
  History,
  LayoutDashboard,
  LifeBuoy,
  Library,
  LogOut,
  Mail,
  Menu,
  MessageCircle,
  Mic2,
  MonitorSpeaker,
  MoreHorizontal,
  Pause,
  Phone,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  Volume2,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AdminDashboard from "./AdminDashboard";
import { AuthGate, usePlatformAuth } from "./AuthGate";
import {
  activateUsageSession,
  clearUserSessions,
  getBillingConfig,
  getNotifications,
  getPaymentStatus,
  getUserBootstrap,
  getUserSessions,
  heartbeatUsageSession,
  initializePayment,
  markNotificationsRead,
  prepareUsageSession,
  registerPushToken,
  sendClientEvent,
  sendHeartbeat,
  stopUsageSession,
  stopUsageSessionOnPageHide,
  unregisterPushToken,
  verifyPayment,
} from "./cloud-api";
import {
  EngineApiError,
  type EngineInfo,
  type EngineMode,
  type EngineVoice,
  type GatewayStatus,
  getEngineInfo,
  getGatewayStatus,
  getRvcPerformance,
  selectVoice as selectEngineVoice,
  startConversion,
  stopConversion,
  stopConversionOnPageHide,
  setEngineAuthorizationToken,
  switchGatewayMode,
  uploadRvcModel,
  updateRuntimeSettings,
} from "./engine-api";
import { disablePushNotifications, enablePushNotifications, type EnabledPushNotifications } from "./push-notifications";
import type {
  BillingConfig,
  FlutterwaveInlineInitialization,
  PlatformSession,
  PublicNotification,
  SupportConfig,
  UserSessionRecord,
} from "./platform-types";

type Voice = EngineVoice & {
  type: string;
  color: string;
  initials: string;
  tag?: string;
};

type NavigationTarget = "dashboard" | "library" | "models" | "history" | "account" | "settings";

type SessionRecord = UserSessionRecord;

type ActiveSessionSnapshot = Pick<
  SessionRecord,
  "startedAt" | "engineMode" | "voiceName" | "modelName" | "sampleRate" | "chunkSize" | "latencyMs"
>;

type InstalledModel = {
  key: string;
  slot: number;
  modelName: string;
  voiceChangerType: string;
  runtimeLabel: string;
  voiceCount: number;
  maleCount: number;
  femaleCount: number;
  otherCount: number;
};

type VoiceWorkspaceProps = {
  session: PlatformSession;
  token: string;
  onSignOut: () => Promise<void> | void;
  onRefreshSession: () => Promise<void> | void;
};

const emptySupportConfig: SupportConfig = {
  email: "",
  phone: "",
  whatsapp: "",
  website: "",
  workingHours: "",
  helpCenterUrl: "",
  updatedAt: null,
  updatedBy: null,
};

const voiceColors = ["voice-red", "voice-blue", "voice-purple", "voice-orange", "voice-green"];

const voiceGroupDetails: Array<{ gender: EngineVoice["gender"]; label: string }> = [
  { gender: "male", label: "Male voices" },
  { gender: "female", label: "Female voices" },
  { gender: "other", label: "Other & custom" },
];

function voiceGenderLabel(gender: EngineVoice["gender"]) {
  if (gender === "male") return "Male";
  if (gender === "female") return "Female";
  return "Other";
}

const navItems: Array<{ id: NavigationTarget; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "library", label: "Voice library", icon: Library },
  { id: "models", label: "My models", icon: Mic2 },
  { id: "history", label: "Session history", icon: History },
];

const navigationHeadings: Record<NavigationTarget, { eyebrow: string; title: string }> = {
  dashboard: { eyebrow: "Voice workspace", title: "Dashboard" },
  library: { eyebrow: "Voice collection", title: "Voice library" },
  models: { eyebrow: "Installed locally", title: "My models" },
  history: { eyebrow: "Recent activity", title: "Session history" },
  account: { eyebrow: "Morphly profile", title: "Account" },
  settings: { eyebrow: "Engine configuration", title: "Settings" },
};

const LEGACY_SESSION_HISTORY_KEY = "morphly.sessionHistory.v1";
const DEVICE_ID_KEY = "morphly.deviceId.v1";
const FLUTTERWAVE_SCRIPT_URL = "https://checkout.flutterwave.com/v3.js";

type FlutterwaveResponse = {
  id?: number;
  transaction_id?: number;
  transactionId?: number;
  status?: string;
  tx_ref?: string;
};

type FlutterwaveModal = { close?: () => void };

declare global {
  interface Window {
    FlutterwaveCheckout?: (options: Record<string, unknown>) => FlutterwaveModal;
  }
}

let flutterwaveScriptPromise: Promise<void> | null = null;
let volatileDeviceId = "";

function loadFlutterwaveCheckout() {
  if (window.FlutterwaveCheckout) return Promise.resolve();
  if (flutterwaveScriptPromise) return flutterwaveScriptPromise;
  flutterwaveScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${FLUTTERWAVE_SCRIPT_URL}"]`);
    const script = existing || document.createElement("script");
    const onLoad = () => window.FlutterwaveCheckout ? resolve() : reject(new Error("Flutterwave checkout did not initialize."));
    const onError = () => reject(new Error("Flutterwave checkout could not be loaded. Check your internet connection."));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = FLUTTERWAVE_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    flutterwaveScriptPromise = null;
    throw error;
  });
  return flutterwaveScriptPromise;
}

function deviceId() {
  if (volatileDeviceId) return volatileDeviceId;
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    volatileDeviceId = crypto.randomUUID();
    return volatileDeviceId;
  }
}

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatCreditPackagePrice(amount: number, currency: BillingConfig["currency"]) {
  const locale = currency === "NGN" ? "en-NG" : "en-US";
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(amount);
}

function voiceInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "MV";
}

function dashboardVoice(voice: EngineVoice, index: number): Voice {
  return {
    ...voice,
    type: `${voice.voiceChangerType} · ${voice.runtimeLabel}`,
    color: voiceColors[index % voiceColors.length],
    initials: voiceInitials(voice.name),
    tag: index === 0 ? "Ready" : undefined,
  };
}

function preferredDeviceIndex(info: EngineInfo, current: number, kind: "input" | "output") {
  const devices = kind === "input" ? info.inputDevices : info.outputDevices;
  const selected = kind === "input" ? info.selectedInputDevice : info.selectedOutputDevice;
  if (devices.some((device) => device.index === selected)) return selected;

  // This Beatrice build receives inconsistent callback sizes from MME and
  // WASAPI on this laptop. DirectSound provides the stable local route.
  if (info.mode === "beatrice") {
    const preferredName = kind === "input" ? "internal microphone" : "speakers";
    const directSound = devices.find(
      (device) => device.hostAPI.toLowerCase().includes("directsound")
        && device.name.toLowerCase().includes(preferredName),
    );
    if (directSound) return directSound.index;
  }

  // RVC's callback is most reliable when both sides use the same WASAPI
  // route and the device-native 48 kHz rate. This is only an automatic
  // first-run fallback; a valid saved user selection still wins above.
  if (info.mode === "rvc") {
    const preferredName = kind === "input" ? "internal microphone" : "speakers";
    const wasapi = devices.find(
      (device) => device.hostAPI.toLowerCase().includes("wasapi")
        && device.name.toLowerCase().includes(preferredName),
    );
    if (wasapi) return wasapi.index;
  }

  if (devices.some((device) => device.index === current)) return current;
  return devices[0]?.index ?? -1;
}

function readableError(error: unknown) {
  if (error instanceof EngineApiError || error instanceof Error) return error.message;
  return "The voice engine could not complete that request.";
}

function VoiceWorkspace({ session, token, onSignOut, onRefreshSession }: VoiceWorkspaceProps) {
  const [engineMode, setEngineMode] = useState<EngineMode>("rvc");
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null);
  const [engineInfo, setEngineInfo] = useState<EngineInfo | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isBusy, setIsBusy] = useState(true);
  const [engineError, setEngineError] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [credits, setCredits] = useState(session.credits);
  const [inputGain, setInputGain] = useState(100);
  const [outputGain, setOutputGain] = useState(100);
  const [pitch, setPitch] = useState(0);
  const [indexRate, setIndexRate] = useState(0);
  const [inputDevice, setInputDevice] = useState(-1);
  const [outputDevice, setOutputDevice] = useState(-1);
  const [sampleRate, setSampleRate] = useState(48_000);
  const [chunkSize, setChunkSize] = useState(128);
  const [f0Detector, setF0Detector] = useState("pm");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [creditsOpen, setCreditsOpen] = useState(false);
  const [rvcUploadOpen, setRvcUploadOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [activeNavigation, setActiveNavigation] = useState<NavigationTarget>("dashboard");
  const [openPanel, setOpenPanel] = useState<"models" | "history" | "account" | null>(null);
  const [profileName, setProfileName] = useState(session.displayName || "Morphly creator");
  const [profileDraft, setProfileDraft] = useState(session.displayName || "Morphly creator");
  const [notifications, setNotifications] = useState<PublicNotification[]>([]);
  const [supportConfig, setSupportConfig] = useState<SupportConfig>(emptySupportConfig);
  const [cloudMessage, setCloudMessage] = useState("");
  const [paymentBusy, setPaymentBusy] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [rvcModelFile, setRvcModelFile] = useState<File | null>(null);
  const [rvcIndexFile, setRvcIndexFile] = useState<File | null>(null);
  const [rvcUploadProgress, setRvcUploadProgress] = useState<{ phase: "uploading" | "installing"; percent: number } | null>(null);
  const [rvcUploadError, setRvcUploadError] = useState("");
  const [sessionHistory, setSessionHistory] = useState<SessionRecord[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [toast, setToast] = useState("");
  const [voiceTab, setVoiceTab] = useState<"my" | "featured">("my");
  const [search, setSearch] = useState("");
  const [voiceRowEdges, setVoiceRowEdges] = useState<Record<EngineVoice["gender"], { atStart: boolean; atEnd: boolean }>>({
    male: { atStart: true, atEnd: false },
    female: { atStart: true, atEnd: false },
    other: { atStart: true, atEnd: false },
  });
  const voiceSectionRef = useRef<HTMLElement>(null);
  const settingsSectionRef = useRef<HTMLElement>(null);
  const activeSessionRef = useRef<ActiveSessionSnapshot | null>(null);
  const activeUsageSessionIdRef = useRef<string | null>(null);
  const usageSequenceRef = useRef(0);
  const usageFailureCountRef = useRef(0);
  const usageLeaseDeadlineRef = useRef(0);
  const sessionStopInProgressRef = useRef(false);
  const stopActiveSessionRef = useRef<(reason: "user" | "credits" | "billing") => Promise<void>>(async () => undefined);
  const latestLatencyRef = useRef<number | null>(null);
  const pushRegistrationRef = useRef<EnabledPushNotifications | null>(null);
  const knownNotificationIdsRef = useRef<Set<string>>(new Set());
  const voiceRowRefs = useRef<Partial<Record<EngineVoice["gender"], HTMLDivElement | null>>>({});
  const presenceSessionId = `morphly-presence-${session.uid}`;

  useEffect(() => {
    setEngineAuthorizationToken(token);
    return () => setEngineAuthorizationToken(null);
  }, [token]);

  const updateVoiceRowEdges = useCallback((gender: EngineVoice["gender"]) => {
    const row = voiceRowRefs.current[gender];
    if (!row) return;
    const next = {
      atStart: row.scrollLeft <= 2,
      atEnd: row.scrollLeft + row.clientWidth >= row.scrollWidth - 2,
    };
    setVoiceRowEdges((current) => {
      const previous = current[gender];
      if (previous.atStart === next.atStart && previous.atEnd === next.atEnd) return current;
      return { ...current, [gender]: next };
    });
  }, []);

  const scrollVoiceRow = useCallback((gender: EngineVoice["gender"], direction: -1 | 1) => {
    const row = voiceRowRefs.current[gender];
    if (!row) return;
    row.scrollBy({
      left: direction * Math.max(220, row.clientWidth * 0.82),
    });
  }, []);

  const applyEngineInfo = useCallback((info: EngineInfo) => {
    const nextVoices = info.voices.map(dashboardVoice);
    setEngineInfo(info);
    setVoices(nextVoices);
    setSelectedVoice((current) =>
      nextVoices.find((voice) => voice.id === current?.id) ||
      nextVoices.find((voice) => voice.slot === info.selectedSlot && voice.speaker === info.selectedSpeaker) ||
      nextVoices[0] ||
      null,
    );
    setInputDevice((current) => preferredDeviceIndex(info, current, "input"));
    setOutputDevice((current) => preferredDeviceIndex(info, current, "output"));
    setInputGain(Math.round(info.inputGain * 100));
    setOutputGain(Math.round(info.outputGain * 100));
    setPitch(info.pitch);
    setIndexRate(Math.round(info.indexRatio * 100));
    setSampleRate(info.sampleRate || 48_000);
    setChunkSize(
      info.mode === "beatrice"
        ? Math.max(60, Math.min(240, info.chunkSize || 120))
        : Math.max(64, Math.min(512, info.chunkSize || 128)),
    );
    setF0Detector(info.f0Detector || "pm");
    setIsRunning(info.running);
  }, []);

  const refreshEngine = useCallback(async (quiet = false) => {
    if (!quiet) setIsBusy(true);
    try {
      const status = await getGatewayStatus();
      setGatewayStatus(status);
      setEngineMode(status.mode);
      if (!status.ready || status.switching) {
        setEngineError(status.error || "");
        setEngineInfo(null);
        setVoices([]);
        return;
      }
      const info = await getEngineInfo(status.mode);
      applyEngineInfo(info);
      setEngineError("");
    } catch (error) {
      setEngineError(readableError(error));
      setEngineInfo(null);
      setVoices([]);
    } finally {
      if (!quiet) setIsBusy(false);
    }
  }, [applyEngineInfo]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refreshEngine(), 0);
    return () => window.clearTimeout(timeout);
  }, [refreshEngine]);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const status = await getGatewayStatus();
        setGatewayStatus(status);
        if (status.mode !== engineMode || (status.ready && !engineInfo)) void refreshEngine(true);
        if (!status.ready) setEngineError(status.error || "");
      } catch {
        // The refresh button exposes connection errors without noisy polling toasts.
      }
    }, 3500);
    return () => window.clearInterval(timer);
  }, [engineInfo, engineMode, refreshEngine]);

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      setSeconds((current) => current + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  useEffect(() => {
    if (engineMode !== "rvc" || !gatewayStatus?.ready) {
      const timeout = window.setTimeout(() => setLatencyMs(null), 0);
      return () => window.clearTimeout(timeout);
    }
    const updatePerformance = async () => setLatencyMs(await getRvcPerformance());
    void updatePerformance();
    const timer = window.setInterval(updatePerformance, 2500);
    return () => window.clearInterval(timer);
  }, [engineMode, gatewayStatus?.ready]);

  useEffect(() => {
    if (!toast || isBusy) return;
    const timeout = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timeout);
  }, [isBusy, toast]);

  useEffect(() => {
    try {
      window.localStorage.removeItem(LEGACY_SESSION_HISTORY_KEY);
    } catch {
      // Private browsing/storage policies must not prevent the authenticated workspace from opening.
    }
    const nextName = session.displayName || session.email.split("@")[0] || "Morphly creator";
    const timeout = window.setTimeout(() => {
      setProfileName(nextName);
      setProfileDraft(nextName);
      setCredits(session.credits);
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [session.credits, session.displayName, session.email, session.uid]);

  useEffect(() => {
    latestLatencyRef.current = latencyMs;
  }, [latencyMs]);

  const refreshNotifications = useCallback(async (announceNew = false) => {
    const result = await getNotifications(token);
    if (announceNew) {
      const nextUnread = result.notifications.filter(
        (notification) => !notification.isRead && !knownNotificationIdsRef.current.has(notification.id),
      );
      if (nextUnread.length && "Notification" in window && Notification.permission === "granted") {
        const newest = nextUnread[0];
        try {
          new Notification(newest.title, { body: newest.message, icon: "/morphly-icon-192.png", tag: newest.id });
        } catch {
          // The in-app inbox remains authoritative if the OS rejects a desktop notification.
        }
      }
    }
    knownNotificationIdsRef.current = new Set(result.notifications.map((notification) => notification.id));
    setNotifications(result.notifications);
    return result;
  }, [token]);

  const refreshBillingPackages = useCallback(async () => {
    setBillingLoading(true);
    setBillingError("");
    try {
      const latest = await getBillingConfig(token);
      const enabledPlans = latest.plans.filter((plan) => plan.enabled);
      setBillingConfig(latest);
      setSelectedPlanId((current) => enabledPlans.some((plan) => plan.id === current) ? current : enabledPlans[0]?.id || "");
      return latest;
    } catch (error) {
      const message = readableError(error);
      setBillingError(message);
      throw error;
    } finally {
      setBillingLoading(false);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      getUserBootstrap(token),
      getUserSessions(token),
      getBillingConfig(token),
    ]).then(([bootstrapResult, historyResult, billingResult]) => {
      if (cancelled) return;
      const failures: string[] = [];
      if (bootstrapResult.status === "fulfilled") {
        const bootstrap = bootstrapResult.value;
        setCredits(bootstrap.session.credits);
        setNotifications(bootstrap.notifications);
        setSupportConfig(bootstrap.support);
        knownNotificationIdsRef.current = new Set(bootstrap.notifications.map((notification) => notification.id));
      } else failures.push(readableError(bootstrapResult.reason));
      if (historyResult.status === "fulfilled") setSessionHistory(historyResult.value);
      else failures.push(`Session history: ${readableError(historyResult.reason)}`);
      if (billingResult.status === "fulfilled") {
        setBillingConfig(billingResult.value);
        const enabledPlans = billingResult.value.plans.filter((plan) => plan.enabled);
        setSelectedPlanId((current) => enabledPlans.some((plan) => plan.id === current) ? current : enabledPlans[0]?.id || "");
        setBillingError("");
      } else {
        const message = readableError(billingResult.reason);
        setBillingError(message);
        failures.push(`Billing: ${message}`);
      }
      setCloudMessage(failures.join(" "));
    });
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    const refresh = () => void refreshNotifications(true).catch(() => undefined);
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshNotifications]);

  useEffect(() => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    let cancelled = false;
    const currentDeviceId = deviceId();
    void enablePushNotifications({
      onToken: async (pushToken) => {
        await registerPushToken(token, {
          token: pushToken,
          deviceId: currentDeviceId,
          userAgent: navigator.userAgent,
        });
      },
      onForegroundMessage: () => void refreshNotifications(true).catch(() => undefined),
    }).then((registration) => {
      if (cancelled) {
        registration.stopForegroundMessages();
        return;
      }
      pushRegistrationRef.current = registration;
      setPushEnabled(true);
    }).catch(() => {
      // The in-app authenticated inbox still works when background push is unavailable.
    });
    return () => {
      cancelled = true;
      pushRegistrationRef.current?.stopForegroundMessages();
      pushRegistrationRef.current = null;
    };
  }, [refreshNotifications, token]);

  const selectVoice = async (voice: Voice) => {
    if (isRunning) {
      setToast("Stop the session before changing voice models.");
      return;
    }
    if (isBusy || !gatewayStatus?.ready) return;
    setIsBusy(true);
    setSelectedVoice(voice);
    setToast(engineMode === "rvc" ? `Loading ${voice.name} on CPU...` : `Selecting ${voice.name}...`);
    try {
      await selectEngineVoice(engineMode, voice, pitch, chunkSize);
      setToast(`${voice.name} is now selected.`);
      await refreshEngine(true);
    } catch (error) {
      setEngineError(readableError(error));
      setToast("The model could not be selected.");
    } finally {
      setIsBusy(false);
    }
  };

  const stopActiveSession = useCallback(async (reason: "user" | "credits" | "billing") => {
    if (sessionStopInProgressRef.current) return;
    const snapshot = activeSessionRef.current;
    const usageSessionId = activeUsageSessionIdRef.current;
    sessionStopInProgressRef.current = true;
    usageLeaseDeadlineRef.current = 0;
    setIsBusy(true);
    setEngineError("");
    try {
      if (!snapshot || !usageSessionId) {
        const info = await stopConversion(engineMode);
        applyEngineInfo(info);
        setToast("A previous unmetered engine session was stopped. Start again to connect it to this account.");
        return;
      }
      const info = await stopConversion(snapshot.engineMode);
      applyEngineInfo(info);
      let chargedCredits = 0;
      try {
        const usage = await stopUsageSession(token, {
          sessionId: usageSessionId,
          sequence: ++usageSequenceRef.current,
          latencyMs: snapshot.latencyMs,
        });
        setCredits(usage.creditsRemaining);
        chargedCredits = usage.totalChargedCredits;
      } catch (error) {
        setCloudMessage(`Usage record: ${readableError(error)}`);
      }

      const endedAt = new Date();
      const elapsedSeconds = Math.max(1, Math.round((endedAt.getTime() - new Date(snapshot.startedAt).getTime()) / 1000));
      const record: SessionRecord = {
        ...snapshot,
        id: usageSessionId,
        clientSessionId: usageSessionId,
        endedAt: endedAt.toISOString(),
        durationSeconds: Math.max(seconds, elapsedSeconds),
        status: reason === "user" ? "completed" : reason === "credits" ? "credit_exhausted" : "billing_unavailable",
        creditsCharged: chargedCredits,
      };
      setSessionHistory((current) => [record, ...current.filter((item) => item.clientSessionId !== usageSessionId)].slice(0, 50));
      await sendClientEvent(token, {
        event: "session_stopped",
        category: "voice_session",
        sessionId: usageSessionId,
        engine: snapshot.engineMode,
        message: `${snapshot.voiceName} session completed.`,
        metadata: {
          voiceName: snapshot.voiceName,
          modelName: snapshot.modelName,
          durationSeconds: record.durationSeconds,
          sampleRate: snapshot.sampleRate,
          chunkSize: snapshot.chunkSize,
          latencyMs: snapshot.latencyMs,
          stopReason: reason,
        },
      }).catch(() => undefined);
      activeSessionRef.current = null;
      activeUsageSessionIdRef.current = null;
      setSeconds(0);
      if (reason === "credits") {
        setCreditsOpen(true);
        setToast("Your remaining credits were used. Add credits to start another session.");
      } else if (reason === "billing") {
        setToast("Voice conversion stopped because usage billing could not be verified.");
      } else {
        setToast("Voice conversion stopped and saved to your account history.");
      }
      window.setTimeout(() => void getUserSessions(token).then(setSessionHistory).catch(() => undefined), 750);
    } catch (error) {
      const message = readableError(error);
      setEngineError(message);
      setToast(message);
      await refreshEngine(true);
    } finally {
      sessionStopInProgressRef.current = false;
      setIsBusy(false);
    }
  }, [applyEngineInfo, engineMode, refreshEngine, seconds, token]);

  useEffect(() => {
    stopActiveSessionRef.current = stopActiveSession;
  }, [stopActiveSession]);

  const toggleSession = async () => {
    if (isBusy || !gatewayStatus?.ready || !engineInfo) return;
    if (isRunning) {
      await stopActiveSession("user");
      return;
    }
    if (!selectedVoice) {
      setToast("Choose a loaded voice model first.");
      return;
    }
    const requiredCredits = billingConfig?.creditsPerPeriod ?? 2;
    if (credits < requiredCredits) {
      setCreditsOpen(true);
      setToast(`At least ${requiredCredits} credits are required to start voice conversion.`);
      return;
    }

    const usageSessionId = `morphly-${crypto.randomUUID()}`;
    let prepared = false;
    let localAudioStarted = false;
    setIsBusy(true);
    setEngineError("");
    try {
      const preparedUsage = await prepareUsageSession(token, {
        sessionId: usageSessionId,
        engine: engineMode,
        voiceName: selectedVoice.name,
        modelName: selectedVoice.modelName,
        sampleRate,
        chunkSize,
        latencyMs,
      });
      prepared = true;
      setCredits(preparedUsage.creditsRemaining);
      const info = await startConversion(engineMode, engineInfo, selectedVoice, {
        inputDevice,
        outputDevice,
        sampleRate,
        inputGain: inputGain / 100,
        outputGain: outputGain / 100,
        pitch,
        indexRatio: indexRate / 100,
        chunkSize,
        f0Detector,
      });
      if (!info.running) throw new EngineApiError("The engine did not confirm that live audio started.");
      localAudioStarted = true;
      const activated = await activateUsageSession(token, usageSessionId);
      if (!activated.allowed) {
        await stopConversion(engineMode).catch(() => undefined);
        localAudioStarted = false;
        throw new Error("Usage billing did not authorize this voice session.");
      }
      applyEngineInfo(info);
      setCredits(activated.creditsRemaining);
      setSeconds(0);
      usageSequenceRef.current = 0;
      usageFailureCountRef.current = 0;
      usageLeaseDeadlineRef.current = Date.now() + 15_000;
      activeUsageSessionIdRef.current = usageSessionId;
      activeSessionRef.current = {
        startedAt: new Date().toISOString(),
        engineMode,
        voiceName: selectedVoice.name,
        modelName: selectedVoice.modelName,
        sampleRate,
        chunkSize,
        latencyMs,
      };
      void sendClientEvent(token, {
        event: "session_started",
        category: "voice_session",
        sessionId: usageSessionId,
        engine: engineMode,
        message: `${selectedVoice.name} session started.`,
        metadata: { voiceName: selectedVoice.name, modelName: selectedVoice.modelName, sampleRate, chunkSize },
      }).catch(() => undefined);
      setToast(`Live voice conversion started. Billing is ${requiredCredits} credits per 10-second connection block.`);
    } catch (error) {
      if (localAudioStarted) await stopConversion(engineMode).catch(() => undefined);
      if (prepared) {
        void stopUsageSession(token, { sessionId: usageSessionId, sequence: 0, latencyMs }).catch(() => undefined);
      }
      const message = readableError(error);
      setEngineError(message);
      setToast(message);
      void sendClientEvent(token, {
        event: "engine_error",
        category: "voice_engine",
        level: "error",
        sessionId: usageSessionId,
        engine: engineMode,
        message,
      }).catch(() => undefined);
      await refreshEngine(true);
    } finally {
      setIsBusy(false);
    }
  };

  const switchEngine = async (mode: EngineMode) => {
    if (mode === engineMode || isBusy || isRunning) {
      if (isRunning) setToast("Stop voice conversion before switching engines.");
      return;
    }
    setIsBusy(true);
    setEngineError("");
    setVoices([]);
    setEngineInfo(null);
    setSelectedVoice(null);
    try {
      setGatewayStatus({ mode, ready: false, switching: true, message: `Starting ${mode === "rvc" ? "RVC" : "Beatrice V2"}...` });
      const status = await switchGatewayMode(mode);
      setGatewayStatus(status);
      setEngineMode(status.mode);
      if (!status.ready) throw new EngineApiError(status.error || status.message || "The selected engine did not become ready.");
      const info = await getEngineInfo(status.mode);
      applyEngineInfo(info);
      setEngineError("");
      setToast(`${mode === "rvc" ? "RVC" : "Beatrice V2"} is ready.`);
      void sendClientEvent(token, {
        event: "engine_switched",
        category: "voice_engine",
        sessionId: activeUsageSessionIdRef.current || presenceSessionId,
        engine: mode,
        message: `${mode === "rvc" ? "RVC" : "Beatrice V2"} selected.`,
      }).catch(() => undefined);
    } catch (error) {
      setEngineError(readableError(error));
      await refreshEngine(true);
    } finally {
      setIsBusy(false);
    }
  };

  const commitSetting = async (patch: Parameters<typeof updateRuntimeSettings>[2], successMessage?: string) => {
    if (!gatewayStatus?.ready || isBusy) return;
    try {
      await updateRuntimeSettings(engineMode, selectedVoice, patch);
      if (successMessage) setToast(successMessage);
    } catch (error) {
      setEngineError(readableError(error));
      setToast("That engine setting could not be saved.");
    }
  };

  const saveSettings = async () => {
    await commitSetting({
      inputDevice,
      outputDevice,
      sampleRate,
      inputGain: inputGain / 100,
      outputGain: outputGain / 100,
      pitch,
      indexRatio: indexRate / 100,
      chunkSize,
      f0Detector,
    }, "Voice and audio settings saved.");
  };

  const openRvcUpload = () => {
    if (isRunning) {
      setToast("Stop the voice changer before installing another RVC voice.");
      return;
    }
    setRvcUploadError("");
    setRvcUploadOpen(true);
  };

  const closeRvcUpload = () => {
    if (rvcUploadProgress) return;
    setRvcUploadOpen(false);
    setRvcModelFile(null);
    setRvcIndexFile(null);
    setRvcUploadError("");
  };

  const installRvcVoice = async () => {
    if (!engineInfo || engineMode !== "rvc" || !engineReady) {
      setRvcUploadError("Start the RVC engine before uploading a voice.");
      return;
    }
    if (!rvcModelFile) {
      setRvcUploadError("Choose the extracted RVC .pth or .onnx model file.");
      return;
    }
    setRvcUploadError("");
    setRvcUploadProgress({ phase: "uploading", percent: 0 });
    try {
      const result = await uploadRvcModel(engineInfo, { model: rvcModelFile, index: rvcIndexFile }, setRvcUploadProgress);
      applyEngineInfo(result.info);
      const uploadedVoice = result.info.voices.find((voice) => voice.slot === result.slot);
      if (uploadedVoice) setSelectedVoice(dashboardVoice(uploadedVoice, result.info.voices.indexOf(uploadedVoice)));
      setVoiceTab("my");
      setSearch("");
      setRvcUploadProgress(null);
      setRvcUploadOpen(false);
      setRvcModelFile(null);
      setRvcIndexFile(null);
      setToast(`${uploadedVoice?.name || rvcModelFile.name} was added to My voices.`);
    } catch (error) {
      setRvcUploadProgress(null);
      setRvcUploadError(readableError(error));
    }
  };

  const reconcilePaymentStatus = async (txRef: string, attempts = 6) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const status = await getPaymentStatus(token, txRef);
        if (status.credited) {
          const bootstrap = await getUserBootstrap(token);
          setCredits(status.newBalance ?? bootstrap.session.credits);
          setCloudMessage("");
          setToast("Payment confirmed and credits added.");
          setCreditsOpen(false);
          await onRefreshSession();
          return true;
        }
        if (new Set(["failed", "cancelled", "canceled"]).has(status.status.toLowerCase())) return false;
      } catch {
        // A webhook may still complete the purchase; retry briefly before asking the user to refresh.
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      }
    }
    return false;
  };

  const beginCheckout = async (planId: string) => {
    setPaymentBusy(planId);
    setCloudMessage("");
    let checkoutOpened = false;
    let callbackReceived = false;
    try {
      const latestBilling = await getBillingConfig(token);
      const displayedPlan = billingConfig?.plans.find((plan) => plan.id === planId);
      const latestPlan = latestBilling.plans.find((plan) => plan.id === planId && plan.enabled);
      setBillingConfig(latestBilling);
      if (!latestPlan) {
        setSelectedPlanId(latestBilling.plans[0]?.id || "");
        throw new Error("That credit package is no longer available. Review the current packages and choose again.");
      }
      if (
        !displayedPlan ||
        latestBilling.version !== billingConfig?.version ||
        latestBilling.currency !== billingConfig?.currency ||
        latestPlan.amountMinor !== displayedPlan.amountMinor ||
        latestPlan.credits !== displayedPlan.credits
      ) {
        setSelectedPlanId(latestPlan.id);
        throw new Error("Credit-package pricing changed. Review the updated amount, then click Proceed to payment again.");
      }
      const payment = await initializePayment(token, {
        planId,
        expectedBillingVersion: latestBilling.version,
        expectedAmountMinor: latestPlan.amountMinor,
        expectedCurrency: latestBilling.currency,
        checkoutMode: "inline",
      });
      if (!payment.inline) throw new Error("Flutterwave Inline did not return a checkout configuration.");
      await loadFlutterwaveCheckout();
      if (!window.FlutterwaveCheckout) throw new Error("Flutterwave checkout is unavailable.");
      const inline: FlutterwaveInlineInitialization = payment.inline;
      const modal = window.FlutterwaveCheckout({
        public_key: inline.publicKey,
        tx_ref: inline.txRef,
        amount: inline.amount,
        currency: inline.currency,
        payment_options: "card,banktransfer,ussd",
        customer: inline.customer,
        meta: inline.meta,
        customizations: inline.customizations,
        callback: async (response: FlutterwaveResponse) => {
          callbackReceived = true;
          modal?.close?.();
          const transactionId = Number(response.transaction_id ?? response.transactionId ?? response.id);
          if (!Number.isSafeInteger(transactionId) || transactionId <= 0) {
            setCloudMessage("Flutterwave returned an invalid transaction response. No credits were added.");
            setPaymentBusy("");
            return;
          }
          setPaymentBusy(planId);
          try {
            const verified = await verifyPayment(token, transactionId, inline.txRef);
            if (verified.newBalance !== null) setCredits(verified.newBalance);
            const bootstrap = await getUserBootstrap(token);
            setCredits(bootstrap.session.credits);
            setToast(verified.duplicate ? "This payment was already verified." : "Payment verified and credits added.");
            setCreditsOpen(false);
            await onRefreshSession();
          } catch (error) {
            const recovered = await reconcilePaymentStatus(inline.txRef, 6);
            if (!recovered) setCloudMessage(`Payment verification: ${readableError(error)} Your signed webhook can still confirm it; reopen Credits shortly to refresh.`);
          } finally {
            setPaymentBusy("");
          }
        },
        onclose: () => {
          if (callbackReceived) {
            setPaymentBusy("");
            return;
          }
          setPaymentBusy(planId);
          void reconcilePaymentStatus(inline.txRef, 6).then((recovered) => {
            if (!recovered) setCloudMessage("Payment window closed. If you completed payment, the signed Flutterwave webhook may still add the credits shortly.");
          }).finally(() => setPaymentBusy(""));
        },
      });
      checkoutOpened = true;
      void sendClientEvent(token, {
        event: "payment_opened",
        category: "payment",
        message: `Flutterwave checkout opened for ${planId}.`,
        metadata: { planId, reference: payment.reference },
      }).catch(() => undefined);
      setToast("Flutterwave secure payment opened.");
    } catch (error) {
      setCloudMessage(readableError(error));
    } finally {
      // Keep the package controls locked until Flutterwave closes or invokes
      // the verification callback. This prevents accidental duplicate checkouts.
      if (!checkoutOpened) setPaymentBusy("");
    }
  };

  const openCredits = () => {
    setCreditsOpen(true);
    void refreshBillingPackages().catch(() => undefined);
  };

  const openNotifications = async () => {
    setNotificationsOpen(true);
    const unreadIds = notifications.filter((notification) => !notification.isRead).map((notification) => notification.id);
    if (!unreadIds.length) return;
    try {
      await markNotificationsRead(token, unreadIds);
      await refreshNotifications(false);
    } catch (error) {
      setCloudMessage(`Notifications: ${readableError(error)}`);
    }
  };

  const enableDesktopNotifications = async () => {
    setPushBusy(true);
    try {
      const currentDeviceId = deviceId();
      const registration = await enablePushNotifications({
        onToken: async (pushToken) => {
          await registerPushToken(token, {
            token: pushToken,
            deviceId: currentDeviceId,
            userAgent: navigator.userAgent,
          });
        },
        onForegroundMessage: () => void refreshNotifications(true).catch(() => undefined),
      });
      pushRegistrationRef.current = registration;
      setPushEnabled(true);
      setToast("Desktop and push notifications are enabled.");
    } catch (error) {
      setCloudMessage(`Push notifications: ${readableError(error)}`);
    } finally {
      setPushBusy(false);
    }
  };

  const signOut = async () => {
    if (isRunning) await stopActiveSession("user");
    const currentDeviceId = deviceId();
    try {
      if (pushRegistrationRef.current) {
        await pushRegistrationRef.current.disable({
          onTokenRevoked: async () => {
            await unregisterPushToken(token, currentDeviceId);
          },
        });
      } else {
        await unregisterPushToken(token, currentDeviceId).catch(() => undefined);
        await disablePushNotifications().catch(() => undefined);
      }
    } finally {
      pushRegistrationRef.current = null;
      await onSignOut();
    }
  };

  const clearHistory = async () => {
    setHistoryBusy(true);
    try {
      let result = await clearUserSessions(token);
      let rounds = 1;
      while (result.moreRemaining && rounds < 10) {
        result = await clearUserSessions(token);
        rounds += 1;
      }
      setSessionHistory([]);
      setToast("Your account session history was cleared.");
    } catch (error) {
      setCloudMessage(`Session history: ${readableError(error)}`);
    } finally {
      setHistoryBusy(false);
    }
  };

  const engineReady = Boolean(gatewayStatus?.ready && engineInfo && !engineError);
  const engineStarting = !engineReady && !engineError && (!gatewayStatus?.ready || gatewayStatus?.switching || isBusy);
  const engineLabel = engineMode === "rvc" ? "Morphly RVC Engine" : "Morphly Beatrice V2 Engine";
  const unreadNotificationCount = notifications.filter((notification) => !notification.isRead).length;

  useEffect(() => {
    if (!isRunning) return;
    let inFlight = false;
    let cancelled = false;
    const reportUsage = async () => {
      const sessionId = activeUsageSessionIdRef.current;
      if (!sessionId || inFlight || cancelled || sessionStopInProgressRef.current) return;
      if (Date.now() > usageLeaseDeadlineRef.current) {
        await stopActiveSessionRef.current("billing");
        return;
      }
      inFlight = true;
      try {
        const nextSequence = usageSequenceRef.current + 1;
        const result = await heartbeatUsageSession(token, {
          sessionId,
          sequence: nextSequence,
          latencyMs: latestLatencyRef.current,
        });
        if (cancelled) return;
        // Advance only after an acknowledged response. If a response is lost,
        // retrying the same sequence is idempotent on the server.
        usageSequenceRef.current = nextSequence;
        usageFailureCountRef.current = 0;
        usageLeaseDeadlineRef.current = Date.now() + 15_000;
        setCredits(result.creditsRemaining);
        if (!result.allowed) {
          await stopActiveSessionRef.current(result.status === "credit_exhausted" ? "credits" : "billing");
        }
      } catch (error) {
        if (cancelled) return;
        usageFailureCountRef.current += 1;
        setCloudMessage(`Usage billing: ${readableError(error)}`);
        if (usageFailureCountRef.current >= 3) await stopActiveSessionRef.current("billing");
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void reportUsage(), 5_000);
    const watchdog = window.setInterval(() => {
      if (!cancelled && !sessionStopInProgressRef.current && Date.now() > usageLeaseDeadlineRef.current) {
        void stopActiveSessionRef.current("billing");
      }
    }, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(watchdog);
    };
  }, [isRunning, token]);

  useEffect(() => {
    if (!isRunning || activeUsageSessionIdRef.current) return;
    void stopActiveSessionRef.current("billing");
  }, [isRunning]);

  useEffect(() => {
    if (!isRunning) return;
    const stopOnPageHide = () => {
      sessionStopInProgressRef.current = true;
      usageLeaseDeadlineRef.current = 0;
      const usageSessionId = activeUsageSessionIdRef.current;
      void stopConversionOnPageHide(engineMode).catch(() => undefined);
      if (usageSessionId) {
        void stopUsageSessionOnPageHide(token, {
          sessionId: usageSessionId,
          sequence: ++usageSequenceRef.current,
          latencyMs: latestLatencyRef.current,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", stopOnPageHide);
    return () => window.removeEventListener("pagehide", stopOnPageHide);
  }, [engineMode, isRunning, token]);

  useEffect(() => {
    const report = () => {
      void sendHeartbeat(token, {
        sessionId: activeUsageSessionIdRef.current || presenceSessionId,
        engine: engineMode,
        status: engineError ? "error" : isRunning ? "live" : engineReady ? "idle" : "starting",
        voiceName: selectedVoice?.name,
        latencyMs: latestLatencyRef.current,
        appVersion: "0.1.0",
        platform: navigator.userAgent,
      }).catch(() => undefined);
    };
    report();
    const timer = window.setInterval(report, 30_000);
    return () => window.clearInterval(timer);
  }, [engineError, engineMode, engineReady, isRunning, selectedVoice?.name, presenceSessionId, token]);

  const shownVoices = useMemo(() => {
    const ordered = voiceTab === "my" ? voices : [...voices].reverse();
    const query = search.trim().toLowerCase();
    if (!query) return ordered;
    if (query === "male" || query === "female" || query === "other") {
      return ordered.filter((voice) => voice.gender === query);
    }
    return ordered.filter((voice) => {
      const genderTerms = voice.gender === "male"
        ? "male man men"
        : voice.gender === "female"
          ? "female woman women"
          : "other custom imported";
      return `${voice.name} ${voice.modelName} ${voice.type} ${genderTerms}`.toLowerCase().includes(query);
    });
  }, [search, voiceTab, voices]);
  const voiceGroups = useMemo(
    () => voiceGroupDetails
      .map((group) => ({
        ...group,
        voices: shownVoices.filter((voice) => voice.gender === group.gender),
      }))
      .filter((group) => group.voices.length > 0),
    [shownVoices],
  );
  const installedModels = useMemo(() => {
    const models = new Map<string, InstalledModel>();
    voices.forEach((voice) => {
      const key = `${voice.slot}:${voice.modelName}`;
      const current = models.get(key) || {
        key,
        slot: voice.slot,
        modelName: voice.modelName,
        voiceChangerType: voice.voiceChangerType,
        runtimeLabel: voice.runtimeLabel,
        voiceCount: 0,
        maleCount: 0,
        femaleCount: 0,
        otherCount: 0,
      };
      current.voiceCount += 1;
      if (voice.gender === "male") current.maleCount += 1;
      else if (voice.gender === "female") current.femaleCount += 1;
      else current.otherCount += 1;
      models.set(key, current);
    });
    return [...models.values()].sort((left, right) => left.slot - right.slot);
  }, [voices]);
  const totalSessionSeconds = useMemo(
    () => sessionHistory.reduce((total, session) => total + (Number(session.durationSeconds) || 0), 0),
    [sessionHistory],
  );

  useEffect(() => {
    Object.values(voiceRowRefs.current).forEach((row) => row?.scrollTo({ left: 0 }));
  }, [engineMode, search, voiceTab]);

  useEffect(() => {
    const cleanups = voiceGroups.map((group) => {
      const row = voiceRowRefs.current[group.gender];
      if (!row) return () => undefined;
      const updateEdges = () => updateVoiceRowEdges(group.gender);
      updateEdges();
      row.addEventListener("scroll", updateEdges, { passive: true });
      const resizeObserver = new ResizeObserver(updateEdges);
      resizeObserver.observe(row);
      return () => {
        row.removeEventListener("scroll", updateEdges);
        resizeObserver.disconnect();
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [updateVoiceRowEdges, voiceGroups]);

  useEffect(() => {
    if (!selectedVoice) return;
    const row = voiceRowRefs.current[selectedVoice.gender];
    const selectedCard = row?.querySelector<HTMLElement>(`[data-voice-id="${selectedVoice.id}"]`);
    selectedCard?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [selectedVoice]);
  const inputOptions = useMemo(
    () => (engineInfo?.inputDevices || []).map((device) => ({ value: String(device.index), label: `${device.name}${device.hostAPI ? ` · ${device.hostAPI}` : ""}` })),
    [engineInfo],
  );
  const outputOptions = useMemo(
    () => (engineInfo?.outputDevices || []).map((device) => ({ value: String(device.index), label: `${device.name}${device.hostAPI ? ` · ${device.hostAPI}` : ""}` })),
    [engineInfo],
  );
  const chunkOptions = engineMode === "rvc"
    ? [
        { value: "96", label: "Low latency · 96" },
        { value: "128", label: "Balanced · 128" },
        { value: "192", label: "Stable · 192" },
        { value: "256", label: "High stability · 256" },
      ]
    : [
        { value: "80", label: "Low latency · 80 ms" },
        { value: "120", label: "Balanced · 120 ms" },
        { value: "160", label: "Stable · 160 ms" },
        { value: "200", label: "High stability · 200 ms" },
      ];

  const scrollToSection = (section: HTMLElement | null) => {
    window.requestAnimationFrame(() => section?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const navigateTo = (target: NavigationTarget) => {
    setActiveNavigation(target);
    setMobileMenu(false);
    setOpenPanel(null);
    if (target === "dashboard") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    } else if (target === "library") {
      setSearch("");
      setVoiceTab("featured");
      scrollToSection(voiceSectionRef.current);
    } else if (target === "models") {
      setOpenPanel("models");
    } else if (target === "history") {
      setOpenPanel("history");
    } else if (target === "account") {
      setProfileDraft(profileName);
      setOpenPanel("account");
    } else if (target === "settings") {
      setAdvancedOpen(true);
      scrollToSection(settingsSectionRef.current);
    }
  };

  const showModelVoices = (model: InstalledModel) => {
    setOpenPanel(null);
    setActiveNavigation("library");
    setVoiceTab("my");
    setSearch(model.modelName);
    scrollToSection(voiceSectionRef.current);
  };

  const firstName = profileName.trim().split(/\s+/)[0] || "Creator";
  const profileInitials = voiceInitials(profileName);
  const currentHeading = navigationHeadings[activeNavigation];
  const availableCreditPlans = billingConfig?.plans.filter((plan) => plan.enabled) || [];

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenu ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            {/* The Vite-served dashboard uses this public asset directly. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="brand-logo" src="/morphly-logo.png" alt="" width={800} height={800} />
          </div>
          <div>
            <strong>Morphly Voice</strong>
            <span>Real-time AI studio</span>
          </div>
          <button className="mobile-close icon-button" onClick={() => setMobileMenu(false)} aria-label="Close menu"><X size={20} /></button>
        </div>

        <button className="credit-card" onClick={openCredits}>
          <span className="credit-icon"><Coins size={18} /></span>
          <span className="credit-copy">
            <small>Available credits</small>
            <strong>{credits.toLocaleString()}</strong>
          </span>
          <span className="credit-add"><Plus size={16} /></span>
        </button>

        <nav className="side-nav" aria-label="Primary navigation">
          <p className="nav-caption">Workspace</p>
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button className={activeNavigation === item.id ? "active" : ""} aria-current={activeNavigation === item.id ? "page" : undefined} key={item.id} onClick={() => navigateTo(item.id)}>
                <Icon size={18} />
                <span>{item.label}</span>
                {item.id === "models" && <span className="nav-count">{installedModels.length}</span>}
                {item.id === "history" && sessionHistory.length > 0 && <span className="nav-count">{sessionHistory.length}</span>}
              </button>
            );
          })}
          <p className="nav-caption nav-caption-spaced">Account</p>
          <button className={activeNavigation === "account" ? "active" : ""} aria-current={activeNavigation === "account" ? "page" : undefined} onClick={() => navigateTo("account")}><UserRound size={18} /><span>Account</span></button>
          <button className={activeNavigation === "settings" ? "active" : ""} aria-current={activeNavigation === "settings" ? "page" : undefined} onClick={() => navigateTo("settings")}><Settings2 size={18} /><span>Settings</span></button>
          <button onClick={() => setGuideOpen(true)}><CircleHelp size={18} /><span>Setup guide</span></button>
        </nav>

        <div className="sidebar-bottom">
          <div className="system-card">
            <span className="system-icon"><ShieldCheck size={18} /></span>
            <div><strong>Engine protected</strong><span>Local processing active</span></div>
          </div>
          <button className="profile-row" onClick={() => navigateTo("account")}>
            <span className="avatar-small">{profileInitials}</span>
            <span><strong>{profileName}</strong><small>{session.email}</small></span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>

      {mobileMenu && <button className="menu-scrim" aria-label="Close menu" onClick={() => setMobileMenu(false)} />}

      <main className="dashboard">
        <header className="topbar">
          <div className="mobile-brand">
            <button className="icon-button" onClick={() => setMobileMenu(true)} aria-label="Open menu"><Menu size={21} /></button>
            <div className="brand-mark" aria-hidden="true">
              {/* The Vite-served dashboard uses this public asset directly. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="brand-logo" src="/morphly-logo.png" alt="" width={800} height={800} />
            </div>
            <strong>Morphly Voice</strong>
          </div>
          <div className="page-heading">
            <p>{currentHeading.eyebrow}</p>
            <h1>{activeNavigation === "dashboard" ? `Good afternoon, ${firstName}` : currentHeading.title}</h1>
          </div>
          <div className="topbar-actions">
            <button className="mobile-credit" onClick={() => setCreditsOpen(true)}><Coins size={16} /> {credits.toLocaleString()}</button>
            <button className="icon-button notification" aria-label={`${unreadNotificationCount} unread notifications`} onClick={() => void openNotifications()}>
              <Bell size={19} />
              {unreadNotificationCount > 0 && <span />}
            </button>
            <button className="secondary-button guide-button" onClick={() => setGuideOpen(true)}><CircleHelp size={17} /> Setup guide</button>
          </div>
        </header>

        <div className="content-wrap">
          <section className="welcome-strip">
            <div>
              <span className="eyebrow"><Sparkles size={14} /> {engineLabel}</span>
              <h2>Sound like anyone. <em>Stay unmistakably you.</em></h2>
              <p>Select a voice, confirm your audio devices, and start a low-latency conversion session.</p>
            </div>
            <div className="welcome-actions">
              <div className="engine-mode-switch" role="group" aria-label="Voice engine">
                <button className={engineMode === "rvc" ? "selected" : ""} disabled={isBusy || isRunning} onClick={() => void switchEngine("rvc")}><Cpu size={15} /> RVC</button>
                <button className={engineMode === "beatrice" ? "selected" : ""} disabled={isBusy || isRunning} onClick={() => void switchEngine("beatrice")}><Sparkles size={15} /> Beatrice V2</button>
              </div>
              <div className={`latency-stat ${engineError ? "has-error" : ""}`}>
                <span className="pulse-dot" />
                <div>
                  <small>Engine status</small>
                  <strong>{engineStarting ? gatewayStatus?.message || "Starting automatically..." : engineReady ? `Ready${latencyMs !== null ? ` · ${Math.round(latencyMs)} ms` : ""}` : "Needs attention"}</strong>
                </div>
              </div>
            </div>
          </section>

          {engineError && (
            <div className="engine-alert" role="alert">
              <span><strong>Voice engine:</strong> {engineError}</span>
              <button onClick={() => void refreshEngine()} disabled={isBusy}><RefreshCw size={15} /> Retry</button>
            </div>
          )}

          {cloudMessage && (
            <div className="cloud-alert" role="status">
              <span><strong>Cloud account:</strong> {cloudMessage}</span>
              <button onClick={() => setCloudMessage("")} aria-label="Dismiss cloud message"><X size={15} /></button>
            </div>
          )}

          <section className="section-block voice-section" ref={voiceSectionRef}>
            <div className="section-heading-row">
              <div>
                <p className="section-kicker">Your collection</p>
                <h2>Choose a voice</h2>
              </div>
              <div className="section-actions">
                <div className="segmented" role="tablist" aria-label="Voice filters">
                  <button role="tab" aria-selected={voiceTab === "my"} className={voiceTab === "my" ? "selected" : ""} onClick={() => setVoiceTab("my")}>My voices</button>
                  <button role="tab" aria-selected={voiceTab === "featured"} className={voiceTab === "featured" ? "selected" : ""} onClick={() => setVoiceTab("featured")}>Featured</button>
                </div>
                <label className="voice-search">
                  <Search size={16} />
                  <input aria-label="Search voices" placeholder="Name or gender" value={search} onChange={(event) => setSearch(event.target.value)} />
                </label>
                <button className="primary-button compact" disabled={engineMode !== "rvc" || !engineReady || isBusy || Boolean(rvcUploadProgress)} title={engineMode !== "rvc" ? "Switch to RVC to add an RVC voice" : !engineReady ? "Wait for the RVC engine to become ready" : isBusy ? "Wait for the current engine operation to finish" : "Install an extracted RVC model"} onClick={openRvcUpload}><Upload size={16} /> Add voice</button>
              </div>
            </div>

            <div className="voice-groups">
              {voiceGroups.map((group) => (
                <section className={`voice-group voice-group-${group.gender}`} key={group.gender} aria-labelledby={`voice-group-${group.gender}`}>
                  <div className={`voice-group-heading gender-${group.gender}`}>
                    <span className="voice-group-dot" aria-hidden="true" />
                    <h3 id={`voice-group-${group.gender}`}>{group.label}</h3>
                    <div className="voice-group-tools">
                      <span className="voice-group-count">{group.voices.length} {group.voices.length === 1 ? "voice" : "voices"}</span>
                      <div className="voice-scroll-buttons" aria-label={`${group.label} navigation`}>
                        <button type="button" aria-controls={`voice-row-${group.gender}`} aria-label={`Scroll ${group.label} left`} disabled={voiceRowEdges[group.gender].atStart} onClick={() => scrollVoiceRow(group.gender, -1)}>
                          <ChevronLeft size={15} />
                        </button>
                        <button type="button" aria-controls={`voice-row-${group.gender}`} aria-label={`Scroll ${group.label} right`} disabled={voiceRowEdges[group.gender].atEnd} onClick={() => scrollVoiceRow(group.gender, 1)}>
                          <ChevronRight size={15} />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div
                    id={`voice-row-${group.gender}`}
                    className="voice-row"
                    ref={(node) => { voiceRowRefs.current[group.gender] = node; }}
                    role="region"
                    aria-label={`${group.label} carousel`}
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      scrollVoiceRow(group.gender, event.key === "ArrowLeft" ? -1 : 1);
                    }}
                  >
                    {group.voices.map((voice) => (
                      <button aria-pressed={selectedVoice?.id === voice.id} data-voice-id={voice.id} disabled={isBusy || isRunning} className={`voice-card ${selectedVoice?.id === voice.id ? "selected" : ""}`} key={voice.id} onClick={() => void selectVoice(voice)}>
                        <span className={`voice-art ${voice.color}`}>
                          <span>{voice.initials}</span>
                          <Waves size={20} />
                          {voice.tag && <small>{voice.tag}</small>}
                        </span>
                        <span className="voice-meta">
                          <span className="voice-name-row">
                            <strong>{voice.name}</strong>
                            <span className={`voice-gender-badge gender-${voice.gender}`}>{voiceGenderLabel(voice.gender)}</span>
                          </span>
                          <small>{voice.type}</small>
                        </span>
                        <span className="voice-select-state">{selectedVoice?.id === voice.id ? <Check size={15} /> : <Play size={14} />}</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {!shownVoices.length && (
                <div className="voice-grid empty-voices-grid">
                  <div className="empty-voices">
                    <Waves size={23} />
                    <strong>{isBusy ? "Loading voice models..." : "No loaded voice models found"}</strong>
                    <span>{search ? "Try a different name or gender." : gatewayStatus?.ready ? "Load a compatible model in the selected engine." : "Wait for the local voice engine to become ready."}</span>
                  </div>
                </div>
              )}
            </div>
          </section>

          <div className="workspace-grid">
            <section className={`studio-card ${isRunning ? "is-live" : ""}`}>
              <div className="card-heading">
                <div>
                  <span className="section-kicker">Live conversion</span>
                  <h2>Voice studio</h2>
                </div>
                <span className={`status-pill ${isRunning ? "live" : ""}`}><span /> {isBusy ? "Working" : isRunning ? "Live" : engineReady ? "Ready" : "Offline"}</span>
              </div>

              <div className="studio-main">
                <div className={`selected-avatar ${selectedVoice?.color || "voice-red"}`}>
                  <span>{selectedVoice?.initials || "MV"}</span>
                  <div className="avatar-rings" />
                </div>
                <div className="selected-details">
                  <small>Selected voice</small>
                  <h3>{selectedVoice?.name || "Choose a voice"}</h3>
                  <p>{selectedVoice ? `${selectedVoice.type} · ${(sampleRate / 1000).toFixed(sampleRate % 1000 ? 1 : 0)} kHz` : "No model selected"}</p>
                </div>
                <div className={`wave-visual ${isRunning ? "playing" : ""}`} aria-label={isRunning ? "Audio input detected" : "Audio input idle"}>
                  {Array.from({ length: 34 }).map((_, index) => <i key={index} style={{ "--bar": `${16 + ((index * 17) % 48)}px`, "--delay": `${(index % 9) * -0.08}s` } as React.CSSProperties} />)}
                </div>
              </div>

              <div className="session-meta">
                <div><Clock3 size={16} /><span><small>Session time</small><strong>{formatTime(seconds)}</strong></span></div>
                <div><Zap size={16} /><span><small>Runtime</small><strong>{engineMode === "rvc" ? "RVC · CPU" : "Beatrice V2"}</strong></span></div>
                <div><Gauge size={16} /><span><small>Processing</small><strong>{latencyMs !== null ? `${Math.round(latencyMs)} ms` : "Measuring"}</strong></span></div>
              </div>

              <div className="session-controls">
                <button className="reset-button" onClick={() => { setSeconds(0); setToast("Session timer reset."); }} aria-label="Reset session"><RotateCcw size={18} /></button>
                <button disabled={isBusy || !engineReady || (!isRunning && !selectedVoice)} className={`start-button ${isRunning ? "stop" : ""}`} onClick={() => void toggleSession()}>
                  <span>{isRunning ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</span>
                  <span><small>{isBusy ? "Applying engine settings" : isRunning ? "Conversion active" : engineReady ? "Everything is ready" : "Engine unavailable"}</small><strong>{isRunning ? "Stop voice changer" : "Start voice changer"}</strong></span>
                </button>
                <button className="monitor-button" onClick={() => setToast("Choose your listening route under Output device.")}><Headphones size={18} /><span>Output</span></button>
              </div>
            </section>

            <section className="control-card">
              <div className="card-heading">
                <div><span className="section-kicker">Sound shaping</span><h2>Voice controls</h2></div>
                <button className="icon-button" aria-label="Reset voice controls" onClick={() => { setInputGain(100); setOutputGain(100); setPitch(0); setIndexRate(0); void commitSetting({ inputGain: 1, outputGain: 1, pitch: 0, indexRatio: 0 }, "Voice controls reset."); }}><RotateCcw size={17} /></button>
              </div>
              <div className="control-list">
                <RangeControl icon={<Mic2 size={16} />} label="Input gain" value={inputGain} setValue={setInputGain} unit="%" onCommit={(value) => void commitSetting({ inputGain: value / 100 })} disabled={!engineReady} />
                <RangeControl icon={<Volume2 size={16} />} label="Output gain" value={outputGain} setValue={setOutputGain} unit="%" onCommit={(value) => void commitSetting({ outputGain: value / 100 })} disabled={!engineReady} />
                <RangeControl icon={<AudioLines size={16} />} label="Pitch / tune" value={pitch} setValue={setPitch} min={-12} max={12} displayValue={`${pitch > 0 ? "+" : ""}${pitch} st`} onCommit={(value) => void commitSetting({ pitch: value })} disabled={!engineReady || isRunning} />
                <RangeControl icon={<SlidersHorizontal size={16} />} label="Index rate" value={indexRate} setValue={setIndexRate} unit="%" onCommit={(value) => void commitSetting({ indexRatio: value / 100 })} disabled={!engineReady || engineMode === "beatrice"} />
              </div>
              <button className="save-preset" disabled={!engineReady || isBusy} onClick={() => void saveSettings()}><Save size={17} /> Save engine settings</button>
            </section>
          </div>

          <section className="settings-card" ref={settingsSectionRef}>
            <div className="card-heading settings-heading">
              <div><span className="section-kicker">Hardware</span><h2>Audio & engine settings</h2></div>
              <span className="local-badge"><ShieldCheck size={15} /> Processed locally</span>
            </div>
            <div className="settings-grid">
              <SelectField icon={<Mic2 size={17} />} label="Input device" value={String(inputDevice)} options={inputOptions} emptyLabel="No microphone detected" disabled={!engineReady || isRunning} onChange={(value) => { const next = Number(value); setInputDevice(next); void commitSetting({ inputDevice: next }); }} />
              <SelectField icon={<MonitorSpeaker size={17} />} label="Output device" value={String(outputDevice)} options={outputOptions} emptyLabel="No output detected" disabled={!engineReady || isRunning} onChange={(value) => { const next = Number(value); setOutputDevice(next); void commitSetting({ outputDevice: next }); }} />
              <SelectField icon={<AudioLines size={17} />} label="Audio mode" value="server" options={[{ value: "server", label: "Server audio · Required" }]} disabled />
              <SelectField icon={<Gauge size={17} />} label="Sample rate" value={String(sampleRate)} options={[{ value: "48000", label: "48,000 Hz" }, { value: "44100", label: "44,100 Hz" }]} disabled={!engineReady || isRunning} onChange={(value) => { const next = Number(value); setSampleRate(next); void commitSetting({ sampleRate: next }); }} />
              <SelectField icon={<Cpu size={17} />} label="Processor" value="cpu" options={[{ value: "cpu", label: "CPU · Recommended" }]} disabled />
              <SelectField icon={<Zap size={17} />} label="Response mode" value={String(chunkSize)} options={chunkOptions} disabled={!engineReady || isRunning} onChange={(value) => { const next = Number(value); setChunkSize(next); void commitSetting({ chunkSize: next }); }} />
            </div>
            <button className={`advanced-toggle ${advancedOpen ? "open" : ""}`} onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
              <span><Settings2 size={17} /><strong>Advanced engine settings</strong><small>Pitch detection and conversion buffer</small></span>
              <ChevronDown size={19} />
            </button>
            {advancedOpen && (
              <div className="advanced-panel">
                <SelectField label="F0 detector" value={f0Detector} options={engineMode === "rvc" ? [{ value: "pm", label: "PM · CPU efficient" }, { value: "dio", label: "DIO" }, { value: "harvest", label: "Harvest" }, { value: "rmvpe_onnx", label: "RMVPE ONNX" }] : [{ value: "beatrice", label: "Beatrice neural pitch" }]} disabled={!engineReady || engineMode === "beatrice" || isRunning} onChange={(value) => { setF0Detector(value); void commitSetting({ f0Detector: value }); }} />
                <SelectField label="Chunk / response" value={String(chunkSize)} options={chunkOptions} disabled={!engineReady || isRunning} onChange={(value) => { const next = Number(value); setChunkSize(next); void commitSetting({ chunkSize: next }); }} />
                <SelectField label="Active model slot" value={selectedVoice ? String(selectedVoice.slot) : "none"} options={selectedVoice ? [{ value: String(selectedVoice.slot), label: `Slot ${selectedVoice.slot} · ${selectedVoice.modelName}` }] : [{ value: "none", label: "No model selected" }]} disabled />
                <label className="field noise-field"><span>Local processing</span><button className="toggle-switch enabled" disabled aria-label="Local processing enabled"><span /></button></label>
              </div>
            )}
          </section>

          <footer className="dashboard-footer">
            <span><span className="pulse-dot" /> {engineLabel} · {gatewayStatus?.ready ? "Connected" : "Offline"}</span>
            <span>Need help? <button onClick={() => setGuideOpen(true)}>Setup guide</button><button onClick={() => setSupportOpen(true)}>Customer care</button></span>
          </footer>
        </div>
      </main>

      {openPanel === "models" && (
        <Modal title="My installed models" icon={<Mic2 size={20} />} onClose={() => setOpenPanel(null)}>
          <p className="modal-intro">Models reported by the active {engineMode === "rvc" ? "RVC" : "Beatrice V2"} engine. Switch engines to see the other collection.</p>
          <div className="panel-list model-panel-list">
            {installedModels.map((model) => {
              const active = selectedVoice?.slot === model.slot && selectedVoice.modelName === model.modelName;
              return (
                <article className={`model-panel-item ${active ? "active" : ""}`} key={model.key}>
                  <span className="model-panel-icon"><AudioLines size={18} /></span>
                  <div className="model-panel-copy">
                    <span><strong>{model.modelName}</strong>{active && <small>Active</small>}</span>
                    <p>Slot {model.slot} · {model.runtimeLabel}</p>
                    <div className="model-panel-stats">
                      <span>{model.voiceCount} {model.voiceCount === 1 ? "voice" : "voices"}</span>
                      {model.maleCount > 0 && <span>{model.maleCount} male</span>}
                      {model.femaleCount > 0 && <span>{model.femaleCount} female</span>}
                      {model.otherCount > 0 && <span>{model.otherCount} custom</span>}
                    </div>
                  </div>
                  <button className="panel-row-action" onClick={() => showModelVoices(model)}>View voices <ChevronRight size={15} /></button>
                </article>
              );
            })}
            {!installedModels.length && (
              <div className="panel-empty"><Mic2 size={22} /><strong>No models available</strong><span>Wait for the selected engine to finish starting.</span></div>
            )}
          </div>
        </Modal>
      )}

      {openPanel === "history" && (
        <Modal title="Session history" icon={<History size={20} />} onClose={() => setOpenPanel(null)}>
          <div className="history-summary">
            <span><small>Completed sessions</small><strong>{sessionHistory.length}</strong></span>
            <span><small>Total conversion time</small><strong>{formatTime(totalSessionSeconds)}</strong></span>
          </div>
          <div className="panel-list history-panel-list">
            {sessionHistory.map((session) => (
              <article className="history-panel-item" key={session.id}>
                <span className="history-engine-icon"><Waves size={17} /></span>
                <div>
                  <strong>{session.voiceName}</strong>
                  <p>{session.engineMode === "rvc" ? "RVC" : "Beatrice V2"} · {session.modelName}</p>
                  <small>{new Date(session.endedAt).toLocaleString()} · {formatTime(session.durationSeconds)}</small>
                </div>
                <span className="history-rate">{Math.round(session.sampleRate / 1000)} kHz</span>
              </article>
            ))}
            {!sessionHistory.length && (
              <div className="panel-empty"><History size={22} /><strong>No completed sessions yet</strong><span>Start and stop the voice changer to save a session here.</span></div>
            )}
          </div>
          {sessionHistory.length > 0 && (
            <button className="clear-history-button" disabled={historyBusy} onClick={() => void clearHistory()}><Trash2 size={16} /> {historyBusy ? "Clearing..." : "Clear my history"}</button>
          )}
          <p className="demo-note">Only this signed-in account can access these session details. Morphly does not save your audio.</p>
        </Modal>
      )}

      {openPanel === "account" && (
        <Modal title="Morphly account" icon={<UserRound size={20} />} onClose={() => setOpenPanel(null)}>
          <div className="account-profile-preview">
            <span>{voiceInitials(profileDraft)}</span>
            <div>
              <strong>{profileDraft.trim() || "Morphly creator"}</strong>
              <small>{session.email}</small>
            </div>
          </div>
          <div className="account-form cloud-account-details">
            <div className="account-detail-row"><span>Email</span><strong>{session.email}</strong></div>
            <div className="account-detail-row"><span>Access</span><strong>{session.role === "admin" ? "Administrator" : "Voice workspace"}</strong></div>
            <div className="account-detail-row"><span>Status</span><strong>{session.status}</strong></div>
            <div className="account-detail-row"><span>Credits</span><strong>{credits.toLocaleString()}</strong></div>
            <button className="secondary-button modal-action" type="button" onClick={() => void signOut()}><LogOut size={16} /> Sign out</button>
          </div>
        </Modal>
      )}

      {notificationsOpen && (
        <Modal title="Notifications" icon={<Bell size={20} />} onClose={() => setNotificationsOpen(false)}>
          <p className="modal-intro">Product updates and service notices published by the Morphly team.</p>
          <button className="secondary-button notification-enable-button" type="button" disabled={pushBusy || pushEnabled} onClick={() => void enableDesktopNotifications()}>
            <Bell size={16} /> {pushEnabled ? "Push notifications enabled" : pushBusy ? "Enabling notifications..." : "Enable desktop & push alerts"}
          </button>
          <div className="notification-panel-list">
            {notifications.map((notification) => (
              <article className={`notification-panel-item notification-${notification.kind} ${notification.isRead ? "" : "unread"}`} key={notification.id}>
                <span><Bell size={17} /></span>
                <div>
                  <div><strong>{notification.title}</strong><small>{notification.kind}</small></div>
                  <p>{notification.message}</p>
                  <time>{new Date(notification.createdAt).toLocaleString()}</time>
                  {notification.actionUrl && (
                    <a href={notification.actionUrl} target="_blank" rel="noreferrer">
                      {notification.actionLabel || "Open details"} <ExternalLink size={13} />
                    </a>
                  )}
                </div>
              </article>
            ))}
            {!notifications.length && (
              <div className="panel-empty"><Bell size={22} /><strong>No new notifications</strong><span>You are all caught up.</span></div>
            )}
          </div>
        </Modal>
      )}

      {supportOpen && (
        <Modal title="Morphly customer care" icon={<LifeBuoy size={20} />} onClose={() => setSupportOpen(false)}>
          <p className="modal-intro">Contact the support team using any channel configured by your Morphly administrator.</p>
          <div className="support-contact-list">
            {supportConfig.email && <a href={`mailto:${supportConfig.email}`}><Mail size={18} /><span><small>Email</small><strong>{supportConfig.email}</strong></span><ExternalLink size={14} /></a>}
            {supportConfig.phone && <a href={`tel:${supportConfig.phone}`}><Phone size={18} /><span><small>Phone</small><strong>{supportConfig.phone}</strong></span><ExternalLink size={14} /></a>}
            {supportConfig.whatsapp && <a href={`https://wa.me/${supportConfig.whatsapp.replace(/\D/g, "")}`} target="_blank" rel="noreferrer"><MessageCircle size={18} /><span><small>WhatsApp</small><strong>{supportConfig.whatsapp}</strong></span><ExternalLink size={14} /></a>}
            {supportConfig.helpCenterUrl && <a href={supportConfig.helpCenterUrl} target="_blank" rel="noreferrer"><LifeBuoy size={18} /><span><small>Help center</small><strong>{supportConfig.helpCenterUrl}</strong></span><ExternalLink size={14} /></a>}
            {supportConfig.website && <a href={supportConfig.website} target="_blank" rel="noreferrer"><ExternalLink size={18} /><span><small>Website</small><strong>{supportConfig.website}</strong></span><ExternalLink size={14} /></a>}
            {!supportConfig.email && !supportConfig.phone && !supportConfig.whatsapp && !supportConfig.helpCenterUrl && !supportConfig.website && (
              <div className="panel-empty"><LifeBuoy size={22} /><strong>Customer care is not configured yet</strong><span>An administrator can publish contact details from the Admin Console.</span></div>
            )}
          </div>
          {supportConfig.workingHours && <p className="support-hours"><Clock3 size={15} /><span><strong>Support hours</strong>{supportConfig.workingHours}</span></p>}
        </Modal>
      )}

      {guideOpen && (
        <Modal title="Set up Morphly Voice" icon={<CircleHelp size={20} />} onClose={() => setGuideOpen(false)}>
          <ol className="guide-steps">
            <li><span>1</span><div><strong>Select your microphone</strong><p>Choose the device you speak into under Audio & engine settings.</p></div></li>
            <li><span>2</span><div><strong>Choose the engine and voice</strong><p>Switch between RVC and Beatrice V2, then pick one of the models reported by that engine.</p></div></li>
            <li><span>3</span><div><strong>Choose where the voice goes</strong><p>Select Speakers to hear the converted voice locally. Select CABLE Input to send it to another application; cable output is not audible by itself.</p></div></li>
            <li><span>4</span><div><strong>Set your app input</strong><p>When using VB-Cable, choose CABLE Output as the microphone in Discord, OBS, Zoom or your game.</p></div></li>
            <li><span>5</span><div><strong>Start conversion</strong><p>Press Start voice changer, speak normally, then fine-tune pitch and gain. Use headphones when listening through Speakers to prevent feedback.</p></div></li>
          </ol>
          <section className="guide-rvc-models">
            <div className="guide-rvc-heading"><Upload size={18} /><div><strong>Add your own RVC voice</strong><span>Use a compatible RVC model that you have permission to use.</span></div></div>
            <ol>
              <li>Visit <a href="https://voice-models.com/" target="_blank" rel="noreferrer">voice-models.com <ExternalLink size={12} /></a> and download an RVC voice model.</li>
              <li>Extract the downloaded ZIP file. Do not upload the ZIP itself.</li>
              <li>In Morphly, switch to the <strong>RVC engine</strong> and stop any active conversion.</li>
              <li>Select <strong>Add voice</strong>, choose the extracted <code>.pth</code> or <code>.onnx</code> model, then optionally choose its <code>.index</code> or <code>.bin</code> file.</li>
              <li>Select <strong>Upload & install voice</strong>. When it finishes, the model appears under My voices.</li>
            </ol>
          </section>
          <button className="primary-button modal-action" onClick={() => setGuideOpen(false)}>Got it, continue</button>
        </Modal>
      )}

      {rvcUploadOpen && (
        <Modal title="Add an RVC voice" icon={<Upload size={20} />} onClose={closeRvcUpload}>
          <p className="modal-intro">Download an RVC model, extract its ZIP file, then select the model file below. The index file improves similarity when the model includes one.</p>
          <a className="model-source-link" href="https://voice-models.com/" target="_blank" rel="noreferrer"><Library size={17} /><span><small>Browse third-party RVC models</small><strong>voice-models.com</strong></span><ExternalLink size={14} /></a>
          <div className="rvc-upload-fields">
            <label>
              <span>RVC model file <b>Required</b></span>
              <input type="file" accept=".pth,.onnx" disabled={Boolean(rvcUploadProgress)} onChange={(event) => { setRvcModelFile(event.target.files?.[0] || null); setRvcUploadError(""); }} />
              <small>{rvcModelFile ? `${rvcModelFile.name} · ${(rvcModelFile.size / (1024 * 1024)).toFixed(1)} MB` : "Choose one extracted .pth or .onnx file."}</small>
            </label>
            <label>
              <span>Feature index <em>Optional</em></span>
              <input type="file" accept=".index,.bin" disabled={Boolean(rvcUploadProgress)} onChange={(event) => { setRvcIndexFile(event.target.files?.[0] || null); setRvcUploadError(""); }} />
              <small>{rvcIndexFile ? `${rvcIndexFile.name} · ${(rvcIndexFile.size / (1024 * 1024)).toFixed(1)} MB` : "Choose the matching .index or .bin file when supplied."}</small>
            </label>
          </div>
          {rvcUploadProgress && (
            <div className="rvc-upload-progress" role="status">
              <div><span>{rvcUploadProgress.phase === "uploading" ? "Uploading model files" : "Installing voice model"}</span><strong>{rvcUploadProgress.percent}%</strong></div>
              <i><b style={{ width: `${rvcUploadProgress.percent}%` }} /></i>
              <small>{rvcUploadProgress.phase === "uploading" ? "Keep Morphly open until every file reaches the local engine." : "The RVC engine is validating the model. This can take longer on CPU."}</small>
            </div>
          )}
          {rvcUploadError && <div className="credit-catalog-error" role="alert">{rvcUploadError}</div>}
          <div className="rvc-upload-actions">
            <button className="secondary-button" type="button" disabled={Boolean(rvcUploadProgress)} onClick={closeRvcUpload}>Cancel</button>
            <button className="primary-button" type="button" disabled={!rvcModelFile || Boolean(rvcUploadProgress)} onClick={() => void installRvcVoice()}>{rvcUploadProgress ? rvcUploadProgress.phase === "uploading" ? `Uploading ${rvcUploadProgress.percent}%` : "Installing..." : "Upload & install voice"}</button>
          </div>
          <p className="model-rights-note">Only install voices you are authorized to use. Morphly does not own or verify third-party model rights.</p>
        </Modal>
      )}

      {creditsOpen && (
        <Modal title="Add Morphly credits" icon={<Coins size={20} />} onClose={() => setCreditsOpen(false)}>
          <p className="modal-intro">Live conversion costs <strong>2 credits per 10-second connection block</strong>. The first block is reserved when the engine starts. Your current balance is <strong>{credits.toLocaleString()} credits</strong>.</p>
          <div className="credit-catalog-toolbar">
            <span>{billingLoading ? "Refreshing packages..." : billingConfig ? `${availableCreditPlans.length} package${availableCreditPlans.length === 1 ? "" : "s"} in ${billingConfig.currency}` : "Package catalog unavailable"}</span>
            <button type="button" disabled={billingLoading} onClick={() => void refreshBillingPackages().catch(() => undefined)}><RefreshCw className={billingLoading ? "catalog-spin" : ""} size={14} /> Refresh</button>
          </div>
          {billingError && <div className="credit-catalog-error" role="alert">{billingError}</div>}
          <div className="plan-grid">
            {availableCreditPlans.map((plan) => (
              <button className={`plan-card ${plan.bestValue ? "best" : ""} ${selectedPlanId === plan.id ? "selected" : ""}`} disabled={Boolean(paymentBusy)} key={plan.id} onClick={() => setSelectedPlanId(plan.id)}>
                {plan.bestValue && <small>Best value</small>}
                <em>{plan.label}</em>
                <strong>{plan.credits.toLocaleString()}</strong><span>credits</span>
                <b>{formatCreditPackagePrice(plan.amount, plan.currency)}</b>
              </button>
            ))}
          </div>
          {!availableCreditPlans.length && !billingLoading && <div className="panel-empty"><Coins size={22} /><strong>Credit packages unavailable</strong><span>Ask an administrator to publish at least one enabled package.</span></div>}
          {!availableCreditPlans.length && billingLoading && <div className="panel-empty"><RefreshCw className="catalog-spin" size={22} /><strong>Loading credit packages</strong><span>Synchronizing the current prices from Morphly billing.</span></div>}
          <button className="primary-button modal-action" type="button" disabled={!selectedPlanId || Boolean(paymentBusy) || billingLoading || Boolean(billingError)} onClick={() => void beginCheckout(selectedPlanId)}>
            {paymentBusy ? "Opening secure payment..." : "Proceed to payment"}
          </button>
          <p className="demo-note">Flutterwave opens in a secure inline payment window. Credits are added only after server verification.</p>
        </Modal>
      )}

      {toast && <div className="toast-message" role="status"><Check size={17} /> {toast}</div>}
    </div>
  );
}

export default function Home() {
  return (
    <AuthGate>
      <RoleRoutedApplication />
    </AuthGate>
  );
}

function RoleRoutedApplication() {
  const auth = usePlatformAuth();
  if (!auth.session || !auth.token) return null;
  if (auth.session.role === "admin") {
    return <AdminDashboard session={auth.session} token={auth.token} onSignOut={auth.signOut} />;
  }
  return (
    <VoiceWorkspace
      session={auth.session}
      token={auth.token}
      onSignOut={auth.signOut}
      onRefreshSession={auth.refreshSession}
    />
  );
}

function RangeControl({ icon, label, value, setValue, unit, displayValue, min = 0, max = 100, step = 1, disabled = false, onCommit }: { icon: React.ReactNode; label: string; value: number; setValue: (value: number) => void; unit?: string; displayValue?: string; min?: number; max?: number; step?: number; disabled?: boolean; onCommit?: (value: number) => void }) {
  const progress = ((value - min) / Math.max(1, max - min)) * 100;
  return (
    <label className={`range-row ${disabled ? "disabled" : ""}`}>
      <span className="range-label"><i>{icon}</i>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => setValue(Number(event.target.value))} onPointerUp={(event) => onCommit?.(Number(event.currentTarget.value))} onKeyUp={(event) => onCommit?.(Number(event.currentTarget.value))} onBlur={(event) => onCommit?.(Number(event.currentTarget.value))} style={{ "--range-progress": `${progress}%` } as React.CSSProperties} />
      <output>{displayValue ?? `${value}${unit ?? ""}`}</output>
    </label>
  );
}

type SelectOption = string | { value: string; label: string };

function SelectField({ icon, label, value, options, onChange, disabled = false, emptyLabel = "No options available" }: { icon?: React.ReactNode; label: string; value: string; options: SelectOption[]; onChange?: (value: string) => void; disabled?: boolean; emptyLabel?: string }) {
  return (
    <label className={`field ${disabled ? "disabled" : ""}`}>
      <span>{icon && <i>{icon}</i>}{label}</span>
      <span className="select-wrap">
        <select value={options.length ? value : ""} aria-label={label} disabled={disabled || !options.length} onChange={(event) => onChange?.(event.target.value)}>
          {!options.length && <option value="">{emptyLabel}</option>}
          {options.map((option) => {
            const normalized = typeof option === "string" ? { value: option, label: option } : option;
            return <option key={normalized.value} value={normalized.value}>{normalized.label}</option>;
          })}
        </select>
        <ChevronDown size={16} />
      </span>
    </label>
  );
}

function Modal({ title, icon, onClose, children }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header"><span>{icon}</span><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={19} /></button></div>
        {children}
      </section>
    </div>
  );
}

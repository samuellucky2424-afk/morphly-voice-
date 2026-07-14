"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  checkForUpdaterUpdate,
  getUpdaterStatus,
  installUpdaterUpdate,
  startUpdaterDownload,
  type UpdaterStatus,
} from "./updater-api";

export type UpdaterAction = "checking" | "downloading" | "installing" | null;

export type AppUpdaterController = {
  status: UpdaterStatus;
  initialized: boolean;
  action: UpdaterAction;
  error: string;
  busy: boolean;
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
};

const initialStatus: UpdaterStatus = {
  ok: true,
  supported: false,
  phase: "idle",
  currentVersion: "Unknown",
  latestVersion: null,
  releaseName: null,
  releaseNotes: null,
  releaseUrl: null,
  downloadedBytes: 0,
  totalBytes: null,
  progressPercent: null,
  lastCheckedAt: null,
  error: null,
  updateAvailable: false,
  canInstall: false,
};

function readableError(error: unknown) {
  return error instanceof Error ? error.message : "The local updater could not complete that request.";
}

export function useAppUpdater(token: string | null): AppUpdaterController {
  const [status, setStatus] = useState<UpdaterStatus>(initialStatus);
  const [initialized, setInitialized] = useState(false);
  const [action, setAction] = useState<UpdaterAction>(null);
  const [clientError, setClientError] = useState("");
  const actionRef = useRef<UpdaterAction>(null);
  const pollingRef = useRef(false);
  const autoCheckStartedRef = useRef(false);
  const autoDownloadReleaseRef = useRef<string | null>(null);

  const applyStatus = useCallback((nextStatus: UpdaterStatus) => {
    setStatus(nextStatus);
    setInitialized(true);
    setClientError("");
  }, []);

  const beginAction = useCallback((nextAction: Exclude<UpdaterAction, null>) => {
    if (actionRef.current) return false;
    actionRef.current = nextAction;
    setAction(nextAction);
    setClientError("");
    return true;
  }, []);

  const finishAction = useCallback(() => {
    actionRef.current = null;
    setAction(null);
  }, []);

  const performCheck = useCallback(async (manual: boolean) => {
    if (!token || !beginAction("checking")) return;
    if (manual) autoDownloadReleaseRef.current = null;
    try {
      applyStatus(await checkForUpdaterUpdate(token));
    } catch (error) {
      setInitialized(true);
      setClientError(readableError(error));
    } finally {
      finishAction();
    }
  }, [applyStatus, beginAction, finishAction, token]);

  const performDownload = useCallback(async () => {
    if (!token || !beginAction("downloading")) return;
    try {
      applyStatus(await startUpdaterDownload(token));
    } catch (error) {
      setInitialized(true);
      setClientError(readableError(error));
    } finally {
      finishAction();
    }
  }, [applyStatus, beginAction, finishAction, token]);

  const checkForUpdates = useCallback(() => performCheck(true), [performCheck]);

  const installUpdate = useCallback(async () => {
    if (!token || !status.canInstall || !beginAction("installing")) return;
    try {
      applyStatus(await installUpdaterUpdate(token));
    } catch (error) {
      setInitialized(true);
      setClientError(readableError(error));
    } finally {
      finishAction();
    }
  }, [applyStatus, beginAction, finishAction, status.canInstall, token]);

  useEffect(() => {
    if (!token) {
      autoCheckStartedRef.current = false;
      autoDownloadReleaseRef.current = null;
      actionRef.current = null;
      return;
    }
    if (autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    void performCheck(false);
  }, [performCheck, token]);

  useEffect(() => {
    if (!token || !status.supported || !status.updateAvailable || status.canInstall) return;
    if (status.phase === "checking" || status.phase === "downloading" || status.phase === "ready" || status.phase === "installing") return;
    const releaseKey = status.latestVersion || status.releaseUrl || "available";
    if (autoDownloadReleaseRef.current === releaseKey) return;
    autoDownloadReleaseRef.current = releaseKey;
    void performDownload();
  }, [performDownload, status.canInstall, status.latestVersion, status.phase, status.releaseUrl, status.supported, status.updateAvailable, token]);

  useEffect(() => {
    if (!token || (status.phase !== "checking" && status.phase !== "downloading")) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled || pollingRef.current || actionRef.current) return;
      pollingRef.current = true;
      try {
        const nextStatus = await getUpdaterStatus(token);
        if (!cancelled) applyStatus(nextStatus);
      } catch (error) {
        if (!cancelled) setClientError(readableError(error));
      } finally {
        pollingRef.current = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyStatus, status.phase, token]);

  return useMemo(() => ({
    status,
    initialized,
    action,
    error: clientError || status.error || "",
    busy: action !== null || status.phase === "checking" || status.phase === "downloading" || status.phase === "installing",
    checkForUpdates,
    installUpdate,
  }), [action, checkForUpdates, clientError, initialized, installUpdate, status]);
}

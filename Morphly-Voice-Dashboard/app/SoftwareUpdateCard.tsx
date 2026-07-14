"use client";

import {
  CheckCircle2,
  Download,
  ExternalLink,
  HardDriveDownload,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import type { AppUpdaterController } from "./use-app-updater";

type SoftwareUpdateCardProps = {
  updater: AppUpdaterController;
  className?: string;
  installBlockedReason?: string | null;
};

function formatBytes(bytes: number | null) {
  if (bytes === null || !Number.isFinite(bytes)) return "Unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function checkedAtLabel(value: string | null) {
  if (!value) return "Not checked yet";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Checked recently";
  return `Last checked ${parsed.toLocaleString()}`;
}

function phaseCopy(updater: AppUpdaterController) {
  const { status, initialized, error } = updater;
  if (!initialized) return { title: "Connecting to the updater", detail: "Checking this installation for update support.", tone: "neutral" };
  if (error || status.phase === "error") return { title: "Update check needs attention", detail: error || "The updater could not complete the last request.", tone: "error" };
  if (!status.supported) return { title: "Windows updater unavailable", detail: "Automatic updates are available when Morphly Voice is opened from its installed Windows application.", tone: "neutral" };
  if (status.phase === "checking") return { title: "Checking for updates", detail: "Comparing this installation with the latest Morphly Voice GitHub release.", tone: "working" };
  if (status.phase === "available") return { title: "A new version is available", detail: "The installer download will begin automatically. Morphly will never install it without your permission.", tone: "available" };
  if (status.phase === "downloading") return { title: "Downloading the latest version", detail: "You can keep using the dashboard while the verified installer downloads.", tone: "working" };
  if (status.phase === "ready" || status.canInstall) return { title: "Update ready to install", detail: "Choose Install update when you are ready. Morphly Voice will close while the installer runs.", tone: "ready" };
  if (status.phase === "installing") return { title: "Starting the installer", detail: "Morphly Voice will close so Windows can finish the update safely.", tone: "working" };
  if (status.phase === "up_to_date") return { title: "Morphly Voice is up to date", detail: "You already have the newest published version.", tone: "success" };
  return { title: "Automatic GitHub updates", detail: "Check for the newest Morphly Voice release. New installers download automatically but wait for your approval before installation.", tone: "neutral" };
}

export default function SoftwareUpdateCard({ updater, className = "", installBlockedReason }: SoftwareUpdateCardProps) {
  const { status } = updater;
  const copy = phaseCopy(updater);
  const downloadInProgress = status.phase === "downloading";
  const progress = status.progressPercent === null ? null : Math.max(0, Math.min(100, status.progressPercent));
  const checkDisabled = updater.busy || (updater.initialized && !status.supported && !updater.error);
  const installDisabled = !status.canInstall || updater.busy || Boolean(installBlockedReason);

  return (
    <section className={`software-update-card ${className}`.trim()} aria-labelledby="software-update-title">
      <div className="software-update-heading">
        <span className="software-update-icon"><HardDriveDownload size={20} /></span>
        <div>
          <span className="section-kicker">Application</span>
          <h2 id="software-update-title">Software updates</h2>
        </div>
        <span className={`software-update-badge tone-${copy.tone}`}>
          {copy.tone === "error" ? <TriangleAlert size={13} /> : copy.tone === "success" || copy.tone === "ready" ? <CheckCircle2 size={13} /> : <ShieldCheck size={13} />}
          {status.currentVersion === "Unknown" ? "Version unavailable" : `Version ${status.currentVersion}`}
        </span>
      </div>

      <div className="software-update-body" aria-live="polite">
        <div className={`software-update-state tone-${copy.tone}`}>
          <span>{copy.tone === "working" ? <RefreshCw className="software-update-spin" size={18} /> : copy.tone === "error" ? <TriangleAlert size={18} /> : copy.tone === "ready" || copy.tone === "success" ? <CheckCircle2 size={18} /> : <Download size={18} />}</span>
          <div><strong>{copy.title}</strong><p>{copy.detail}</p></div>
        </div>

        {(status.latestVersion || status.releaseName) && (
          <div className="software-update-release">
            <div><small>Latest release</small><strong>{status.releaseName || `Morphly Voice ${status.latestVersion}`}</strong>{status.latestVersion && <span>Version {status.latestVersion}</span>}</div>
            {status.releaseUrl && <a href={status.releaseUrl} target="_blank" rel="noreferrer">View on GitHub <ExternalLink size={13} /></a>}
          </div>
        )}

        {downloadInProgress && (
          <div className="software-update-progress">
            <div><strong>Downloading installer</strong><span>{progress === null ? "Preparing..." : `${Math.round(progress)}%`}</span></div>
            {progress === null ? (
              <progress max={100} aria-label="Downloading Morphly Voice update" />
            ) : (
              <progress max={100} value={progress} aria-label={`Downloading Morphly Voice update: ${Math.round(progress)} percent`} />
            )}
            <small>{formatBytes(status.downloadedBytes)}{status.totalBytes !== null ? ` of ${formatBytes(status.totalBytes)}` : " downloaded"}</small>
          </div>
        )}

        {status.releaseNotes && (
          <details className="software-update-notes">
            <summary>What&apos;s new in this release</summary>
            <p>{status.releaseNotes}</p>
          </details>
        )}

        {installBlockedReason && status.canInstall && (
          <div className="software-update-blocked" role="status"><TriangleAlert size={15} /><span>{installBlockedReason}</span></div>
        )}
      </div>

      <div className="software-update-footer">
        <span>{checkedAtLabel(status.lastCheckedAt)}</span>
        <div>
          <button className="software-update-check" type="button" disabled={checkDisabled} onClick={() => void updater.checkForUpdates()}>
            <RefreshCw className={status.phase === "checking" ? "software-update-spin" : ""} size={15} />
            {status.phase === "checking" || updater.action === "checking" ? "Checking..." : "Check for updates"}
          </button>
          <button className="software-update-install" type="button" disabled={installDisabled} onClick={() => void updater.installUpdate()}>
            <Download size={15} />
            {status.phase === "installing" || updater.action === "installing" ? "Starting installer..." : "Install update"}
          </button>
        </div>
      </div>
      <p className="software-update-safety"><ShieldCheck size={13} /> Downloads come from the official Morphly Voice GitHub release and are verified before installation.</p>
    </section>
  );
}

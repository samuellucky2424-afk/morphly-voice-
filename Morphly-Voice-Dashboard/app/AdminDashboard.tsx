"use client";

import {
  Activity,
  AlertCircle,
  BarChart3,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Coins,
  CreditCard,
  Database,
  FileText,
  Gauge,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Minus,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Users,
  WalletCards,
  X,
  Zap,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  adjustUserCredits,
  createNotification,
  getAdminLiveSessions,
  getAdminLogs,
  getAdminNotifications,
  getAdminOverview,
  getAdminPurchases,
  getAdminUsers,
  getSupportConfig,
  setUserSuspension,
  updateSupportConfig,
} from "./cloud-api";
import type {
  AdminLiveSession,
  AdminLogEntry,
  AdminNotification,
  AdminOverview,
  AdminPurchase,
  AdminUser,
  CreateNotificationInput,
  CreditAdjustmentInput,
  NotificationAudience,
  NotificationKind,
  PlatformSession,
  SupportConfig,
  SuspensionInput,
  UpdateSupportConfigInput,
} from "./platform-types";
import "./admin.css";

type AdminDashboardProps = {
  session: PlatformSession;
  token: string;
  onSignOut: () => Promise<void> | void;
};

type AdminScreen =
  | "overview"
  | "users"
  | "live"
  | "analytics"
  | "purchases"
  | "notifications"
  | "support"
  | "logs"
  | "settings";

type AsyncState = { loading: boolean; error: string };
type UnknownRecord = Record<string, unknown>;

type CreditDialogState = {
  user: AdminUser;
  amount: string;
  reason: string;
  idempotencyKey: string;
  submitting: boolean;
  error: string;
};

type SuspensionDialogState = {
  user: AdminUser;
  suspended: boolean;
  reason: string;
  submitting: boolean;
  error: string;
};

type NotificationDraft = {
  title: string;
  message: string;
  kind: NotificationKind;
  audience: Exclude<NotificationAudience, "selected">;
  endsAt: string;
};

type SupportDraft = {
  email: string;
  phone: string;
  whatsapp: string;
  website: string;
  workingHours: string;
  helpCenterUrl: string;
};

const screenDetails: Record<AdminScreen, { label: string; eyebrow: string; description: string }> = {
  overview: { label: "Overview", eyebrow: "Command center", description: "Live product health, usage, and account performance." },
  users: { label: "Users", eyebrow: "Customer management", description: "Review accounts, balances, activity, and access status." },
  live: { label: "Live activity", eyebrow: "Operations", description: "Monitor active Morphly sessions without accessing user audio." },
  analytics: { label: "Analytics", eyebrow: "Product intelligence", description: "Understand adoption, engine usage, revenue, and performance." },
  purchases: { label: "Purchases", eyebrow: "Payments", description: "Inspect Flutterwave payments and credit fulfillment records." },
  notifications: { label: "Notifications", eyebrow: "Communications", description: "Publish product notices to the Morphly user dashboard." },
  support: { label: "Customer care", eyebrow: "Support", description: "Manage the contact information displayed to customers." },
  logs: { label: "Software logs", eyebrow: "Diagnostics", description: "Trace engine, client, API, authentication, and payment events." },
  settings: { label: "Settings", eyebrow: "Administration", description: "Review security, environment, and integration status." },
};

const navigationGroups: Array<{
  label: string;
  items: Array<{ id: AdminScreen; icon: typeof LayoutDashboard }>;
}> = [
  {
    label: "Workspace",
    items: [
      { id: "overview", icon: LayoutDashboard },
      { id: "users", icon: Users },
      { id: "live", icon: Radio },
      { id: "analytics", icon: BarChart3 },
      { id: "purchases", icon: CreditCard },
    ],
  },
  {
    label: "Operations",
    items: [
      { id: "notifications", icon: Bell },
      { id: "support", icon: LifeBuoy },
      { id: "logs", icon: FileText },
      { id: "settings", icon: Settings },
    ],
  },
];

const emptyAsyncState: AsyncState = { loading: false, error: "" };

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" ? value as UnknownRecord : {};
}

function firstValue(record: UnknownRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function readString(value: unknown, keys: string[], fallback = "") {
  const candidate = firstValue(asRecord(value), keys);
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  if (typeof candidate === "number") return String(candidate);
  return fallback;
}

function readNumber(value: unknown, keys: string[], fallback = 0) {
  const candidate = firstValue(asRecord(value), keys);
  if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  if (typeof candidate === "string") {
    const parsed = Number(candidate.replace(/[^0-9.-]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function readBoolean(value: unknown, keys: string[], fallback = false) {
  const candidate = firstValue(asRecord(value), keys);
  if (typeof candidate === "boolean") return candidate;
  if (candidate === "true" || candidate === 1) return true;
  if (candidate === "false" || candidate === 0) return false;
  return fallback;
}

function nestedRecord(value: unknown, keys: string[]) {
  return asRecord(firstValue(asRecord(value), keys));
}

function readableError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return "The admin API could not complete this request.";
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "MA";
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

function formatCurrency(value: number, currency = "NGN") {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "NGN",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency || "NGN"} ${formatNumber(value)}`;
  }
}

function formatDate(value: unknown, includeTime = true) {
  if (!value) return "Not available";
  const date = new Date(typeof value === "number" || typeof value === "string" ? value : String(value));
  if (Number.isNaN(date.getTime())) return "Not available";
  return includeTime
    ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusClass(status: string) {
  const normalized = status.toLowerCase();
  if (["active", "online", "live", "success", "successful", "completed", "published", "healthy"].includes(normalized)) return "admin-status-success";
  if (["failed", "error", "critical", "suspended", "blocked"].includes(normalized)) return "admin-status-danger";
  if (["pending", "warning", "processing", "scheduled"].includes(normalized)) return "admin-status-warning";
  return "admin-status-neutral";
}

function userName(user: AdminUser) {
  const profile = nestedRecord(user, ["profile"]);
  return readString(user, ["displayName", "name", "fullName"], readString(profile, ["displayName", "name", "fullName"], "Unnamed user"));
}

function userEmail(user: AdminUser) {
  return readString(user, ["email"], readString(nestedRecord(user, ["profile"]), ["email"], "No email"));
}

function userId(user: AdminUser) {
  return readString(user, ["id", "uid", "userId"]);
}

function userSuspended(user: AdminUser) {
  const status = readString(user, ["status", "accountStatus"]).toLowerCase();
  return readBoolean(user, ["suspended", "disabled"], status === "suspended" || status === "blocked");
}

function userCredits(user: AdminUser) {
  return readNumber(user, ["credits", "creditBalance", "balance"]);
}

function sessionIdentity(session: PlatformSession) {
  const record = asRecord(session);
  const profile = nestedRecord(record, ["user", "profile"]);
  const name = readString(record, ["displayName", "name", "fullName"], readString(profile, ["displayName", "name", "fullName"], "Morphly administrator"));
  const email = readString(record, ["email"], readString(profile, ["email"], "Authenticated admin"));
  return { name, email };
}

export default function AdminDashboard({ session, token, onSignOut }: AdminDashboardProps) {
  const [activeScreen, setActiveScreen] = useState<AdminScreen>("overview");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [states, setStates] = useState<Record<AdminScreen, AsyncState>>(() => ({
    overview: { ...emptyAsyncState },
    users: { ...emptyAsyncState },
    live: { ...emptyAsyncState },
    analytics: { ...emptyAsyncState },
    purchases: { ...emptyAsyncState },
    notifications: { ...emptyAsyncState },
    support: { ...emptyAsyncState },
    logs: { ...emptyAsyncState },
    settings: { ...emptyAsyncState },
  }));
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [liveSessions, setLiveSessions] = useState<AdminLiveSession[]>([]);
  const [purchases, setPurchases] = useState<AdminPurchase[]>([]);
  const [logs, setLogs] = useState<AdminLogEntry[]>([]);
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [supportConfig, setSupportConfig] = useState<SupportConfig | null>(null);
  const [userSearch, setUserSearch] = useState("");
  const [userStatusFilter, setUserStatusFilter] = useState("all");
  const [purchaseSearch, setPurchaseSearch] = useState("");
  const [purchaseStatusFilter, setPurchaseStatusFilter] = useState("all");
  const [liveSearch, setLiveSearch] = useState("");
  const [liveEngineFilter, setLiveEngineFilter] = useState("all");
  const [logSearch, setLogSearch] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState("all");
  const [creditDialog, setCreditDialog] = useState<CreditDialogState | null>(null);
  const [suspensionDialog, setSuspensionDialog] = useState<SuspensionDialogState | null>(null);
  const [notificationDraft, setNotificationDraft] = useState<NotificationDraft>({
    title: "",
    message: "",
    kind: "info",
    audience: "all",
    endsAt: "",
  });
  const [notificationSubmitting, setNotificationSubmitting] = useState(false);
  const [notificationError, setNotificationError] = useState("");
  const [supportDraft, setSupportDraft] = useState<SupportDraft>({
    email: "",
    phone: "",
    whatsapp: "",
    website: "",
    workingHours: "",
    helpCenterUrl: "",
  });
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const [supportError, setSupportError] = useState("");
  const [toast, setToast] = useState("");
  const [signingOut, setSigningOut] = useState(false);

  const identity = useMemo(() => sessionIdentity(session), [session]);

  const setScreenState = useCallback((screen: AdminScreen, patch: Partial<AsyncState>) => {
    setStates((current) => ({ ...current, [screen]: { ...current[screen], ...patch } }));
  }, []);

  const loadScreen = useCallback(async (screen: AdminScreen) => {
    setScreenState(screen, { loading: true, error: "" });
    try {
      if (screen === "overview") {
        const [overviewResult, liveResult] = await Promise.all([
          getAdminOverview(token),
          getAdminLiveSessions(token),
        ]);
        setOverview(overviewResult);
        setLiveSessions(liveResult.items);
      } else if (screen === "users") {
        setUsers((await getAdminUsers(token)).items);
      } else if (screen === "live") {
        setLiveSessions((await getAdminLiveSessions(token)).items);
      } else if (screen === "analytics") {
        const [overviewResult, purchasesResult, liveResult] = await Promise.all([
          getAdminOverview(token),
          getAdminPurchases(token),
          getAdminLiveSessions(token),
        ]);
        setOverview(overviewResult);
        setPurchases(purchasesResult.items);
        setLiveSessions(liveResult.items);
      } else if (screen === "purchases") {
        setPurchases((await getAdminPurchases(token)).items);
      } else if (screen === "notifications") {
        setNotifications((await getAdminNotifications(token)).items);
      } else if (screen === "support") {
        const result = await getSupportConfig(token);
        setSupportConfig(result);
        setSupportDraft({
          email: readString(result, ["email", "supportEmail"]),
          phone: readString(result, ["phone", "supportPhone"]),
          whatsapp: readString(result, ["whatsapp", "whatsApp", "whatsappNumber"]),
          website: result.website,
          workingHours: result.workingHours,
          helpCenterUrl: result.helpCenterUrl,
        });
      } else if (screen === "logs") {
        setLogs((await getAdminLogs(token)).items);
      } else if (screen === "settings") {
        const [overviewResult, supportResult] = await Promise.all([
          getAdminOverview(token),
          getSupportConfig(token),
        ]);
        setOverview(overviewResult);
        setSupportConfig(supportResult);
      }
      setScreenState(screen, { loading: false, error: "" });
    } catch (error) {
      setScreenState(screen, { loading: false, error: readableError(error) });
    }
  }, [setScreenState, token]);

  useEffect(() => {
    void loadScreen(activeScreen);
  }, [activeScreen, loadScreen]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const navigate = (screen: AdminScreen) => {
    setActiveScreen(screen);
    setMobileMenuOpen(false);
  };

  const refreshUsersAndOverview = async () => {
    const [usersResult, overviewResult] = await Promise.all([
      getAdminUsers(token),
      getAdminOverview(token),
    ]);
    setUsers(usersResult.items);
    setOverview(overviewResult);
  };

  const submitCreditAdjustment = async (event: FormEvent) => {
    event.preventDefault();
    if (!creditDialog) return;
    const amount = Number(creditDialog.amount);
    if (!Number.isFinite(amount) || amount === 0) {
      setCreditDialog({ ...creditDialog, error: "Enter a non-zero credit amount." });
      return;
    }
    if (creditDialog.reason.trim().length < 4) {
      setCreditDialog({ ...creditDialog, error: "Add a clear reason for the audit record." });
      return;
    }
    const id = userId(creditDialog.user);
    if (!id) {
      setCreditDialog({ ...creditDialog, error: "This user record has no valid user ID." });
      return;
    }
    setCreditDialog({ ...creditDialog, submitting: true, error: "" });
    try {
      // Keep this key stable while the dialog remains open. If the server commits
      // the adjustment but the response is lost, retrying must not change the
      // user's balance a second time.
      const input = {
        amount,
        reason: creditDialog.reason.trim(),
        idempotencyKey: creditDialog.idempotencyKey,
      } as CreditAdjustmentInput;
      await adjustUserCredits(token, id, input);
      await refreshUsersAndOverview();
      setCreditDialog(null);
      setToast(`${amount > 0 ? "Added" : "Removed"} ${formatNumber(Math.abs(amount))} credits for ${userName(creditDialog.user)}.`);
    } catch (error) {
      setCreditDialog((current) => current ? { ...current, submitting: false, error: readableError(error) } : current);
    }
  };

  const submitSuspension = async (event: FormEvent) => {
    event.preventDefault();
    if (!suspensionDialog) return;
    if (suspensionDialog.reason.trim().length < 4) {
      setSuspensionDialog({ ...suspensionDialog, error: "Add a reason for this account action." });
      return;
    }
    const id = userId(suspensionDialog.user);
    if (!id) {
      setSuspensionDialog({ ...suspensionDialog, error: "This user record has no valid user ID." });
      return;
    }
    setSuspensionDialog({ ...suspensionDialog, submitting: true, error: "" });
    try {
      const input = { suspended: suspensionDialog.suspended, reason: suspensionDialog.reason.trim() } as SuspensionInput;
      await setUserSuspension(token, id, input);
      await refreshUsersAndOverview();
      setSuspensionDialog(null);
      setToast(`${userName(suspensionDialog.user)} was ${suspensionDialog.suspended ? "suspended" : "reactivated"}.`);
    } catch (error) {
      setSuspensionDialog((current) => current ? { ...current, submitting: false, error: readableError(error) } : current);
    }
  };

  const submitNotification = async (event: FormEvent) => {
    event.preventDefault();
    setNotificationError("");
    if (notificationDraft.title.trim().length < 3 || notificationDraft.message.trim().length < 5) {
      setNotificationError("Add a title and a useful notification message.");
      return;
    }
    setNotificationSubmitting(true);
    try {
      const input = {
        title: notificationDraft.title.trim(),
        message: notificationDraft.message.trim(),
        kind: notificationDraft.kind,
        audience: notificationDraft.audience,
        endsAt: notificationDraft.endsAt ? new Date(notificationDraft.endsAt).toISOString() : null,
      } as CreateNotificationInput;
      await createNotification(token, input);
      setNotifications((await getAdminNotifications(token)).items);
      setNotificationDraft({ title: "", message: "", kind: "info", audience: "all", endsAt: "" });
      setToast("Notification published to the selected audience.");
    } catch (error) {
      setNotificationError(readableError(error));
    } finally {
      setNotificationSubmitting(false);
    }
  };

  const submitSupportConfig = async (event: FormEvent) => {
    event.preventDefault();
    setSupportError("");
    if (!supportDraft.email.trim() && !supportDraft.phone.trim() && !supportDraft.whatsapp.trim()) {
      setSupportError("Provide at least one customer-care contact channel.");
      return;
    }
    setSupportSubmitting(true);
    try {
      const input = {
        email: supportDraft.email.trim(),
        phone: supportDraft.phone.trim(),
        whatsapp: supportDraft.whatsapp.trim(),
        website: supportDraft.website.trim(),
        workingHours: supportDraft.workingHours.trim(),
        helpCenterUrl: supportDraft.helpCenterUrl.trim(),
      } as UpdateSupportConfigInput;
      const updated = await updateSupportConfig(token, input);
      setSupportConfig(updated);
      setToast("Customer-care information updated for Morphly users.");
    } catch (error) {
      setSupportError(readableError(error));
    } finally {
      setSupportSubmitting(false);
    }
  };

  const filteredUsers = useMemo(() => {
    const query = userSearch.trim().toLowerCase();
    return users.filter((user) => {
      const status = readString(user, ["status", "accountStatus"], userSuspended(user) ? "suspended" : "active").toLowerCase();
      const statusMatches = userStatusFilter === "all" || status === userStatusFilter;
      const queryMatches = !query || `${userName(user)} ${userEmail(user)} ${userId(user)}`.toLowerCase().includes(query);
      return statusMatches && queryMatches;
    });
  }, [userSearch, userStatusFilter, users]);

  const filteredLiveSessions = useMemo(() => {
    const query = liveSearch.trim().toLowerCase();
    return liveSessions.filter((item) => {
      const engine = readString(item, ["engine", "engineMode", "voiceEngine"]).toLowerCase();
      const searchText = `${readString(item, ["userName", "displayName", "email"])} ${readString(item, ["userId", "uid"])} ${readString(item, ["model", "modelName", "voiceName"])} ${engine}`.toLowerCase();
      return (liveEngineFilter === "all" || engine.includes(liveEngineFilter)) && (!query || searchText.includes(query));
    });
  }, [liveEngineFilter, liveSearch, liveSessions]);

  const filteredPurchases = useMemo(() => {
    const query = purchaseSearch.trim().toLowerCase();
    return purchases.filter((purchase) => {
      const status = readString(purchase, ["status", "paymentStatus"], "unknown").toLowerCase();
      const searchText = `${readString(purchase, ["userName", "email", "userId"])} ${readString(purchase, ["reference", "transactionReference", "id"])} ${status}`.toLowerCase();
      return (purchaseStatusFilter === "all" || status === purchaseStatusFilter) && (!query || searchText.includes(query));
    });
  }, [purchaseSearch, purchaseStatusFilter, purchases]);

  const filteredLogs = useMemo(() => {
    const query = logSearch.trim().toLowerCase();
    return logs.filter((entry) => {
      const level = readString(entry, ["level", "severity"], "info").toLowerCase();
      const searchText = `${level} ${readString(entry, ["source", "category", "service"])} ${readString(entry, ["message", "event"])} ${readString(entry, ["userId", "requestId", "sessionId"])}`.toLowerCase();
      return (logLevelFilter === "all" || level === logLevelFilter) && (!query || searchText.includes(query));
    });
  }, [logLevelFilter, logSearch, logs]);

  const unreadNotifications = notifications.filter((item) => item.active).length;
  const details = screenDetails[activeScreen];
  const activeState = states[activeScreen];
  const activeHasData = hasScreenData(activeScreen, { overview, users, liveSessions, purchases, notifications, supportConfig, logs });

  const signOut = async () => {
    setSigningOut(true);
    try {
      await onSignOut();
    } catch (error) {
      setToast(readableError(error));
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="admin-shell">
      <aside className={`admin-sidebar ${mobileMenuOpen ? "admin-sidebar-open" : ""}`}>
        <div className="admin-brand-row">
          {/* The production Vite build serves this public brand asset directly. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/morphly-logo.png" alt="Morphly Voice" />
          <div><strong>Morphly Voice</strong><span>Administration</span></div>
          <button className="admin-icon-button admin-mobile-close" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}><X size={19} /></button>
        </div>

        <div className="admin-role-card">
          <span><ShieldCheck size={18} /></span>
          <div><small>Secure workspace</small><strong>Admin Console</strong></div>
        </div>

        <nav className="admin-navigation" aria-label="Admin navigation">
          {navigationGroups.map((group) => (
            <div className="admin-navigation-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    className={activeScreen === item.id ? "admin-nav-active" : ""}
                    aria-current={activeScreen === item.id ? "page" : undefined}
                    key={item.id}
                    onClick={() => navigate(item.id)}
                  >
                    <Icon size={18} />
                    <span>{screenDetails[item.id].label}</span>
                    {item.id === "notifications" && unreadNotifications > 0 && <b>{unreadNotifications}</b>}
                    {item.id === "live" && liveSessions.length > 0 && <i className="admin-live-dot" />}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="admin-sidebar-footer">
          <div className="admin-profile-card">
            <span>{initials(identity.name)}</span>
            <div><strong>{identity.name}</strong><small>{identity.email}</small></div>
          </div>
          <button className="admin-signout-button" type="button" disabled={signingOut} onClick={() => void signOut()}>
            <LogOut size={17} /> {signingOut ? "Signing out..." : "Sign out"}
          </button>
        </div>
      </aside>

      {mobileMenuOpen && <button className="admin-menu-scrim" type="button" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)} />}

      <main className="admin-main">
        <header className="admin-topbar">
          <button className="admin-icon-button admin-menu-button" type="button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}><Menu size={20} /></button>
          <div className="admin-page-title"><p>{details.eyebrow}</p><h1>{details.label}</h1></div>
          <div className="admin-topbar-actions">
            <span className="admin-secure-label"><ShieldCheck size={14} /> Verified admin</span>
            <button className="admin-refresh-button" type="button" disabled={activeState.loading} onClick={() => void loadScreen(activeScreen)}>
              <RefreshCw size={16} className={activeState.loading ? "admin-spin" : ""} />
              <span>Refresh</span>
            </button>
          </div>
        </header>

        <div className="admin-content">
          <section className="admin-page-intro">
            <div><span>{details.eyebrow}</span><h2>{details.label}</h2><p>{details.description}</p></div>
            <div className="admin-api-status"><i className={activeState.error ? "admin-api-error" : ""} /><span><small>Vercel API</small><strong>{activeState.error ? "Needs attention" : activeState.loading ? "Synchronizing" : "Connected"}</strong></span></div>
          </section>

          {activeState.error && (
            <AdminErrorState message={activeState.error} onRetry={() => void loadScreen(activeScreen)} />
          )}

          {!activeState.error && activeState.loading && !activeHasData && (
            <AdminLoadingState />
          )}

          {!activeState.error && (!activeState.loading || activeHasData) && (
            <>
              {activeScreen === "overview" && <OverviewScreen overview={overview} liveSessions={liveSessions} onNavigate={navigate} />}
              {activeScreen === "users" && (
                <UsersScreen
                  users={filteredUsers}
                  totalUsers={users.length}
                  search={userSearch}
                  statusFilter={userStatusFilter}
                  onSearch={setUserSearch}
                  onStatusFilter={setUserStatusFilter}
                  onAdjustCredits={(user) => setCreditDialog({
                    user,
                    amount: "",
                    reason: "",
                    idempotencyKey: crypto.randomUUID(),
                    submitting: false,
                    error: "",
                  })}
                  onChangeSuspension={(user) => setSuspensionDialog({ user, suspended: !userSuspended(user), reason: "", submitting: false, error: "" })}
                />
              )}
              {activeScreen === "live" && <LiveScreen sessions={filteredLiveSessions} total={liveSessions.length} search={liveSearch} engineFilter={liveEngineFilter} onSearch={setLiveSearch} onEngineFilter={setLiveEngineFilter} />}
              {activeScreen === "analytics" && <AnalyticsScreen overview={overview} purchases={purchases} liveSessions={liveSessions} />}
              {activeScreen === "purchases" && <PurchasesScreen purchases={filteredPurchases} total={purchases.length} search={purchaseSearch} statusFilter={purchaseStatusFilter} onSearch={setPurchaseSearch} onStatusFilter={setPurchaseStatusFilter} />}
              {activeScreen === "notifications" && <NotificationsScreen notifications={notifications} draft={notificationDraft} setDraft={setNotificationDraft} submitting={notificationSubmitting} error={notificationError} onSubmit={submitNotification} />}
              {activeScreen === "support" && <SupportScreen config={supportConfig} draft={supportDraft} setDraft={setSupportDraft} submitting={supportSubmitting} error={supportError} onSubmit={submitSupportConfig} />}
              {activeScreen === "logs" && <LogsScreen logs={filteredLogs} total={logs.length} search={logSearch} levelFilter={logLevelFilter} onSearch={setLogSearch} onLevelFilter={setLogLevelFilter} />}
              {activeScreen === "settings" && <SettingsScreen overview={overview} supportConfig={supportConfig} session={session} />}
            </>
          )}
        </div>
      </main>

      {creditDialog && (
        <AdminModal title="Adjust user credits" icon={<Coins size={19} />} onClose={() => !creditDialog.submitting && setCreditDialog(null)}>
          <form className="admin-modal-form" onSubmit={submitCreditAdjustment}>
            <AdminUserSummary user={creditDialog.user} />
            <div className="admin-balance-preview"><span>Current balance</span><strong>{formatNumber(userCredits(creditDialog.user))} credits</strong></div>
            <label className="admin-field"><span>Credit adjustment</span><div className="admin-number-field"><Minus size={15} /><input type="number" step="1" value={creditDialog.amount} placeholder="Use a negative amount to deduct" onChange={(event) => setCreditDialog({ ...creditDialog, amount: event.target.value, error: "" })} /><Plus size={15} /></div><small>Examples: 500 adds credits; -250 deducts credits.</small></label>
            <label className="admin-field"><span>Audit reason</span><textarea rows={3} value={creditDialog.reason} placeholder="Why is this balance being changed?" onChange={(event) => setCreditDialog({ ...creditDialog, reason: event.target.value, error: "" })} /></label>
            {creditDialog.error && <AdminFormError message={creditDialog.error} />}
            <div className="admin-modal-actions"><button className="admin-button-secondary" type="button" disabled={creditDialog.submitting} onClick={() => setCreditDialog(null)}>Cancel</button><button className="admin-button-primary" type="submit" disabled={creditDialog.submitting}>{creditDialog.submitting ? "Saving..." : "Confirm adjustment"}</button></div>
          </form>
        </AdminModal>
      )}

      {suspensionDialog && (
        <AdminModal title={suspensionDialog.suspended ? "Suspend user" : "Reactivate user"} icon={suspensionDialog.suspended ? <AlertCircle size={19} /> : <UserCheck size={19} />} onClose={() => !suspensionDialog.submitting && setSuspensionDialog(null)}>
          <form className="admin-modal-form" onSubmit={submitSuspension}>
            <AdminUserSummary user={suspensionDialog.user} />
            <div className={`admin-confirmation-note ${suspensionDialog.suspended ? "admin-confirmation-danger" : "admin-confirmation-success"}`}><AlertCircle size={18} /><p>{suspensionDialog.suspended ? "This user will lose access to protected Morphly services until an administrator reactivates the account." : "This user will regain access to Morphly services after the backend confirms the change."}</p></div>
            <label className="admin-field"><span>Audit reason</span><textarea rows={3} value={suspensionDialog.reason} placeholder="Explain this account action" onChange={(event) => setSuspensionDialog({ ...suspensionDialog, reason: event.target.value, error: "" })} /></label>
            {suspensionDialog.error && <AdminFormError message={suspensionDialog.error} />}
            <div className="admin-modal-actions"><button className="admin-button-secondary" type="button" disabled={suspensionDialog.submitting} onClick={() => setSuspensionDialog(null)}>Cancel</button><button className={suspensionDialog.suspended ? "admin-button-danger" : "admin-button-primary"} type="submit" disabled={suspensionDialog.submitting}>{suspensionDialog.submitting ? "Saving..." : suspensionDialog.suspended ? "Suspend account" : "Reactivate account"}</button></div>
          </form>
        </AdminModal>
      )}

      {toast && <div className="admin-toast" role="status"><CheckCircle2 size={17} /> {toast}</div>}
    </div>
  );
}

type ScreenData = {
  overview: AdminOverview | null;
  users: AdminUser[];
  liveSessions: AdminLiveSession[];
  purchases: AdminPurchase[];
  notifications: AdminNotification[];
  supportConfig: SupportConfig | null;
  logs: AdminLogEntry[];
};

function hasScreenData(screen: AdminScreen, data: ScreenData) {
  if (screen === "overview" || screen === "analytics" || screen === "settings") return Boolean(data.overview);
  if (screen === "users") return data.users.length > 0;
  if (screen === "live") return data.liveSessions.length > 0;
  if (screen === "purchases") return data.purchases.length > 0;
  if (screen === "notifications") return data.notifications.length > 0;
  if (screen === "support") return Boolean(data.supportConfig);
  return data.logs.length > 0;
}

function OverviewScreen({ overview, liveSessions, onNavigate }: { overview: AdminOverview | null; liveSessions: AdminLiveSession[]; onNavigate: (screen: AdminScreen) => void }) {
  if (!overview) return <AdminEmptyState icon={<LayoutDashboard size={25} />} title="No overview data returned" description="Confirm the Vercel admin overview endpoint is deployed and that this account has the Firebase admin claim." />;
  const totalUsers = overview.metrics.totalUsers;
  const activeUsers = overview.metrics.activeUsers;
  const suspendedUsers = overview.metrics.suspendedUsers;
  const credits = overview.metrics.totalCredits;
  const revenue = overview.metrics.totalRevenue;
  const usage = overview.sessions;
  return (
    <div className="admin-screen-stack">
      <div className="admin-metric-grid">
        <MetricCard label="Total users" value={formatNumber(totalUsers)} detail={`${formatNumber(activeUsers)} active`} icon={<Users size={20} />} tone="red" />
        <MetricCard label="Live sessions" value={formatNumber(liveSessions.length)} detail="Current heartbeats" icon={<Radio size={20} />} tone="green" />
        <MetricCard label="Credits issued" value={formatNumber(credits)} detail={`${formatNumber(suspendedUsers)} suspended users`} icon={<Coins size={20} />} tone="amber" />
        <MetricCard label="Revenue value" value={formatNumber(revenue)} detail={`${formatNumber(overview.metrics.purchasesToday)} purchases today`} icon={<CircleDollarSign size={20} />} tone="blue" />
      </div>

      <div className="admin-overview-grid">
        <section className="admin-card admin-chart-card">
          <div className="admin-card-heading"><div><span>Usage trend</span><h3>Voice conversion activity</h3></div><button type="button" onClick={() => onNavigate("analytics")}>View analytics</button></div>
          {usage.length ? <BarChart data={usage} /> : <AdminInlineEmpty message="The overview endpoint has not returned usage-series data yet." />}
        </section>
        <section className="admin-card admin-health-card">
          <div className="admin-card-heading"><div><span>Infrastructure</span><h3>Operational snapshot</h3></div><StatusBadge status="connected" /></div>
          <HealthRow icon={<Server size={17} />} label="Vercel serverless API" value="responding" />
          <HealthRow icon={<Database size={17} />} label="Firebase data" value={`${formatNumber(totalUsers)} users`} />
          <HealthRow icon={<CreditCard size={17} />} label="Flutterwave records" value={`${formatNumber(overview.metrics.purchasesToday)} today`} />
          <HealthRow icon={<Zap size={17} />} label="Voice engine clients" value={liveSessions.length ? "active" : "idle"} />
        </section>
      </div>

      <section className="admin-card">
        <div className="admin-card-heading"><div><span>Right now</span><h3>Recent live sessions</h3></div><button type="button" onClick={() => onNavigate("live")}>Open live activity</button></div>
        <LiveSessionTable sessions={liveSessions.slice(0, 5)} compact />
      </section>
    </div>
  );
}

function UsersScreen({ users, totalUsers, search, statusFilter, onSearch, onStatusFilter, onAdjustCredits, onChangeSuspension }: { users: AdminUser[]; totalUsers: number; search: string; statusFilter: string; onSearch: (value: string) => void; onStatusFilter: (value: string) => void; onAdjustCredits: (user: AdminUser) => void; onChangeSuspension: (user: AdminUser) => void }) {
  return (
    <section className="admin-card admin-data-card">
      <div className="admin-data-toolbar">
        <div><span>Firebase accounts</span><h3>User management</h3><p>{users.length === totalUsers ? `${totalUsers} users` : `${users.length} of ${totalUsers} users`}</p></div>
        <div className="admin-filter-row"><SearchInput value={search} onChange={onSearch} placeholder="Name, email or user ID" /><select value={statusFilter} aria-label="Filter users by status" onChange={(event) => onStatusFilter(event.target.value)}><option value="all">All accounts</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="pending">Pending</option><option value="disabled">Disabled</option></select></div>
      </div>
      {!users.length ? <AdminInlineEmpty message="No user records match this search or filter." /> : (
        <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>User</th><th>Status</th><th>Credits</th><th>Sessions</th><th>Last active</th><th><span className="admin-visually-hidden">Actions</span></th></tr></thead><tbody>{users.map((user) => {
          const suspended = userSuspended(user);
          return <tr key={userId(user) || userEmail(user)}><td><div className="admin-user-cell"><span>{initials(userName(user))}</span><div><strong>{userName(user)}</strong><small>{userEmail(user)}</small></div></div></td><td><StatusBadge status={suspended ? "suspended" : readString(user, ["status", "accountStatus"], "active")} /></td><td><strong>{formatNumber(userCredits(user))}</strong></td><td>{formatNumber(readNumber(user, ["sessionCount", "totalSessions", "sessions"]))}</td><td>{formatDate(firstValue(asRecord(user), ["lastSeenAt", "lastActiveAt", "updatedAt"]))}</td><td><div className="admin-row-actions"><button type="button" onClick={() => onAdjustCredits(user)}><WalletCards size={15} /> Credits</button><button type="button" className={suspended ? "admin-action-success" : "admin-action-danger"} onClick={() => onChangeSuspension(user)}>{suspended ? <UserCheck size={15} /> : <AlertCircle size={15} />}{suspended ? "Reactivate" : "Suspend"}</button></div></td></tr>;
        })}</tbody></table></div>
      )}
    </section>
  );
}

function LiveScreen({ sessions, total, search, engineFilter, onSearch, onEngineFilter }: { sessions: AdminLiveSession[]; total: number; search: string; engineFilter: string; onSearch: (value: string) => void; onEngineFilter: (value: string) => void }) {
  return <div className="admin-screen-stack"><div className="admin-metric-grid admin-metric-grid-three"><MetricCard label="Active sessions" value={formatNumber(total)} detail="Reporting now" icon={<Radio size={20} />} tone="green" /><MetricCard label="RVC sessions" value={formatNumber(sessions.filter((item) => readString(item, ["engine", "engineMode"]).toLowerCase().includes("rvc")).length)} detail="CPU voice conversion" icon={<Gauge size={20} />} tone="blue" /><MetricCard label="Beatrice sessions" value={formatNumber(sessions.filter((item) => readString(item, ["engine", "engineMode"]).toLowerCase().includes("beatrice")).length)} detail="Beatrice V2" icon={<Sparkles size={20} />} tone="red" /></div><section className="admin-card admin-data-card"><div className="admin-data-toolbar"><div><span>Privacy-safe telemetry</span><h3>Live user activity</h3><p>No audio is captured or available here.</p></div><div className="admin-filter-row"><SearchInput value={search} onChange={onSearch} placeholder="User, model or session" /><select value={engineFilter} aria-label="Filter live sessions by engine" onChange={(event) => onEngineFilter(event.target.value)}><option value="all">All engines</option><option value="rvc">RVC</option><option value="beatrice">Beatrice V2</option></select></div></div><LiveSessionTable sessions={sessions} /></section></div>;
}

function AnalyticsScreen({ overview, purchases, liveSessions }: { overview: AdminOverview | null; purchases: AdminPurchase[]; liveSessions: AdminLiveSession[] }) {
  if (!overview) return <AdminEmptyState icon={<BarChart3 size={25} />} title="Analytics unavailable" description="The admin overview endpoint did not return analytics data." />;
  const revenue = purchases.reduce((sum, purchase) => {
    const status = readString(purchase, ["status", "paymentStatus"]).toLowerCase();
    return ["success", "successful", "completed", "paid"].includes(status) ? sum + readNumber(purchase, ["amount", "paidAmount"]) : sum;
  }, 0);
  const currency = readString(purchases[0], ["currency"], readString(overview, ["currency"], "NGN"));
  const successfulPayments = purchases.filter((purchase) => ["success", "successful", "completed", "paid"].includes(readString(purchase, ["status", "paymentStatus"]).toLowerCase())).length;
  const paymentRate = purchases.length ? (successfulPayments / purchases.length) * 100 : 0;
  const dailyRevenue = purchaseSeries(purchases);
  const rvc = overview.engineUsage.rvc;
  const beatrice = overview.engineUsage.beatrice;
  const maxEngine = Math.max(rvc, beatrice, 1);
  return <div className="admin-screen-stack"><div className="admin-metric-grid"><MetricCard label="Active users" value={formatNumber(overview.metrics.activeUsers)} detail={`${liveSessions.length} reporting live`} icon={<Activity size={20} />} tone="green" /><MetricCard label="Sessions today" value={formatNumber(overview.metrics.sessionsToday)} detail={`${formatNumber(overview.metrics.averageLatencyMs)} ms average latency`} icon={<Clock3 size={20} />} tone="blue" /><MetricCard label="Payment success" value={`${formatNumber(paymentRate)}%`} detail={`${successfulPayments} of ${purchases.length} records`} icon={<CheckCircle2 size={20} />} tone="red" /><MetricCard label="Recorded revenue" value={formatCurrency(revenue, currency)} detail="Loaded purchase records" icon={<CircleDollarSign size={20} />} tone="amber" /></div><div className="admin-overview-grid"><section className="admin-card admin-chart-card"><div className="admin-card-heading"><div><span>Payments</span><h3>Seven-day revenue</h3></div></div>{dailyRevenue.length ? <BarChart data={dailyRevenue} currency={currency} /> : <AdminInlineEmpty message="No dated payment records are available for this chart." />}</section><section className="admin-card"><div className="admin-card-heading"><div><span>Usage</span><h3>Engine distribution</h3></div></div><div className="admin-engine-bars"><ProgressRow label="RVC" value={rvc} percent={(rvc / maxEngine) * 100} tone="admin-progress-blue" /><ProgressRow label="Beatrice V2" value={beatrice} percent={(beatrice / maxEngine) * 100} tone="admin-progress-red" /></div><p className="admin-privacy-note"><ShieldCheck size={16} /> Analytics contain operational metadata only. User voice audio remains local.</p></section></div></div>;
}

function PurchasesScreen({ purchases, total, search, statusFilter, onSearch, onStatusFilter }: { purchases: AdminPurchase[]; total: number; search: string; statusFilter: string; onSearch: (value: string) => void; onStatusFilter: (value: string) => void }) {
  return <section className="admin-card admin-data-card"><div className="admin-data-toolbar"><div><span>Flutterwave records</span><h3>Purchase log</h3><p>{purchases.length === total ? `${total} transactions` : `${purchases.length} of ${total} transactions`}</p></div><div className="admin-filter-row"><SearchInput value={search} onChange={onSearch} placeholder="User or reference" /><select value={statusFilter} aria-label="Filter purchases by status" onChange={(event) => onStatusFilter(event.target.value)}><option value="all">All statuses</option><option value="successful">Successful</option><option value="pending">Pending</option><option value="failed">Failed</option></select></div></div>{!purchases.length ? <AdminInlineEmpty message="No purchase records match this search or filter." /> : <div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Reference</th><th>Customer</th><th>Amount</th><th>Credits</th><th>Status</th><th>Date</th></tr></thead><tbody>{purchases.map((purchase, index) => { const reference = readString(purchase, ["reference", "transactionReference", "id"], `Transaction ${index + 1}`); const currency = readString(purchase, ["currency"], "NGN"); const status = readString(purchase, ["status", "paymentStatus"], "unknown"); return <tr key={reference}><td><strong className="admin-mono">{reference}</strong></td><td><div className="admin-table-primary"><strong>{readString(purchase, ["userName", "displayName"], "Morphly user")}</strong><small>{readString(purchase, ["email", "userEmail", "userId"], "No customer identifier")}</small></div></td><td><strong>{formatCurrency(readNumber(purchase, ["amount", "paidAmount"]), currency)}</strong></td><td>{formatNumber(readNumber(purchase, ["credits", "creditsPurchased", "creditAmount"]))}</td><td><StatusBadge status={status} /></td><td>{formatDate(firstValue(asRecord(purchase), ["createdAt", "paidAt", "timestamp"]))}</td></tr>; })}</tbody></table></div>}</section>;
}

function NotificationsScreen({ notifications, draft, setDraft, submitting, error, onSubmit }: { notifications: AdminNotification[]; draft: NotificationDraft; setDraft: (draft: NotificationDraft) => void; submitting: boolean; error: string; onSubmit: (event: FormEvent) => void }) {
  return <div className="admin-split-layout"><section className="admin-card admin-form-card"><div className="admin-card-heading"><div><span>Message composer</span><h3>Publish notification</h3></div><Send size={19} /></div><form className="admin-form-grid" onSubmit={onSubmit}><label className="admin-field admin-field-wide"><span>Title</span><input maxLength={100} value={draft.title} placeholder="Short notification title" onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label><label className="admin-field admin-field-wide"><span>Message</span><textarea rows={5} maxLength={800} value={draft.message} placeholder="Write the message users will see" onChange={(event) => setDraft({ ...draft, message: event.target.value })} /></label><label className="admin-field"><span>Severity</span><select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as NotificationKind })}><option value="info">Information</option><option value="success">Success</option><option value="warning">Warning</option><option value="critical">Critical</option></select></label><label className="admin-field"><span>Audience</span><select value={draft.audience} onChange={(event) => setDraft({ ...draft, audience: event.target.value as NotificationDraft["audience"] })}><option value="all">All accounts</option><option value="users">Users only</option><option value="admins">Administrators only</option></select></label><label className="admin-field admin-field-wide"><span>Expiry date (optional)</span><input type="datetime-local" value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} /></label>{error && <div className="admin-field-wide"><AdminFormError message={error} /></div>}<button className="admin-button-primary admin-field-wide" type="submit" disabled={submitting}><Send size={16} /> {submitting ? "Publishing..." : "Publish notification"}</button></form></section><section className="admin-card admin-notification-list-card"><div className="admin-card-heading"><div><span>Published messages</span><h3>Notification history</h3></div><b className="admin-count-badge">{notifications.length}</b></div><div className="admin-notification-list">{notifications.map((item) => <article className={`admin-notification-item ${statusClass(item.kind)}`} key={item.id}><span><Bell size={17} /></span><div><div><strong>{item.title}</strong><StatusBadge status={item.kind} /></div><p>{item.message}</p><small>{item.audience} · {formatDate(item.createdAt)} · {formatNumber(item.deliveryCount)} delivered</small></div></article>)}{!notifications.length && <AdminInlineEmpty message="No notifications have been returned by the backend." />}</div></section></div>;
}

function SupportScreen({ config, draft, setDraft, submitting, error, onSubmit }: { config: SupportConfig | null; draft: SupportDraft; setDraft: (draft: SupportDraft) => void; submitting: boolean; error: string; onSubmit: (event: FormEvent) => void }) {
  return <div className="admin-split-layout"><section className="admin-card admin-form-card"><div className="admin-card-heading"><div><span>User-facing details</span><h3>Customer-care contacts</h3></div><LifeBuoy size={19} /></div><form className="admin-form-grid" onSubmit={onSubmit}><label className="admin-field"><span>Support email</span><input type="email" value={draft.email} placeholder="support@example.com" onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></label><label className="admin-field"><span>Phone</span><input type="tel" value={draft.phone} placeholder="+234..." onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /></label><label className="admin-field"><span>WhatsApp</span><input type="tel" value={draft.whatsapp} placeholder="+234..." onChange={(event) => setDraft({ ...draft, whatsapp: event.target.value })} /></label><label className="admin-field"><span>Public website</span><input type="url" value={draft.website} placeholder="https://..." onChange={(event) => setDraft({ ...draft, website: event.target.value })} /></label><label className="admin-field admin-field-wide"><span>Support hours</span><input value={draft.workingHours} placeholder="Monday-Friday, 9:00-17:00 WAT" onChange={(event) => setDraft({ ...draft, workingHours: event.target.value })} /></label><label className="admin-field admin-field-wide"><span>Help center URL</span><input type="url" value={draft.helpCenterUrl} placeholder="https://help.example.com" onChange={(event) => setDraft({ ...draft, helpCenterUrl: event.target.value })} /></label>{error && <div className="admin-field-wide"><AdminFormError message={error} /></div>}<button className="admin-button-primary admin-field-wide" type="submit" disabled={submitting}><CheckCircle2 size={16} /> {submitting ? "Saving..." : "Save customer-care details"}</button></form></section><section className="admin-card admin-support-preview"><div className="admin-card-heading"><div><span>User preview</span><h3>How support appears</h3></div></div><div className="admin-support-preview-card"><span className="admin-support-logo"><LifeBuoy size={23} /></span><h4>How can we help?</h4><p>Contact the Morphly support team using any available channel below.</p><div>{draft.email && <span><strong>Email</strong>{draft.email}</span>}{draft.phone && <span><strong>Phone</strong>{draft.phone}</span>}{draft.whatsapp && <span><strong>WhatsApp</strong>{draft.whatsapp}</span>}{draft.workingHours && <span><strong>Hours</strong>{draft.workingHours}</span>}{draft.helpCenterUrl && <span><strong>Help center</strong>{draft.helpCenterUrl}</span>}</div>{!config && <small>Save this form to publish the configuration through Firebase.</small>}</div></section></div>;
}

function LogsScreen({ logs, total, search, levelFilter, onSearch, onLevelFilter }: { logs: AdminLogEntry[]; total: number; search: string; levelFilter: string; onSearch: (value: string) => void; onLevelFilter: (value: string) => void }) {
  return <section className="admin-card admin-data-card"><div className="admin-data-toolbar"><div><span>Operational events</span><h3>Software and service logs</h3><p>{logs.length === total ? `${total} events` : `${logs.length} of ${total} events`}</p></div><div className="admin-filter-row"><SearchInput value={search} onChange={onSearch} placeholder="Message, service or ID" /><select value={levelFilter} aria-label="Filter logs by severity" onChange={(event) => onLevelFilter(event.target.value)}><option value="all">All levels</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option><option value="critical">Critical</option></select></div></div>{!logs.length ? <AdminInlineEmpty message="No software logs match this search or filter." /> : <div className="admin-table-wrap"><table className="admin-table admin-log-table"><thead><tr><th>Level</th><th>Source</th><th>Event</th><th>Reference</th><th>Timestamp</th></tr></thead><tbody>{logs.map((entry, index) => { const level = readString(entry, ["level", "severity"], "info"); return <tr key={readString(entry, ["id", "logId"], String(index))}><td><StatusBadge status={level} /></td><td><strong>{readString(entry, ["source", "category", "service"], "application")}</strong></td><td><p className="admin-log-message">{readString(entry, ["message", "event"], "No event message")}</p></td><td><span className="admin-mono">{readString(entry, ["requestId", "sessionId", "userId"], "—")}</span></td><td>{formatDate(firstValue(asRecord(entry), ["createdAt", "timestamp", "occurredAt"]))}</td></tr>; })}</tbody></table></div>}</section>;
}

function SettingsScreen({ overview, supportConfig, session }: { overview: AdminOverview | null; supportConfig: SupportConfig | null; session: PlatformSession }) {
  const identity = sessionIdentity(session);
  const role = readString(session, ["role"], readString(nestedRecord(session, ["user", "profile"]), ["role"], "admin"));
  return <div className="admin-settings-grid"><section className="admin-card"><div className="admin-card-heading"><div><span>Access control</span><h3>Administrator session</h3></div><ShieldCheck size={19} /></div><div className="admin-settings-list"><SettingsRow label="Signed in as" value={identity.email} status="verified" /><SettingsRow label="Role" value={role} status="protected" /><SettingsRow label="Authorization" value="Firebase ID token" status="server verified" /></div><p className="admin-privacy-note"><ShieldCheck size={16} /> Admin authorization must be checked again by every Vercel serverless endpoint.</p></section><section className="admin-card"><div className="admin-card-heading"><div><span>Connected services</span><h3>Integration status</h3></div><Activity size={19} /></div><div className="admin-settings-list"><SettingsRow label="Firebase Auth & Firestore" value={readString(overview, ["firebaseStatus", "databaseStatus"], overview ? "configured" : "unavailable")} status={overview ? "connected" : "check API"} /><SettingsRow label="Flutterwave" value={readString(overview, ["flutterwaveStatus", "paymentStatus"], overview ? "configured" : "unavailable")} status={overview ? "connected" : "check API"} /><SettingsRow label="Vercel serverless API" value={overview ? "Responding" : "No response"} status={overview ? "connected" : "check API"} /><SettingsRow label="Customer care" value={supportConfig ? "Published" : "Not configured"} status={supportConfig ? "active" : "attention"} /></div></section><section className="admin-card admin-settings-wide"><div className="admin-card-heading"><div><span>Security posture</span><h3>Operational safeguards</h3></div></div><div className="admin-safeguard-grid"><div><ShieldCheck size={18} /><strong>Server-side role checks</strong><p>Privileged requests require a valid Firebase token and administrator role.</p></div><div><FileText size={18} /><strong>Audit every mutation</strong><p>Credit, suspension, support, and notification changes should retain actor and reason.</p></div><div><Database size={18} /><strong>Secrets stay server-side</strong><p>Firebase Admin and Flutterwave secret keys must never enter this static client.</p></div></div></section></div>;
}

function MetricCard({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: React.ReactNode; tone: "red" | "green" | "blue" | "amber" }) {
  return <article className={`admin-metric-card admin-metric-${tone}`}><span className="admin-metric-icon">{icon}</span><div><small>{label}</small><strong>{value}</strong><p>{detail}</p></div></article>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`admin-status-badge ${statusClass(status)}`}><i />{status || "unknown"}</span>;
}

function HealthRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return <div className="admin-health-row"><span>{icon}</span><div><strong>{label}</strong><small>Service monitoring</small></div><StatusBadge status={value} /></div>;
}

function SettingsRow({ label, value, status }: { label: string; value: string; status: string }) {
  return <div className="admin-settings-row"><div><strong>{label}</strong><small>{value}</small></div><StatusBadge status={status} /></div>;
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="admin-search"><Search size={16} /><input value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => onChange(event.target.value)} />{value && <button type="button" aria-label="Clear search" onClick={() => onChange("")}><X size={14} /></button>}</label>;
}

function AdminUserSummary({ user }: { user: AdminUser }) {
  return <div className="admin-user-summary"><span>{initials(userName(user))}</span><div><strong>{userName(user)}</strong><small>{userEmail(user)}</small><code>{userId(user)}</code></div><StatusBadge status={userSuspended(user) ? "suspended" : "active"} /></div>;
}

function LiveSessionTable({ sessions, compact = false }: { sessions: AdminLiveSession[]; compact?: boolean }) {
  if (!sessions.length) return <AdminInlineEmpty message="No live client heartbeats are currently available." />;
  return <div className="admin-table-wrap"><table className={`admin-table ${compact ? "admin-table-compact" : ""}`}><thead><tr><th>User</th><th>Engine / model</th><th>Latency</th><th>Duration</th><th>Last heartbeat</th></tr></thead><tbody>{sessions.map((item, index) => { const id = readString(item, ["id", "sessionId"], String(index)); const user = readString(item, ["userName", "displayName", "email"], readString(item, ["userId", "uid"], "Morphly user")); const engine = readString(item, ["engine", "engineMode", "voiceEngine"], "Unknown engine"); return <tr key={id}><td><div className="admin-live-user"><i /><div><strong>{user}</strong><small>{readString(item, ["userId", "uid"], id)}</small></div></div></td><td><div className="admin-table-primary"><strong>{engine}</strong><small>{readString(item, ["model", "modelName", "voiceName"], "No model reported")}</small></div></td><td>{readNumber(item, ["latencyMs", "latency"]) ? `${formatNumber(readNumber(item, ["latencyMs", "latency"]))} ms` : "—"}</td><td>{formatDuration(readNumber(item, ["durationSeconds", "duration", "elapsedSeconds"]))}</td><td>{formatDate(firstValue(asRecord(item), ["lastHeartbeatAt", "updatedAt", "lastSeenAt"]))}</td></tr>; })}</tbody></table></div>;
}

function formatDuration(totalSeconds: number) {
  if (!totalSeconds) return "—";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function purchaseSeries(purchases: AdminPurchase[]) {
  const totals = new Map<string, number>();
  purchases.forEach((purchase) => {
    const status = readString(purchase, ["status", "paymentStatus"]).toLowerCase();
    if (!["success", "successful", "completed", "paid"].includes(status)) return;
    const rawDate = firstValue(asRecord(purchase), ["createdAt", "paidAt", "timestamp"]);
    if (!rawDate) return;
    const date = new Date(String(rawDate));
    if (Number.isNaN(date.getTime())) return;
    const key = date.toISOString().slice(0, 10);
    totals.set(key, (totals.get(key) || 0) + readNumber(purchase, ["amount", "paidAmount"]));
  });
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).slice(-7).map(([date, value]) => ({ label: formatDate(date, false), value }));
}

function BarChart({ data, currency }: { data: Array<{ label: string; value: number }>; currency?: string }) {
  const max = Math.max(...data.map((item) => item.value), 1);
  return <div className="admin-bar-chart" role="img" aria-label="Bar chart"><div className="admin-chart-grid"><i /><i /><i /><i /></div>{data.map((item) => <div className="admin-chart-column" key={item.label}><span className="admin-chart-value">{currency ? formatCurrency(item.value, currency) : formatNumber(item.value)}</span><div><i style={{ "--admin-bar-height": `${Math.max(4, (item.value / max) * 100)}%` } as React.CSSProperties} /></div><small>{item.label}</small></div>)}</div>;
}

function ProgressRow({ label, value, percent, tone }: { label: string; value: number; percent: number; tone: string }) {
  return <div className="admin-progress-row"><div><strong>{label}</strong><span>{value} live</span></div><div className="admin-progress-track"><i className={tone} style={{ "--admin-progress": `${Math.min(100, Math.max(0, percent))}%` } as React.CSSProperties} /></div></div>;
}

function AdminModal({ title, icon, onClose, children }: { title: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return <div className="admin-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="admin-modal" role="dialog" aria-modal="true" aria-label={title}><header><span>{icon}</span><h2>{title}</h2><button className="admin-icon-button" type="button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></header>{children}</section></div>;
}

function AdminFormError({ message }: { message: string }) {
  return <div className="admin-form-error" role="alert"><AlertCircle size={16} /><span>{message}</span></div>;
}

function AdminErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="admin-error-state" role="alert"><span><AlertCircle size={22} /></span><div><strong>Admin data could not be loaded</strong><p>{message}</p><small>Confirm the Vercel API URL, Firebase token verification, deployed routes, and this account&apos;s admin role.</small></div><button type="button" onClick={onRetry}><RefreshCw size={15} /> Retry</button></section>;
}

function AdminLoadingState() {
  return <div className="admin-loading-grid" aria-label="Loading admin data"><i /><i /><i /><i /><span><RefreshCw size={20} className="admin-spin" /> Loading secure admin data...</span></div>;
}

function AdminEmptyState({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return <section className="admin-card admin-empty-state"><span>{icon}</span><strong>{title}</strong><p>{description}</p></section>;
}

function AdminInlineEmpty({ message }: { message: string }) {
  return <div className="admin-inline-empty"><Database size={20} /><span>{message}</span></div>;
}

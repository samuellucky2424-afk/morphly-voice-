"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { getPlatformSession, isCloudApiConfigured } from "./cloud-api";
import {
  createFirebaseEmailAccount,
  firebaseAuthErrorMessage,
  getFirebaseConfigurationIssue,
  getFirebaseIdToken,
  isFirebaseConfigured,
  observeFirebaseUser,
  signInWithFirebaseEmail,
  signOutFirebase,
  type FirebaseUser,
} from "./firebase-client";
import type { PlatformSession } from "./platform-types";

const LOCAL_MODE_KEY = "morphly.auth.local-mode.v1";

export type PlatformAuthStatus = "loading" | "signed-out" | "authenticated";

export interface PlatformAuthContextValue {
  status: PlatformAuthStatus;
  session: PlatformSession | null;
  token: string | null;
  error: string;
  isLocalMode: boolean;
  signIn(email: string, password: string): Promise<void>;
  createAccount(email: string, password: string, displayName: string): Promise<void>;
  signOut(): Promise<void>;
  refreshSession(): Promise<void>;
  continueLocally(): void;
}

export type AuthenticatedPlatformAuth = Omit<PlatformAuthContextValue, "session"> & {
  session: PlatformSession;
};

export interface AuthGateProps {
  children: ReactNode;
  loadingFallback?: ReactNode;
}

const AuthContext = createContext<PlatformAuthContextValue | null>(null);

function localSession(): PlatformSession {
  return {
    uid: "local-device",
    email: "local@morphly.invalid",
    displayName: "Local creator",
    photoUrl: null,
    role: "user",
    status: "active",
    credits: 0,
    source: "local",
    createdAt: null,
    lastSeenAt: null,
  };
}

function readableError(error: unknown) {
  return firebaseAuthErrorMessage(error);
}

export function usePlatformAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("usePlatformAuth must be used inside AuthGate.");
  return value;
}

export function AuthGate({ children, loadingFallback }: AuthGateProps) {
  const [status, setStatus] = useState<PlatformAuthStatus>("loading");
  const [session, setSession] = useState<PlatformSession | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [error, setError] = useState("");
  const syncNonce = useRef(0);
  const localMode = useRef(false);

  const synchronizeCloudUser = useCallback(async (user: FirebaseUser, forceRefresh = false) => {
    const nonce = ++syncNonce.current;
    setStatus("loading");
    setError("");
    try {
      const nextToken = await getFirebaseIdToken(user, forceRefresh);
      const nextSession = await getPlatformSession(nextToken);
      if (nextSession.uid !== user.uid) throw new Error("The Firebase account does not match the backend session.");
      if (nonce !== syncNonce.current) return;
      setFirebaseUser(user);
      setToken(nextToken);
      setSession(nextSession);
      setStatus("authenticated");
    } catch (nextError) {
      if (nonce !== syncNonce.current) return;
      setToken(null);
      setSession(null);
      setStatus("signed-out");
      setError(readableError(nextError));
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    try {
      if (window.localStorage.getItem(LOCAL_MODE_KEY) === "true") {
        localMode.current = true;
        const timeout = window.setTimeout(() => {
          setSession(localSession());
          setToken(null);
          setStatus("authenticated");
        }, 0);
        return () => window.clearTimeout(timeout);
      }
    } catch {
      // Local mode still remains available even when storage is blocked.
    }

    if (!isFirebaseConfigured() || !isCloudApiConfigured()) {
      const timeout = window.setTimeout(() => setStatus("signed-out"), 0);
      return () => window.clearTimeout(timeout);
    }

    void observeFirebaseUser(
      (user) => {
        if (disposed || localMode.current) return;
        setFirebaseUser(user);
        if (user) {
          void synchronizeCloudUser(user);
        } else {
          ++syncNonce.current;
          setToken(null);
          setSession(null);
          setStatus("signed-out");
        }
      },
      (nextError) => {
        if (disposed) return;
        setError(readableError(nextError));
        setStatus("signed-out");
      },
    ).then((stop) => {
      if (disposed) stop();
      else unsubscribe = stop;
    }).catch((nextError) => {
      if (disposed) return;
      setError(readableError(nextError));
      setStatus("signed-out");
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [synchronizeCloudUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    setError("");
    const user = await signInWithFirebaseEmail(email, password);
    await synchronizeCloudUser(user, true);
  }, [synchronizeCloudUser]);

  const createAccount = useCallback(async (email: string, password: string, displayName: string) => {
    setError("");
    const user = await createFirebaseEmailAccount(email, password, displayName);
    await synchronizeCloudUser(user, true);
  }, [synchronizeCloudUser]);

  const signOut = useCallback(async () => {
    ++syncNonce.current;
    localMode.current = false;
    try {
      window.localStorage.removeItem(LOCAL_MODE_KEY);
    } catch {
      // State is still cleared below.
    }
    setFirebaseUser(null);
    setSession(null);
    setToken(null);
    setError("");
    setStatus("signed-out");
    if (firebaseUser) await signOutFirebase();
  }, [firebaseUser]);

  const refreshSession = useCallback(async () => {
    if (!firebaseUser) return;
    await synchronizeCloudUser(firebaseUser, true);
  }, [firebaseUser, synchronizeCloudUser]);

  const continueLocally = useCallback(() => {
    ++syncNonce.current;
    localMode.current = true;
    try {
      window.localStorage.setItem(LOCAL_MODE_KEY, "true");
    } catch {
      // Local processing can continue for this browser session.
    }
    if (firebaseUser) void signOutFirebase().catch(() => undefined);
    setFirebaseUser(null);
    setToken(null);
    setSession(localSession());
    setError("");
    setStatus("authenticated");
  }, [firebaseUser]);

  const contextValue = useMemo<PlatformAuthContextValue>(() => ({
    status,
    session,
    token,
    error,
    isLocalMode: session?.source === "local",
    signIn,
    createAccount,
    signOut,
    refreshSession,
    continueLocally,
  }), [continueLocally, createAccount, error, refreshSession, session, signIn, signOut, status, token]);

  let content: ReactNode;
  if (status === "loading") {
    content = loadingFallback ?? <AuthLoading />;
  } else if (!session) {
    content = <LoginPanel auth={contextValue} />;
  } else if (session.status === "suspended" || session.status === "disabled") {
    content = <SuspendedPanel session={session} signOut={signOut} />;
  } else {
    content = children;
  }

  return <AuthContext.Provider value={contextValue}>{content}</AuthContext.Provider>;
}

function LoginPanel({ auth }: { auth: PlatformAuthContextValue }) {
  const [mode, setMode] = useState<"sign-in" | "create-account">("sign-in");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState("");
  const firebaseIssue = getFirebaseConfigurationIssue();
  const cloudIssue = !isCloudApiConfigured()
    ? "VITE_MORPHLY_API_URL has not been configured for the Vercel API."
    : "";
  const cloudLoginAvailable = !firebaseIssue && !cloudIssue;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    if (!cloudLoginAvailable) return;
    if (password.length < 8) {
      setFormError("Password must contain at least 8 characters.");
      return;
    }
    if (mode === "create-account" && password !== confirmPassword) {
      setFormError("The passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      if (mode === "create-account") await auth.createAccount(email, password, displayName);
      else await auth.signIn(email, password);
    } catch (nextError) {
      setFormError(readableError(nextError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={authStyles.screen}>
      <section style={authStyles.card} aria-labelledby="morphly-auth-title">
        <div style={authStyles.brandRow}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/morphly-logo.png" alt="Morphly Voice" style={authStyles.logo} />
          <div><strong style={authStyles.brand}>Morphly Voice</strong><span style={authStyles.brandCaption}>Real-time AI studio</span></div>
        </div>
        <div style={authStyles.tabs} role="tablist" aria-label="Account access">
          <button type="button" role="tab" aria-selected={mode === "sign-in"} style={mode === "sign-in" ? authStyles.activeTab : authStyles.tab} onClick={() => setMode("sign-in")}>Sign in</button>
          <button type="button" role="tab" aria-selected={mode === "create-account"} style={mode === "create-account" ? authStyles.activeTab : authStyles.tab} onClick={() => setMode("create-account")}>Create account</button>
        </div>
        <h1 id="morphly-auth-title" style={authStyles.title}>{mode === "sign-in" ? "Welcome back" : "Create your workspace"}</h1>
        <p style={authStyles.subtitle}>{mode === "sign-in" ? "Sign in to sync your credits, models, and sessions." : "Create a Morphly account secured by Firebase Authentication."}</p>

        <form onSubmit={submit} style={authStyles.form}>
          {mode === "create-account" && <AuthField label="Display name" value={displayName} onChange={setDisplayName} autoComplete="name" required />}
          <AuthField label="Email" value={email} onChange={setEmail} type="email" autoComplete="email" required />
          <AuthField label="Password" value={password} onChange={setPassword} type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required />
          {mode === "create-account" && <AuthField label="Confirm password" value={confirmPassword} onChange={setConfirmPassword} type="password" autoComplete="new-password" required />}
          {(formError || auth.error) && <p style={authStyles.error} role="alert">{formError || auth.error}</p>}
          {!cloudLoginAvailable && <p style={authStyles.configuration}><strong>Cloud sign-in is not ready.</strong><br />{firebaseIssue || cloudIssue}</p>}
          <button type="submit" style={authStyles.primaryButton} disabled={busy || !cloudLoginAvailable}>{busy ? "Please wait..." : mode === "sign-in" ? "Enter studio" : "Create account"}</button>
        </form>

        <div style={authStyles.divider}><span style={authStyles.dividerLine} /><span>or</span><span style={authStyles.dividerLine} /></div>
        <button type="button" style={authStyles.localButton} onClick={auth.continueLocally}>Continue in local mode</button>
        <p style={authStyles.localNote}>Local mode keeps the voice engine available on this computer. Cloud credits, payments, syncing, and all admin tools remain disabled.</p>
      </section>
    </main>
  );
}

function AuthField({ label, value, onChange, type = "text", autoComplete, required = false }: { label: string; value: string; onChange(value: string): void; type?: string; autoComplete?: string; required?: boolean }) {
  return <label style={authStyles.label}><span>{label}</span><input style={authStyles.input} value={value} onChange={(event) => onChange(event.target.value)} type={type} autoComplete={autoComplete} required={required} /></label>;
}

function AuthLoading() {
  return <main style={authStyles.screen}><section style={authStyles.loadingCard} role="status"><span style={authStyles.spinner} /> Verifying your Morphly account...</section></main>;
}

function SuspendedPanel({ session, signOut }: { session: PlatformSession; signOut(): Promise<void> }) {
  return <main style={authStyles.screen}><section style={authStyles.card}><h1 style={authStyles.title}>Account unavailable</h1><p style={authStyles.subtitle}>{session.status === "suspended" ? "This account has been suspended. Contact Morphly support if you believe this is a mistake." : "This account is currently disabled."}</p><button type="button" style={authStyles.primaryButton} onClick={() => void signOut()}>Sign out</button></section></main>;
}

const authStyles: Record<string, CSSProperties> = {
  screen: { alignItems: "center", background: "radial-gradient(circle at 75% 25%, #ffdce2 0, transparent 30%), #f7f7f9", display: "flex", justifyContent: "center", minHeight: "100vh", padding: 20 },
  card: { background: "rgba(255,255,255,.96)", border: "1px solid #e8e8ec", borderRadius: 22, boxShadow: "0 28px 90px rgba(30,20,28,.14)", maxWidth: 460, padding: 30, width: "100%" },
  loadingCard: { alignItems: "center", background: "#fff", border: "1px solid #e8e8ec", borderRadius: 16, boxShadow: "0 20px 60px rgba(30,20,28,.1)", color: "#55555d", display: "flex", fontSize: 13, gap: 12, padding: "20px 24px" },
  spinner: { border: "3px solid #f3c8cf", borderRadius: "50%", borderTopColor: "#e20d2f", height: 22, width: 22 },
  brandRow: { alignItems: "center", display: "flex", gap: 12, marginBottom: 25 },
  logo: { borderRadius: 12, height: 44, objectFit: "cover", width: 44 },
  brand: { display: "block", fontSize: 17, letterSpacing: "-.03em" },
  brandCaption: { color: "#92929b", display: "block", fontSize: 11, marginTop: 2 },
  tabs: { background: "#f3f3f5", borderRadius: 11, display: "grid", gap: 3, gridTemplateColumns: "1fr 1fr", marginBottom: 24, padding: 4 },
  tab: { background: "transparent", border: 0, borderRadius: 8, color: "#777780", fontSize: 12, fontWeight: 650, minHeight: 38 },
  activeTab: { background: "#fff", border: 0, borderRadius: 8, boxShadow: "0 3px 12px rgba(20,18,22,.08)", color: "#17171b", fontSize: 12, fontWeight: 720, minHeight: 38 },
  title: { color: "#17171b", fontSize: 25, letterSpacing: "-.04em", margin: "0 0 7px" },
  subtitle: { color: "#72727b", fontSize: 12.5, lineHeight: 1.55, margin: "0 0 23px" },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  label: { color: "#56565e", display: "flex", flexDirection: "column", fontSize: 11, fontWeight: 650, gap: 7 },
  input: { background: "#fafafa", border: "1px solid #dddde3", borderRadius: 10, color: "#25252a", fontSize: 13, height: 44, outlineColor: "#e20d2f", padding: "0 12px", width: "100%" },
  error: { background: "#fff0f2", border: "1px solid #ffc8d1", borderRadius: 9, color: "#a80722", fontSize: 11, lineHeight: 1.45, margin: 0, padding: "10px 12px" },
  configuration: { background: "#fff8eb", border: "1px solid #efd9ad", borderRadius: 9, color: "#76592b", fontSize: 10.5, lineHeight: 1.5, margin: 0, padding: "10px 12px" },
  primaryButton: { background: "#e20d2f", border: "1px solid #e20d2f", borderRadius: 10, boxShadow: "0 9px 22px rgba(226,13,47,.18)", color: "#fff", fontSize: 12, fontWeight: 720, minHeight: 44, padding: "0 16px", width: "100%" },
  divider: { alignItems: "center", color: "#aaaab1", display: "flex", fontSize: 10, gap: 10, margin: "20px 0 15px" },
  dividerLine: { background: "#e6e6ea", flex: 1, height: 1 },
  localButton: { background: "#fff", border: "1px solid #d9d9de", borderRadius: 10, color: "#414147", fontSize: 12, fontWeight: 680, minHeight: 43, width: "100%" },
  localNote: { color: "#9898a0", fontSize: 9.5, lineHeight: 1.5, margin: "10px 3px 0", textAlign: "center" },
};

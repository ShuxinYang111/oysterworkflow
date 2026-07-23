import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import oysterIconUrl from "../../desktop/assets/app-icon.png";
import type {
  CloudAuthState,
  CloudSignUpResponse,
  CloudSyncMode,
  CloudSyncPhase,
  CloudSyncResult,
} from "../../src/cloud/contracts.js";
import {
  DEFAULT_APP_LANGUAGE,
  normalizeAppLanguage,
  type AppLanguage,
} from "./app-language";
import { createCloudAuthClient } from "./cloud-auth-client";
import { createLatestCloudSyncGuard } from "./cloud-sync-guard";

interface CloudAuthContextValue {
  state: CloudAuthState;
  syncPhase: CloudSyncPhase;
  syncResult: CloudSyncResult | null;
  errorMessage: string | null;
  sync: (mode?: CloudSyncMode) => Promise<void>;
  signOut: () => Promise<void>;
}

const signedOutState: CloudAuthState = {
  status: "signed_out",
  configured: true,
  user: null,
  expiresAt: null,
};

const CloudAuthContext = createContext<CloudAuthContextValue | null>(null);

const testCloudAuthValue: CloudAuthContextValue = {
  state: signedOutState,
  syncPhase: "idle",
  syncResult: null,
  errorMessage: null,
  sync: async () => undefined,
  signOut: async () => undefined,
};

export function CloudAuthBoundary({ children }: { children: ReactNode }) {
  if (import.meta.env.MODE === "test") {
    return (
      <CloudAuthContext.Provider value={testCloudAuthValue}>
        {children}
      </CloudAuthContext.Provider>
    );
  }
  return <CloudAuthRuntime>{children}</CloudAuthRuntime>;
}

function CloudAuthRuntime({ children }: { children: ReactNode }) {
  const client = useMemo(createCloudAuthClient, []);
  const [state, setState] = useState<CloudAuthState>({
    ...signedOutState,
    status: "loading",
  });
  const [syncPhase, setSyncPhase] = useState<CloudSyncPhase>("idle");
  const [syncResult, setSyncResult] = useState<CloudSyncResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [continueOffline, setContinueOffline] = useState(false);
  const lastAutoSyncedUserId = useRef<string | null>(null);
  const retrySyncModeRef = useRef<CloudSyncMode>("pull");
  const authStateRequestIdRef = useRef(0);
  const syncGuard = useMemo(createLatestCloudSyncGuard, []);

  const applyAuthState = useCallback(
    (nextState: CloudAuthState) => {
      authStateRequestIdRef.current += 1;
      const nextUserId =
        nextState.status === "signed_in" ? (nextState.user?.id ?? null) : null;
      const identityChanged = syncGuard.setIdentity(nextUserId);
      setState(nextState);
      setErrorMessage(null);
      if (identityChanged || nextState.status !== "signed_in") {
        setSyncPhase("idle");
        setSyncResult(null);
        setContinueOffline(false);
        lastAutoSyncedUserId.current = null;
      }
    },
    [syncGuard],
  );

  const restoreAuthState = useCallback(
    async (showLoading: boolean): Promise<void> => {
      const requestId = authStateRequestIdRef.current + 1;
      authStateRequestIdRef.current = requestId;
      if (showLoading) {
        setState({ ...signedOutState, status: "loading" });
      }
      setErrorMessage(null);
      try {
        const nextState = await client.getState();
        if (authStateRequestIdRef.current === requestId) {
          applyAuthState(nextState);
        }
      } catch (error) {
        if (authStateRequestIdRef.current === requestId) {
          applyAuthState(signedOutState);
          setErrorMessage(toErrorMessage(error));
        }
      }
    },
    [applyAuthState, client],
  );

  useEffect(() => {
    let active = true;
    const stopState = client.onStateChanged((nextState) => {
      if (!active) {
        return;
      }
      applyAuthState(nextState);
    });
    const stopError = client.onError((message) => {
      if (active) {
        setErrorMessage(message);
      }
    });
    void restoreAuthState(false);
    return () => {
      active = false;
      authStateRequestIdRef.current += 1;
      stopState();
      stopError();
    };
  }, [applyAuthState, client, restoreAuthState]);

  async function sync(mode: CloudSyncMode = "pull"): Promise<void> {
    const userIdAtStart = state.user?.id ?? null;
    const attempt = syncGuard.begin(userIdAtStart);
    if (!syncGuard.isCurrent(attempt)) {
      return;
    }
    retrySyncModeRef.current = mode;
    if (mode === "pull") {
      setSyncPhase("syncing");
    }
    setErrorMessage(null);
    try {
      const result = await client.sync(mode);
      if (!syncGuard.isCurrent(attempt)) {
        return;
      }
      if (result.userId !== userIdAtStart) {
        throw new Error(
          "Cloud sync returned a different account than the active session.",
        );
      }
      setSyncResult(result);
      setSyncPhase("synced");
      setContinueOffline(false);
      window.dispatchEvent(new CustomEvent("oysterworkflow:cloud-synced"));
    } catch (error) {
      if (!syncGuard.isCurrent(attempt)) {
        return;
      }
      setSyncPhase("error");
      setErrorMessage(toErrorMessage(error));
    }
  }

  useEffect(() => {
    const userId = state.user?.id ?? null;
    if (
      state.status !== "signed_in" ||
      !userId ||
      lastAutoSyncedUserId.current === userId
    ) {
      return;
    }
    lastAutoSyncedUserId.current = userId;
    void sync("pull");
  }, [state.status, state.user?.id]);

  async function signOut(): Promise<void> {
    setErrorMessage(null);
    try {
      const response = await client.signOut();
      applyAuthState(response.state);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      throw error;
    }
  }

  const value: CloudAuthContextValue = {
    state,
    syncPhase,
    syncResult,
    errorMessage,
    sync,
    signOut,
  };

  if (state.status === "loading") {
    return <AuthLoadingScreen language={loadAuthLanguage()} />;
  }
  if (state.status === "signed_out" || state.status === "oauth_pending") {
    return (
      <AuthGate
        client={client}
        initialState={state}
        externalError={errorMessage}
        onState={applyAuthState}
        onRetryInitialState={() => void restoreAuthState(true)}
      />
    );
  }
  if (syncPhase === "syncing" || (syncPhase === "idle" && !continueOffline)) {
    return (
      <CloudSyncScreen
        phase="syncing"
        email={state.user?.email ?? ""}
        language={loadAuthLanguage()}
      />
    );
  }
  if (syncPhase === "error" && !continueOffline) {
    return (
      <CloudSyncScreen
        phase="error"
        email={state.user?.email ?? ""}
        language={loadAuthLanguage()}
        errorMessage={errorMessage}
        onRetry={() => void sync(retrySyncModeRef.current)}
        onContinueOffline={() => setContinueOffline(true)}
        onSignOut={() => void signOut()}
      />
    );
  }
  return (
    <CloudAuthContext.Provider value={value}>
      {children}
    </CloudAuthContext.Provider>
  );
}

export function useCloudAuth(): CloudAuthContextValue {
  const value = useContext(CloudAuthContext);
  if (!value && import.meta.env.MODE === "test") {
    return testCloudAuthValue;
  }
  if (!value) {
    throw new Error("useCloudAuth must be used inside CloudAuthBoundary.");
  }
  return value;
}

export function AuthGate({
  client,
  initialState,
  externalError,
  onState,
  onRetryInitialState,
}: {
  client: ReturnType<typeof createCloudAuthClient>;
  initialState: CloudAuthState;
  externalError: string | null;
  onState: (state: CloudAuthState) => void;
  onRetryInitialState?: () => void;
}) {
  const [mode, setMode] = useState<"sign_up" | "sign_in">("sign_up");
  const [language, setLanguage] = useState<AppLanguage>(loadAuthLanguage);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState<"email" | "google" | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<CloudSignUpResponse | null>(
    null,
  );
  const copy = AUTH_COPY[language];

  useEffect(() => {
    setErrorMessage(externalError);
  }, [externalError]);

  async function handleEmailSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    if (mode === "sign_up" && password !== confirmPassword) {
      setErrorMessage(copy.passwordMismatch);
      return;
    }
    setBusy("email");
    try {
      if (mode === "sign_up") {
        const response = await client.signUp({
          email,
          password,
          displayName,
        });
        if (response.requiresEmailConfirmation) {
          setConfirmation(response);
        } else {
          onState(response.state);
        }
      } else {
        const response = await client.signIn({ email, password });
        onState(response.state);
      }
    } catch (error) {
      setErrorMessage(friendlyAuthError(error, language));
    } finally {
      setBusy(null);
    }
  }

  async function handleGoogle(): Promise<void> {
    setErrorMessage(null);
    setBusy("google");
    try {
      const response = await client.continueWithGoogle();
      onState(response.state);
    } catch (error) {
      setErrorMessage(friendlyAuthError(error, language));
    } finally {
      setBusy(null);
    }
  }

  if (confirmation) {
    return (
      <AuthShell language={language} onLanguageChange={setLanguage}>
        <div className="auth-confirmation" aria-live="polite">
          <div className="auth-confirmation-icon">✓</div>
          <p className="auth-eyebrow">{copy.checkInboxEyebrow}</p>
          <h1>{copy.checkInboxTitle}</h1>
          <p>
            {copy.checkInboxBody} <strong>{confirmation.email}</strong>
          </p>
          <button
            type="button"
            className="auth-primary-button"
            onClick={() => {
              setConfirmation(null);
              setMode("sign_in");
            }}
          >
            {copy.backToSignIn}
          </button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell language={language} onLanguageChange={setLanguage}>
      <div className="auth-card-header">
        <p className="auth-eyebrow">{copy.eyebrow}</p>
        <h1>{mode === "sign_up" ? copy.signUpTitle : copy.signInTitle}</h1>
        <p>{mode === "sign_up" ? copy.signUpBody : copy.signInBody}</p>
      </div>

      <div
        className="auth-mode-tabs"
        role="tablist"
        aria-label={copy.modeLabel}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "sign_up"}
          disabled={busy !== null}
          className={mode === "sign_up" ? "is-active" : ""}
          onClick={() => {
            setMode("sign_up");
            setErrorMessage(null);
          }}
        >
          {copy.createAccount}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "sign_in"}
          disabled={busy !== null}
          className={mode === "sign_in" ? "is-active" : ""}
          onClick={() => {
            setMode("sign_in");
            setErrorMessage(null);
          }}
        >
          {copy.signIn}
        </button>
      </div>

      <button
        type="button"
        className="auth-google-button"
        disabled={busy !== null}
        onClick={() => void handleGoogle()}
      >
        <GoogleMark />
        <span>{busy === "google" ? copy.openingGoogle : copy.google}</span>
      </button>

      <div className="auth-divider">
        <span>{copy.or}</span>
      </div>

      <form className="auth-form" onSubmit={handleEmailSubmit}>
        {mode === "sign_up" ? (
          <label>
            <span>{copy.name}</span>
            <input
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              placeholder={copy.namePlaceholder}
            />
          </label>
        ) : null}
        <label>
          <span>{copy.email}</span>
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            placeholder="you@company.com"
          />
        </label>
        <label>
          <span>{copy.password}</span>
          <input
            type="password"
            autoComplete={
              mode === "sign_up" ? "new-password" : "current-password"
            }
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={8}
            placeholder={copy.passwordPlaceholder}
          />
          {mode === "sign_up" ? <small>{copy.passwordHint}</small> : null}
        </label>
        {mode === "sign_up" ? (
          <label>
            <span>{copy.confirmPassword}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={8}
              placeholder={copy.confirmPasswordPlaceholder}
            />
          </label>
        ) : null}
        {errorMessage ? (
          <>
            <div className="auth-error" role="alert">
              {errorMessage}
            </div>
            {externalError && onRetryInitialState ? (
              <button
                type="button"
                className="auth-text-button"
                disabled={busy !== null}
                onClick={onRetryInitialState}
              >
                {copy.retrySession}
              </button>
            ) : null}
          </>
        ) : initialState.status === "oauth_pending" ? (
          <div className="auth-notice" aria-live="polite">
            {copy.finishGoogle}
          </div>
        ) : null}
        <button
          type="submit"
          className="auth-primary-button"
          disabled={busy !== null}
        >
          {busy === "email"
            ? copy.working
            : mode === "sign_up"
              ? copy.createAccount
              : copy.signIn}
        </button>
      </form>

      <p className="auth-footnote">{copy.securityNote}</p>
    </AuthShell>
  );
}

function AuthShell({
  language,
  onLanguageChange,
  children,
}: {
  language: AppLanguage;
  onLanguageChange: (language: AppLanguage) => void;
  children: ReactNode;
}) {
  return (
    <main className="auth-screen">
      <div className="auth-ambient auth-ambient-one" />
      <div className="auth-ambient auth-ambient-two" />
      <header className="auth-topbar">
        <div className="auth-brand">
          <img src={oysterIconUrl} alt="" />
          <span>OysterWorkflow</span>
        </div>
        <div className="auth-language" aria-label="Language">
          <button
            type="button"
            className={language === "en" ? "is-active" : ""}
            onClick={() => changeAuthLanguage("en", onLanguageChange)}
          >
            EN
          </button>
          <button
            type="button"
            className={language === "zh" ? "is-active" : ""}
            onClick={() => changeAuthLanguage("zh", onLanguageChange)}
          >
            中文
          </button>
        </div>
      </header>
      <section className="auth-card">{children}</section>
      <footer className="auth-footer">
        {language === "zh"
          ? "本地执行，云端协作。"
          : "Local execution. Cloud coordination."}
      </footer>
    </main>
  );
}

export function AuthLoadingScreen({ language }: { language: AppLanguage }) {
  const copy = AUTH_SYSTEM_COPY[language];
  return (
    <main className="auth-screen auth-loading-screen" aria-busy="true">
      <img src={oysterIconUrl} alt="" />
      <span className="auth-loading-ring" />
      <p>{copy.restoringSession}</p>
    </main>
  );
}

export function CloudSyncScreen({
  phase,
  email,
  language,
  errorMessage,
  onRetry,
  onContinueOffline,
  onSignOut,
}: {
  phase: "syncing" | "error";
  email: string;
  language: AppLanguage;
  errorMessage?: string | null;
  onRetry?: () => void;
  onContinueOffline?: () => void;
  onSignOut?: () => void;
}) {
  const copy = AUTH_SYSTEM_COPY[language];
  return (
    <main className="auth-screen auth-loading-screen">
      <img src={oysterIconUrl} alt="" />
      {phase === "syncing" ? <span className="auth-loading-ring" /> : null}
      <h1>{phase === "syncing" ? copy.syncingTitle : copy.syncErrorTitle}</h1>
      <p>{phase === "syncing" ? copy.syncingBody(email) : errorMessage}</p>
      {phase === "error" ? (
        <div className="auth-sync-actions">
          <button
            className="auth-primary-button"
            type="button"
            onClick={onRetry}
          >
            {copy.retrySync}
          </button>
          <button
            className="auth-text-button"
            type="button"
            onClick={onContinueOffline}
          >
            {copy.continueOffline}
          </button>
          <button
            className="auth-text-button"
            type="button"
            onClick={onSignOut}
          >
            {copy.signOut}
          </button>
        </div>
      ) : null}
    </main>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.35 12.2c0-.64-.06-1.25-.16-1.84H12v3.48h5.25a4.48 4.48 0 0 1-1.95 2.94v2.26h3.16c1.85-1.7 2.89-4.22 2.89-6.84Z"
      />
      <path
        fill="#34A853"
        d="M12 21.75c2.64 0 4.86-.87 6.48-2.37l-3.16-2.45c-.88.59-2 .94-3.32.94-2.55 0-4.71-1.72-5.49-4.04H3.25v2.52A9.78 9.78 0 0 0 12 21.75Z"
      />
      <path
        fill="#FBBC05"
        d="M6.51 13.83A5.9 5.9 0 0 1 6.2 12c0-.64.11-1.25.31-1.83V7.65H3.25A9.77 9.77 0 0 0 2.25 12c0 1.57.38 3.05 1 4.35l3.26-2.52Z"
      />
      <path
        fill="#EA4335"
        d="M12 6.13c1.44 0 2.73.49 3.74 1.46l2.81-2.81A9.42 9.42 0 0 0 12 2.25a9.78 9.78 0 0 0-8.75 5.4l3.26 2.52C7.29 7.85 9.45 6.13 12 6.13Z"
      />
    </svg>
  );
}

const AUTH_COPY = {
  en: {
    eyebrow: "Your local AI team",
    signUpTitle: "Create your OysterWorkflow account",
    signInTitle: "Welcome back",
    signUpBody:
      "Sync your AI workers across authorized computers. Workflow cloud sync is not currently available.",
    signInBody:
      "Sign in to restore AI workers and device access. Workflow cloud sync is not currently available.",
    modeLabel: "Authentication mode",
    createAccount: "Create account",
    signIn: "Sign in",
    google: "Continue with Google",
    openingGoogle: "Opening Google...",
    or: "or use email",
    name: "Name",
    namePlaceholder: "Your name",
    email: "Work email",
    password: "Password",
    passwordPlaceholder: "Enter your password",
    passwordHint: "Use at least 8 characters.",
    confirmPassword: "Confirm password",
    confirmPasswordPlaceholder: "Enter it again",
    passwordMismatch: "The two passwords do not match.",
    finishGoogle:
      "Finish signing in in your browser. This window will update automatically.",
    working: "Please wait...",
    securityNote:
      "Your AI workers run locally. AI worker sync never copies browser cookies or system credentials.",
    checkInboxEyebrow: "One more step",
    checkInboxTitle: "Check your inbox",
    checkInboxBody: "We sent a confirmation link to",
    backToSignIn: "Go to sign in",
    retrySession: "Retry session restore",
  },
  zh: {
    eyebrow: "你的本地 AI 团队",
    signUpTitle: "创建 OysterWorkflow 账号",
    signInTitle: "欢迎回来",
    signUpBody: "在授权电脑间同步 AI Worker。当前不提供 Workflow 云同步。",
    signInBody:
      "登录后恢复 AI Worker 和设备访问权限。当前不提供 Workflow 云同步。",
    modeLabel: "认证方式",
    createAccount: "创建账号",
    signIn: "登录",
    google: "使用 Google 继续",
    openingGoogle: "正在打开 Google...",
    or: "或使用邮箱",
    name: "姓名",
    namePlaceholder: "你的姓名",
    email: "工作邮箱",
    password: "密码",
    passwordPlaceholder: "输入密码",
    passwordHint: "至少使用 8 个字符。",
    confirmPassword: "确认密码",
    confirmPasswordPlaceholder: "再次输入密码",
    passwordMismatch: "两次输入的密码不一致。",
    finishGoogle: "请在浏览器中完成登录，本窗口会自动更新。",
    working: "请稍候...",
    securityNote:
      "AI Worker 始终在本地运行。AI Worker 同步不会复制浏览器 cookie 或系统凭据。",
    checkInboxEyebrow: "还差一步",
    checkInboxTitle: "请检查邮箱",
    checkInboxBody: "确认链接已发送至",
    backToSignIn: "前往登录",
    retrySession: "重试恢复会话",
  },
} as const;

const AUTH_SYSTEM_COPY = {
  en: {
    restoringSession: "Restoring your OysterWorkflow session...",
    syncingTitle: "Syncing your AI workers",
    syncErrorTitle: "AI worker sync needs attention",
    syncingBody: (email: string) =>
      `Preparing your AI workers and this computer for ${email}.`,
    retrySync: "Retry AI worker sync",
    continueOffline: "Continue offline",
    signOut: "Sign out",
  },
  zh: {
    restoringSession: "正在恢复 OysterWorkflow 会话……",
    syncingTitle: "正在同步你的 AI Worker",
    syncErrorTitle: "AI Worker 同步需要处理",
    syncingBody: (email: string) =>
      `正在为 ${email} 准备 AI Worker 和这台电脑。`,
    retrySync: "重试 AI Worker 同步",
    continueOffline: "继续离线使用",
    signOut: "退出登录",
  },
} as const;

function loadAuthLanguage(): AppLanguage {
  try {
    return normalizeAppLanguage(
      window.localStorage.getItem("oysterworkflow.app-language"),
    );
  } catch {
    return DEFAULT_APP_LANGUAGE;
  }
}

function changeAuthLanguage(
  language: AppLanguage,
  onChange: (language: AppLanguage) => void,
): void {
  try {
    window.localStorage.setItem("oysterworkflow.app-language", language);
  } catch {
    // EN/中文: Language storage failure does not block authentication.
  }
  onChange(language);
}

function friendlyAuthError(error: unknown, language: AppLanguage): string {
  const raw = toErrorMessage(error);
  if (/invalid login credentials/iu.test(raw)) {
    return language === "zh"
      ? "邮箱或密码不正确。"
      : "The email or password is incorrect.";
  }
  if (/email not confirmed/iu.test(raw)) {
    return language === "zh"
      ? "请先打开邮箱中的确认链接。"
      : "Confirm your email before signing in.";
  }
  if (/provider is not enabled|unsupported provider/iu.test(raw)) {
    return language === "zh"
      ? "Google 登录尚未完成配置。"
      : "Google sign-in is not configured yet.";
  }
  if (/fetch failed|failed to fetch|network request failed/iu.test(raw)) {
    return language === "zh"
      ? "Google 已返回 OysterWorkflow，但暂时无法连接认证服务。请检查网络后重试。"
      : "Google returned to OysterWorkflow, but the authentication service could not be reached. Check your connection and try again.";
  }
  return raw;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

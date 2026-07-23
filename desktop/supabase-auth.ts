import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { safeStorage } from "electron";
import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  OYSTER_AUTH_CALLBACK_URL,
  OYSTER_SUPABASE_PUBLISHABLE_KEY,
  OYSTER_SUPABASE_URL,
} from "../src/cloud/config.js";
import { createDeadlineFetch } from "../src/cloud/bounded-fetch.js";
import type {
  CloudAuthActionResponse,
  CloudAuthState,
  CloudAuthUser,
  CloudEmailAuthInput,
  CloudSignUpResponse,
} from "../src/cloud/contracts.js";

interface EncryptedStorageFile {
  version: 1;
  values: Record<string, string>;
}

interface SupabaseDesktopAuthServiceInput {
  storagePath: string;
  openExternal: (url: string) => Promise<void>;
  onStateChanged?: (state: CloudAuthState) => void;
  client?: SupabaseClient;
  authOperationTimeoutMs?: number;
}

const DEFAULT_AUTH_OPERATION_TIMEOUT_MS = 30_000;

/**
 * EN: Persists Supabase Auth values encrypted by Electron safeStorage.
 * 中文: 使用 Electron safeStorage 加密并持久化 Supabase Auth 数据。
 */
export class EncryptedFileAuthStorage {
  private readonly storagePath: string;
  private valuesPromise: Promise<Record<string, string>> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  async getItem(key: string): Promise<string | null> {
    const values = await this.loadValues();
    const encrypted = values[key];
    if (!encrypted) {
      return null;
    }
    this.requireEncryption();
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
    } catch {
      await this.removeItem(key);
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    this.requireEncryption();
    await this.enqueueWrite(async (values) => {
      values[key] = safeStorage.encryptString(value).toString("base64");
    });
  }

  async removeItem(key: string): Promise<void> {
    await this.enqueueWrite(async (values) => {
      delete values[key];
    });
  }

  private async loadValues(): Promise<Record<string, string>> {
    if (!this.valuesPromise) {
      const attempt = (async () => {
        try {
          const parsed = JSON.parse(
            await readFile(this.storagePath, "utf8"),
          ) as Partial<EncryptedStorageFile>;
          if (
            parsed.version !== 1 ||
            typeof parsed.values !== "object" ||
            parsed.values === null ||
            Array.isArray(parsed.values)
          ) {
            return {};
          }
          return Object.fromEntries(
            Object.entries(parsed.values).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          );
        } catch (error) {
          if (error instanceof SyntaxError) {
            return {};
          }
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return {};
          }
          throw error;
        }
      })();
      this.valuesPromise = attempt;
      try {
        return await attempt;
      } catch (error) {
        if (this.valuesPromise === attempt) {
          this.valuesPromise = null;
        }
        throw error;
      }
    }
    return this.valuesPromise;
  }

  private async enqueueWrite(
    mutator: (values: Record<string, string>) => void | Promise<void>,
  ): Promise<void> {
    const run = async () => {
      const values = await this.loadValues();
      const nextValues = { ...values };
      await mutator(nextValues);
      await mkdir(dirname(this.storagePath), { recursive: true, mode: 0o700 });
      const payload: EncryptedStorageFile = {
        version: 1,
        values: nextValues,
      };
      const temporaryPath = `${this.storagePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporaryPath, this.storagePath);
        this.valuesPromise = Promise.resolve(nextValues);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private requireEncryption(): void {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "Secure credential storage is unavailable on this computer. Sign-in was stopped to protect your session.",
      );
    }
  }
}

/**
 * EN: Owns the desktop Supabase Auth session, PKCE exchange, and secure storage.
 * 中文: 管理桌面端 Supabase Auth session、PKCE 交换和安全存储。
 */
export class SupabaseDesktopAuthService {
  private readonly client: SupabaseClient;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly onStateChanged?: (state: CloudAuthState) => void;
  private readonly authOperationTimeoutMs: number;
  private state: CloudAuthState = signedOutState("loading");
  private accessTokenSnapshot: string | null = null;
  private initializedPromise: Promise<CloudAuthState> | null = null;
  private mutationInFlight: Promise<void> | null = null;
  private mutationGeneration = 0;

  constructor(input: SupabaseDesktopAuthServiceInput) {
    this.openExternal = input.openExternal;
    this.onStateChanged = input.onStateChanged;
    this.authOperationTimeoutMs = normalizeAuthOperationTimeout(
      input.authOperationTimeoutMs,
    );
    if (input.client) {
      this.client = input.client;
    } else {
      const storage = new EncryptedFileAuthStorage(input.storagePath);
      this.client = createClient(
        OYSTER_SUPABASE_URL,
        OYSTER_SUPABASE_PUBLISHABLE_KEY,
        {
          auth: {
            flowType: "pkce",
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            storage,
          },
          global: {
            fetch: createDeadlineFetch({
              timeoutMs: this.authOperationTimeoutMs,
              timeoutMessage:
                "The authentication network request timed out. / 认证网络请求超时。",
            }),
          },
        },
      );
    }
    this.client.auth.onAuthStateChange((event, session) => {
      if (
        event !== "TOKEN_REFRESHED" ||
        !session ||
        this.state.status !== "signed_in" ||
        this.state.user?.id !== session.user.id
      ) {
        return;
      }
      this.setSessionState(session);
    });
  }

  /**
   * EN: Restores and verifies the persisted Supabase session.
   * 中文: 恢复并验证已持久化的 Supabase session。
   */
  async initialize(): Promise<CloudAuthState> {
    if (!this.initializedPromise) {
      const attempt = (async () => {
        const { data, error } = await this.runWithDeadline(
          "restoring the saved session / 恢复已保存的会话",
          () => this.client.auth.getSession(),
        );
        if (error) {
          throw new Error(error.message);
        }
        if (!data.session) {
          this.setState(signedOutState());
          return this.state;
        }
        const { data: userData, error: userError } = await this.runWithDeadline(
          "verifying the saved session / 验证已保存的会话",
          () => this.client.auth.getUser(data.session.access_token),
        );
        if (userError || !userData.user) {
          await this.runWithDeadline(
            "clearing an invalid saved session / 清除无效会话",
            () => this.client.auth.signOut({ scope: "local" }),
          ).catch(() => undefined);
          this.setState(signedOutState());
          return this.state;
        }
        this.setSessionState(data.session);
        return this.state;
      })();
      this.initializedPromise = attempt;
      try {
        return await attempt;
      } catch (error) {
        if (this.initializedPromise === attempt) {
          this.initializedPromise = null;
        }
        throw error;
      }
    }
    return this.initializedPromise;
  }

  async getState(): Promise<CloudAuthState> {
    await this.initialize();
    return this.state;
  }

  getStateSnapshot(): CloudAuthState {
    return this.state;
  }

  async signUp(input: CloudEmailAuthInput): Promise<CloudSignUpResponse> {
    await this.initialize();
    const email = input.email.trim().toLowerCase();
    const { data, error } = await this.runMutation(
      "creating the account / 创建账户",
      () =>
        this.client.auth.signUp({
          email,
          password: input.password,
          options: {
            emailRedirectTo: OYSTER_AUTH_CALLBACK_URL,
            data: input.displayName?.trim()
              ? { display_name: input.displayName.trim() }
              : undefined,
          },
        }),
    );
    if (error) {
      throw new Error(error.message);
    }
    const state = authStateFromSession(data.session);
    this.setStateFromSession(data.session);
    return {
      state,
      requiresEmailConfirmation: !data.session,
      email,
    };
  }

  async signIn(input: CloudEmailAuthInput): Promise<CloudAuthActionResponse> {
    await this.initialize();
    const { data, error } = await this.runMutation("signing in / 登录", () =>
      this.client.auth.signInWithPassword({
        email: input.email.trim().toLowerCase(),
        password: input.password,
      }),
    );
    if (error) {
      throw new Error(error.message);
    }
    const state = authStateFromSession(data.session);
    this.setStateFromSession(data.session);
    return { state };
  }

  async startGoogleSignIn(): Promise<CloudAuthActionResponse> {
    await this.initialize();
    const { data, error } = await this.runMutation(
      "starting Google sign-in / 启动 Google 登录",
      () =>
        this.client.auth.signInWithOAuth({
          provider: "google",
          options: {
            redirectTo: OYSTER_AUTH_CALLBACK_URL,
            skipBrowserRedirect: true,
          },
        }),
    );
    if (error) {
      throw new Error(error.message);
    }
    if (!data.url) {
      throw new Error("Google did not return an authorization URL.");
    }
    await this.runWithDeadline(
      "opening Google sign-in / 打开 Google 登录",
      () => this.openExternal(data.url),
    );
    this.setState(signedOutState("oauth_pending"));
    return { state: this.state };
  }

  async handleOAuthCallback(rawUrl: string): Promise<CloudAuthState> {
    await this.initialize();
    const callback = new URL(rawUrl);
    if (
      callback.protocol !== "oysterworkflow:" ||
      callback.hostname !== "auth" ||
      callback.pathname !== "/callback"
    ) {
      throw new Error("Rejected an invalid OysterWorkflow authentication URL.");
    }
    const oauthError =
      callback.searchParams.get("error_description") ??
      callback.searchParams.get("error");
    if (oauthError) {
      this.setState(signedOutState());
      throw new Error(oauthError);
    }
    const code = callback.searchParams.get("code");
    if (!code) {
      throw new Error("The authentication callback did not include a code.");
    }
    const { data, error } = await this.runMutation(
      "finishing Google sign-in / 完成 Google 登录",
      () => this.client.auth.exchangeCodeForSession(code),
    );
    if (error) {
      this.setState(signedOutState());
      throw new Error(error.message);
    }
    const state = authStateFromSession(data.session);
    this.setSessionState(data.session);
    return state;
  }

  async signOut(): Promise<CloudAuthActionResponse> {
    await this.initialize();
    const { error } = await this.runMutation("signing out / 退出登录", () =>
      this.client.auth.signOut(),
    );
    if (error) {
      throw new Error(error.message);
    }
    this.setState(signedOutState());
    return { state: this.state };
  }

  async getAccessToken(): Promise<string> {
    await this.initialize();
    const accessToken = this.getAccessTokenSnapshot();
    if (!accessToken) {
      throw new Error("Sign in before syncing this device.");
    }
    return accessToken;
  }

  getAccessTokenSnapshot(): string | null {
    return this.state.status === "signed_in" ? this.accessTokenSnapshot : null;
  }

  /**
   * EN: Returns a cloud token when signed in without making local Runtime access depend on cloud auth.
   * 中文: 已登录时返回云 token，同时不让本地 Runtime 访问依赖云登录。
   * @returns current access token or null for an offline/signed-out user.
   */
  async getAccessTokenIfAvailable(): Promise<string | null> {
    return this.getAccessTokenSnapshot();
  }

  private async runMutation<T>(
    label: string,
    operation: () => PromiseLike<T>,
  ): Promise<T> {
    if (this.mutationInFlight) {
      throw new Error(
        "A previous authentication request is still finishing. Wait a moment and try again. / 上一次认证请求仍在结束，请稍后重试。",
      );
    }
    const generation = ++this.mutationGeneration;
    const rawOperation = Promise.resolve().then(operation);
    const settlement = rawOperation.then(
      () => undefined,
      () => undefined,
    );
    this.mutationInFlight = settlement;
    void settlement.then(() => {
      if (this.mutationInFlight === settlement) {
        this.mutationInFlight = null;
      }
    });
    try {
      const result = await this.waitWithDeadline(rawOperation, label);
      if (this.mutationGeneration !== generation) {
        throw new Error(
          "The authentication request was superseded. Try again. / 认证请求已被后续操作取代，请重试。",
        );
      }
      return result;
    } catch (error) {
      if (this.mutationGeneration === generation) {
        this.mutationGeneration += 1;
      }
      throw error;
    }
  }

  private runWithDeadline<T>(
    label: string,
    operation: () => PromiseLike<T>,
  ): Promise<T> {
    return this.waitWithDeadline(Promise.resolve().then(operation), label);
  }

  private async waitWithDeadline<T>(
    operation: PromiseLike<T>,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Timed out while ${label}. Try again. / ${label}超时，请重试。`,
          ),
        );
      }, this.authOperationTimeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve(operation), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private setStateFromSession(session: Session | null): void {
    if (session) {
      this.setSessionState(session);
      return;
    }
    this.setState(signedOutState());
  }

  private setSessionState(session: Session): void {
    this.accessTokenSnapshot = session.access_token;
    this.setState(authStateFromSession(session));
  }

  private setState(state: CloudAuthState): void {
    if (state.status !== "signed_in") {
      this.accessTokenSnapshot = null;
    }
    this.state = state;
    this.onStateChanged?.(state);
  }
}

function normalizeAuthOperationTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_AUTH_OPERATION_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Auth operation timeout must be positive.");
  }
  return Math.floor(value);
}

function signedOutState(
  status: CloudAuthState["status"] = "signed_out",
): CloudAuthState {
  return {
    status,
    configured: true,
    user: null,
    expiresAt: null,
  };
}

function authStateFromSession(session: Session | null): CloudAuthState {
  if (!session) {
    return signedOutState();
  }
  const metadata = session.user.user_metadata;
  const displayName = stringOrNull(
    metadata.display_name ?? metadata.full_name ?? metadata.name,
  );
  const user: CloudAuthUser = {
    id: session.user.id,
    email: session.user.email ?? "",
    displayName,
    provider: stringOrNull(session.user.app_metadata.provider),
    createdAt: session.user.created_at ?? null,
  };
  return {
    status: "signed_in",
    configured: true,
    user,
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

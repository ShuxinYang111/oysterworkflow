import {
  createClient,
  type Session,
  type SupabaseClient,
} from "@supabase/supabase-js";
import {
  OYSTER_SUPABASE_PUBLISHABLE_KEY,
  OYSTER_SUPABASE_URL,
} from "../../src/cloud/config.js";
import { createDeadlineFetch } from "../../src/cloud/bounded-fetch.js";
import type {
  CloudAuthActionResponse,
  CloudAuthState,
  CloudEmailAuthInput,
  CloudSignUpResponse,
  CloudSyncMode,
  CloudSyncResult,
} from "../../src/cloud/contracts.js";
import {
  buildApiUrl,
  getDesktopAuthBridge,
  syncDesktopCloudState,
} from "./runtime-env";
import { withAsyncDeadline } from "./async-deadline";

const CLOUD_AUTH_TIMEOUT_MS = 30_000;
const CLOUD_AUTH_TIMEOUT_MESSAGE =
  "The cloud service did not respond in time. Try again or continue offline. / 云服务响应超时，请重试或继续离线使用。";

export interface CloudAuthClient {
  getState: (signal?: AbortSignal) => Promise<CloudAuthState>;
  signUp: (
    input: CloudEmailAuthInput,
    signal?: AbortSignal,
  ) => Promise<CloudSignUpResponse>;
  signIn: (
    input: CloudEmailAuthInput,
    signal?: AbortSignal,
  ) => Promise<CloudAuthActionResponse>;
  continueWithGoogle: (
    signal?: AbortSignal,
  ) => Promise<CloudAuthActionResponse>;
  signOut: (signal?: AbortSignal) => Promise<CloudAuthActionResponse>;
  sync: (
    mode?: CloudSyncMode,
    signal?: AbortSignal,
  ) => Promise<CloudSyncResult>;
  onStateChanged: (listener: (state: CloudAuthState) => void) => () => void;
  onError: (listener: (message: string) => void) => () => void;
}

let browserClient: SupabaseClient | null = null;
let browserCallbackPromise: Promise<void> | null = null;

/**
 * EN: Creates the renderer-facing Auth client. Packaged builds use the narrow
 * Electron bridge; browser development uses Supabase directly.
 * 中文: 创建 renderer 使用的 Auth client。打包版走 Electron 窄接口，浏览器
 * 开发态直接连接 Supabase。
 */
export function createCloudAuthClient(): CloudAuthClient {
  const desktop = getDesktopAuthBridge();
  if (
    desktop?.getState &&
    desktop.signUp &&
    desktop.signIn &&
    desktop.continueWithGoogle &&
    desktop.signOut
  ) {
    return withCloudAuthDeadlines({
      getState: () => desktop.getState!(),
      signUp: (input) => desktop.signUp!(input),
      signIn: (input) => desktop.signIn!(input),
      continueWithGoogle: () => desktop.continueWithGoogle!(),
      signOut: () => desktop.signOut!(),
      sync: (mode, signal) =>
        syncDesktopCloudState(mode, {
          signal,
          timeoutMs: CLOUD_AUTH_TIMEOUT_MS,
        }),
      onStateChanged: (listener) =>
        desktop.onStateChanged?.(listener) ?? (() => undefined),
      onError: (listener) => desktop.onError?.(listener) ?? (() => undefined),
    });
  }
  return withCloudAuthDeadlines(createBrowserDevelopmentAuthClient());
}

function createBrowserDevelopmentAuthClient(): CloudAuthClient {
  const client = getBrowserClient();
  return {
    getState: async (signal) => {
      const operationClient = createBrowserOperationClient(signal);
      await exchangeBrowserCallback(operationClient);
      const { data, error } = await operationClient.auth.getSession();
      if (error) {
        throw new Error(error.message);
      }
      return authStateFromSession(data.session);
    },
    signUp: async (input, signal) => {
      const operationClient = createBrowserOperationClient(signal);
      const email = input.email.trim().toLowerCase();
      const { data, error } = await operationClient.auth.signUp({
        email,
        password: input.password,
        options: {
          emailRedirectTo: window.location.origin,
          data: input.displayName?.trim()
            ? { display_name: input.displayName.trim() }
            : undefined,
        },
      });
      if (error) {
        throw new Error(error.message);
      }
      return {
        state: authStateFromSession(data.session),
        requiresEmailConfirmation: !data.session,
        email,
      };
    },
    signIn: async (input, signal) => {
      const operationClient = createBrowserOperationClient(signal);
      const { data, error } = await operationClient.auth.signInWithPassword({
        email: input.email.trim().toLowerCase(),
        password: input.password,
      });
      if (error) {
        throw new Error(error.message);
      }
      return { state: authStateFromSession(data.session) };
    },
    continueWithGoogle: async (signal) => {
      const operationClient = createBrowserOperationClient(signal);
      const { data, error } = await operationClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) {
        throw new Error(error.message);
      }
      return {
        state: data.url
          ? {
              status: "oauth_pending",
              configured: true,
              user: null,
              expiresAt: null,
            }
          : authStateFromSession(null),
      };
    },
    signOut: async (signal) => {
      const operationClient = createBrowserOperationClient(signal);
      const { error } = await operationClient.auth.signOut();
      if (error) {
        throw new Error(error.message);
      }
      return { state: authStateFromSession(null) };
    },
    sync: async (mode = "pull", signal) => {
      const operationClient = createBrowserOperationClient(signal);
      const { data, error } = await operationClient.auth.getSession();
      if (error || !data.session) {
        throw new Error(
          error?.message ?? "Sign in before syncing this device.",
        );
      }
      const authenticatedState = authStateFromSession(data.session);
      const authenticatedUser = authenticatedState.user;
      if (!authenticatedUser) {
        throw new Error("Sign in before syncing this device.");
      }
      const response = await fetch(buildApiUrl("/api/product/cloud/sync"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${data.session.access_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          mode,
          authenticatedUser: {
            id: authenticatedUser.id,
            email: authenticatedUser.email,
            displayName: authenticatedUser.displayName,
          },
        }),
        signal,
      });
      const body = (await response.json()) as
        CloudSyncResult | { error?: string | { message?: string } };
      if (!response.ok) {
        const errorValue = "error" in body ? body.error : null;
        throw new Error(
          typeof errorValue === "string"
            ? errorValue
            : (errorValue?.message ??
                `Cloud sync failed (${response.status}).`),
        );
      }
      return body as CloudSyncResult;
    },
    onStateChanged: (listener) => {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (event !== "TOKEN_REFRESHED") {
          return;
        }
        listener(authStateFromSession(session));
      });
      return () => data.subscription.unsubscribe();
    },
    onError: () => () => undefined,
  };
}

/**
 * EN: Adds a recoverable deadline to browser fetches and Electron IPC auth calls.
 * 中文: 为浏览器请求与 Electron IPC 认证调用统一增加可恢复截止时间。
 * @param client auth implementation for the active environment.
 * @returns deadline-protected auth client.
 */
function withCloudAuthDeadlines(client: CloudAuthClient): CloudAuthClient {
  let mutationInFlight: Promise<unknown> | null = null;
  const run = <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ) =>
    withAsyncDeadline(operation, {
      timeoutMs: CLOUD_AUTH_TIMEOUT_MS,
      timeoutMessage: CLOUD_AUTH_TIMEOUT_MESSAGE,
      signal,
    });
  const runMutation = <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> =>
    run((signal) => {
      if (mutationInFlight) {
        throw new Error(
          "A previous authentication request is still finishing. Wait a moment and try again. / 上一次认证请求仍在结束，请稍后重试。",
        );
      }
      const request = Promise.resolve().then(() => operation(signal));
      mutationInFlight = request;
      void request.then(
        () => {
          if (mutationInFlight === request) {
            mutationInFlight = null;
          }
        },
        () => {
          if (mutationInFlight === request) {
            mutationInFlight = null;
          }
        },
      );
      return request;
    }, signal);
  return {
    getState: (signal) =>
      run((deadlineSignal) => client.getState(deadlineSignal), signal),
    signUp: (input, signal) =>
      runMutation(
        (deadlineSignal) => client.signUp(input, deadlineSignal),
        signal,
      ),
    signIn: (input, signal) =>
      runMutation(
        (deadlineSignal) => client.signIn(input, deadlineSignal),
        signal,
      ),
    continueWithGoogle: (signal) =>
      runMutation(
        (deadlineSignal) => client.continueWithGoogle(deadlineSignal),
        signal,
      ),
    signOut: (signal) =>
      runMutation((deadlineSignal) => client.signOut(deadlineSignal), signal),
    sync: (mode, signal) =>
      run((deadlineSignal) => client.sync(mode, deadlineSignal), signal),
    onStateChanged: client.onStateChanged,
    onError: client.onError,
  };
}

function getBrowserClient(): SupabaseClient {
  browserClient ??= createBrowserSupabaseClient(undefined, true);
  return browserClient;
}

function createBrowserOperationClient(signal?: AbortSignal): SupabaseClient {
  return createBrowserSupabaseClient(signal, false);
}

function createBrowserSupabaseClient(
  signal: AbortSignal | undefined,
  autoRefreshToken: boolean,
): SupabaseClient {
  return createClient(OYSTER_SUPABASE_URL, OYSTER_SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      flowType: "pkce",
      persistSession: true,
      autoRefreshToken,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createDeadlineFetch({
        timeoutMs: CLOUD_AUTH_TIMEOUT_MS,
        timeoutMessage: CLOUD_AUTH_TIMEOUT_MESSAGE,
        signal,
      }),
    },
  });
}

export async function exchangeBrowserCallback(
  client: SupabaseClient,
): Promise<void> {
  const code = new URL(window.location.href).searchParams.get("code");
  if (!code) {
    return;
  }
  if (!browserCallbackPromise) {
    const attempt = (async () => {
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (error) {
        throw new Error(error.message);
      }
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("code");
      window.history.replaceState({}, "", cleanUrl.toString());
    })();
    browserCallbackPromise = attempt;
    void attempt
      .finally(() => {
        if (browserCallbackPromise === attempt) {
          browserCallbackPromise = null;
        }
      })
      .catch(() => undefined);
  }
  await browserCallbackPromise;
}

function authStateFromSession(session: Session | null): CloudAuthState {
  if (!session) {
    return {
      status: "signed_out",
      configured: true,
      user: null,
      expiresAt: null,
    };
  }
  const metadata = session.user.user_metadata;
  return {
    status: "signed_in",
    configured: true,
    user: {
      id: session.user.id,
      email: session.user.email ?? "",
      displayName: optionalString(
        metadata.display_name ?? metadata.full_name ?? metadata.name,
      ),
      provider: optionalString(session.user.app_metadata.provider),
      createdAt: session.user.created_at ?? null,
    },
    expiresAt: session.expires_at
      ? new Date(session.expires_at * 1000).toISOString()
      : null,
  };
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

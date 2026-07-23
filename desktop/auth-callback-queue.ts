export interface AuthCallbackQueueOptions {
  handleCallback: (rawUrl: string) => Promise<void>;
  onCallbackHandled?: (rawUrl: string) => Promise<void> | void;
  onCallbackError?: (error: unknown, rawUrl: string) => Promise<void> | void;
}

export interface AuthCallbackQueue {
  enqueue: (rawUrl: string) => boolean;
  markReady: () => Promise<void>;
  flush: () => Promise<void>;
}

/**
 * EN: Serializes desktop OAuth callbacks behind authentication initialization.
 * 中文: 在认证初始化完成后，串行处理桌面 OAuth 回调。
 * @param options callback handler and result observers.
 * @returns a gated callback queue shared by all Electron callback entrypoints.
 */
export function createAuthCallbackQueue(
  options: AuthCallbackQueueOptions,
): AuthCallbackQueue {
  const pendingUrls: string[] = [];
  const observedUrls = new Set<string>();
  let ready = false;
  let flushPromise: Promise<void> | null = null;

  const flush = (): Promise<void> => {
    if (!ready) {
      return Promise.resolve();
    }
    if (flushPromise) {
      return flushPromise;
    }

    flushPromise = (async () => {
      while (ready && pendingUrls.length > 0) {
        const rawUrl = pendingUrls.shift();
        if (!rawUrl) continue;
        try {
          await options.handleCallback(rawUrl);
          await options.onCallbackHandled?.(rawUrl);
        } catch (error) {
          observedUrls.delete(rawUrl);
          await options.onCallbackError?.(error, rawUrl);
        }
      }
    })().finally(() => {
      flushPromise = null;
      if (ready && pendingUrls.length > 0) {
        void flush();
      }
    });
    return flushPromise;
  };

  return {
    enqueue: (rawUrl) => {
      if (!isAuthenticationCallbackUrl(rawUrl) || observedUrls.has(rawUrl)) {
        return false;
      }
      observedUrls.add(rawUrl);
      pendingUrls.push(rawUrl);
      void flush();
      return true;
    },
    markReady: async () => {
      ready = true;
      await flush();
    },
    flush,
  };
}

/**
 * EN: Accepts only the exact custom-protocol route owned by OysterWorkflow.
 * 中文: 仅接受 OysterWorkflow 自有的精确自定义协议回调路径。
 * @param rawUrl candidate callback URL received by Electron.
 * @returns whether the URL is an OysterWorkflow authentication callback.
 */
export function isAuthenticationCallbackUrl(rawUrl: string): boolean {
  try {
    const callback = new URL(rawUrl);
    return (
      callback.protocol === "oysterworkflow:" &&
      callback.hostname === "auth" &&
      callback.pathname === "/callback"
    );
  } catch {
    return false;
  }
}

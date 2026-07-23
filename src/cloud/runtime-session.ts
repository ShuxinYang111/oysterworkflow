import { AsyncLocalStorage } from "node:async_hooks";

/**
 * EN: Exposes the Supabase access token bound to the current Runtime request.
 * 中文: 暴露绑定到当前 Runtime 请求的 Supabase access token。
 */
export interface RuntimeCloudSession {
  getAccessToken: () => string | null;
  runWithAccessToken: <T>(accessToken: string | null, callback: () => T) => T;
}

/**
 * EN: Creates a request-scoped cloud session shared by Runtime routes and hosted integrations.
 * 中文: 创建由 Runtime 路由与云端集成共享的请求级云会话。
 * @returns AsyncLocalStorage-backed request credential context.
 */
export function createRuntimeCloudSession(): RuntimeCloudSession {
  const storage = new AsyncLocalStorage<{ accessToken: string | null }>();
  return {
    getAccessToken: () => storage.getStore()?.accessToken ?? null,
    runWithAccessToken: (accessToken, callback) =>
      storage.run(
        {
          accessToken: accessToken?.trim() || null,
        },
        callback,
      ),
  };
}

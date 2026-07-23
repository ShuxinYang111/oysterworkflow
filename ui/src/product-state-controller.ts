import { useCallback, useRef, useState } from "react";

export interface ProductRefreshToken {
  generation: number;
  requestId: number;
}

export interface ProductRefreshResult<T> {
  snapshot: T | null;
  committed: boolean;
  error: unknown | null;
}

interface ProductRefreshOptions<T> {
  mergeSnapshot?: (snapshot: T, current: T | null) => T;
  formatError?: (error: unknown) => string;
}

interface ActiveProductRefresh<T> {
  generation: number;
  promise: Promise<ProductRefreshResult<T>>;
}

interface QueuedProductRefresh<T> {
  generation: number;
  load: () => Promise<T>;
  options: ProductRefreshOptions<T>;
}

/**
 * EN: Owns authoritative product state and enforces latest-wins background refreshes.
 * 中文: 管理权威产品状态，并保证后台刷新只提交最新响应。
 * @returns product state, error state, and mutation/refresh commit operations.
 */
export function useProductStateController<T>() {
  const [state, setState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const requestIdRef = useRef(0);
  const activeRefreshRef = useRef<ActiveProductRefresh<T> | null>(null);
  const queuedRefreshRef = useRef<QueuedProductRefresh<T> | null>(null);

  const invalidate = useCallback((): void => {
    generationRef.current += 1;
    requestIdRef.current += 1;
  }, []);

  const applySnapshot = useCallback((snapshot: T): void => {
    generationRef.current += 1;
    requestIdRef.current += 1;
    setError(null);
    setState(snapshot);
  }, []);

  const beginRefresh = useCallback((): ProductRefreshToken => {
    requestIdRef.current += 1;
    return {
      generation: generationRef.current,
      requestId: requestIdRef.current,
    };
  }, []);

  const isCurrent = useCallback((token: ProductRefreshToken): boolean => {
    return (
      token.generation === generationRef.current &&
      token.requestId === requestIdRef.current
    );
  }, []);

  const commitRefresh = useCallback(
    (
      token: ProductRefreshToken,
      snapshot: T | ((current: T | null) => T),
    ): boolean => {
      if (!isCurrent(token)) {
        return false;
      }
      setError(null);
      setState(snapshot);
      return true;
    },
    [isCurrent],
  );

  const failRefresh = useCallback(
    (token: ProductRefreshToken, message: string): boolean => {
      if (!isCurrent(token)) {
        return false;
      }
      setError(message);
      return true;
    },
    [isCurrent],
  );

  const getGeneration = useCallback(() => generationRef.current, []);

  const runRefresh = useCallback(
    (
      load: () => Promise<T>,
      options: ProductRefreshOptions<T> = {},
    ): Promise<ProductRefreshResult<T>> => {
      const requestedRefresh: QueuedProductRefresh<T> = {
        generation: generationRef.current,
        load,
        options,
      };
      const startRefresh = (
        requested: QueuedProductRefresh<T>,
      ): Promise<ProductRefreshResult<T>> => {
        const token = beginRefresh();
        const task = (async (): Promise<ProductRefreshResult<T>> => {
          try {
            const snapshot = await requested.load();
            const committed = commitRefresh(
              token,
              requested.options.mergeSnapshot
                ? (current) =>
                    requested.options.mergeSnapshot!(snapshot, current)
                : snapshot,
            );
            return { snapshot, committed, error: null };
          } catch (error) {
            const message = requested.options.formatError
              ? requested.options.formatError(error)
              : error instanceof Error
                ? error.message
                : String(error);
            const committed = failRefresh(token, message);
            return { snapshot: null, committed, error };
          }
        })().finally(() => {
          if (activeRefreshRef.current?.promise === task) {
            activeRefreshRef.current = null;
          }
        });
        activeRefreshRef.current = {
          generation: token.generation,
          promise: task,
        };
        return task;
      };

      const active = activeRefreshRef.current;
      if (!active) {
        queuedRefreshRef.current = null;
        return startRefresh(requestedRefresh);
      }
      if (active.generation === generationRef.current) {
        return active.promise;
      }
      queuedRefreshRef.current = requestedRefresh;
      return active.promise.then(() => {
        const activeAfterSettle = activeRefreshRef.current;
        if (activeAfterSettle) {
          return activeAfterSettle.promise;
        }
        const queued = queuedRefreshRef.current;
        if (!queued || queued.generation !== generationRef.current) {
          queuedRefreshRef.current = null;
          return { snapshot: null, committed: false, error: null };
        }
        queuedRefreshRef.current = null;
        return startRefresh(queued);
      });
    },
    [beginRefresh, commitRefresh, failRefresh],
  );

  return {
    state,
    error,
    applySnapshot,
    beginRefresh,
    commitRefresh,
    failRefresh,
    getGeneration,
    invalidate,
    isCurrent,
    runRefresh,
  };
}

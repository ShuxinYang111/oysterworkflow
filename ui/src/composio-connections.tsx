import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProductComposioConnection,
  ProductComposioOverviewResponse,
  ProductComposioToolkit,
  ProductComposioToolkitFilter,
} from "../../src/product/contracts.js";
import type { AppLanguage } from "./app-language";
import {
  authorizeProductComposioToolkit,
  disconnectProductComposioConnection,
  fetchProductComposioConnection,
  fetchProductComposioOverview,
} from "./product-runtime";
import { openExternalUrl } from "./runtime-env";
import { useSettledPolling } from "./settled-polling";
import { useTopmostModal } from "./modal-focus";

interface ComposioConnectionsProps {
  language: AppLanguage;
}

interface AuthorizationFlow {
  toolkit: ProductComposioToolkit;
  connectionId: string;
  status: string;
  errorMessage: string | null;
}

const COPY = {
  en: {
    eyebrow: "Application connections",
    title: "Connect applications",
    description:
      "Connect accounts so AI workers can use them while running workflows.",
    configured: "Connections ready",
    unavailable:
      "Application connections are temporarily unavailable. Sign in again or try later.",
    cancel: "Cancel",
    close: "Close",
    searchPlaceholder: "Search every available application...",
    filters: {
      all: "All",
      connected: "Connected",
      not_connected: "Not connected",
    },
    connected: "Connected",
    available: "Available",
    connect: "Connect",
    manage: "Manage",
    loading: "Loading the application catalog...",
    empty: "No applications match this search.",
    retry: "Try again",
    loadMore: "Load more applications",
    loadingMore: "Loading more...",
    showing: (count: number) => `${count} applications loaded`,
    filtersAria: "Connection filter",
    authTitle: (name: string) => `Connect ${name}`,
    authOpening: "Opening the secure authorization page in your browser.",
    authWaiting:
      "Finish signing in there. This page checks the connection automatically.",
    authActive:
      "Connection complete. This application is ready for AI workers.",
    authFailed: "The connection did not complete.",
    reopen: "Open authorization page again",
    done: "Done",
    manageTitle: (name: string) => `${name} connections`,
    manageDescription: "Manage the accounts available to AI workers.",
    disconnect: "Disconnect",
    disconnecting: "Disconnecting...",
    noConnections: "No authenticated accounts are connected.",
  },
  zh: {
    eyebrow: "应用连接",
    title: "连接应用",
    description: "连接账号，让 AI Worker 在运行工作流时使用这些应用。",
    configured: "连接服务已就绪",
    unavailable: "应用连接服务暂时不可用，请重新登录或稍后重试。",
    cancel: "取消",
    close: "关闭",
    searchPlaceholder: "搜索全部可用应用……",
    filters: {
      all: "全部",
      connected: "已连接",
      not_connected: "未连接",
    },
    connected: "已连接",
    available: "可连接",
    connect: "连接",
    manage: "管理",
    loading: "正在加载应用目录……",
    empty: "没有符合当前搜索的应用。",
    retry: "重试",
    loadMore: "加载更多应用",
    loadingMore: "加载中……",
    showing: (count: number) => `已加载 ${count} 个应用`,
    filtersAria: "连接筛选",
    authTitle: (name: string) => `连接 ${name}`,
    authOpening: "正在用系统浏览器打开安全授权页面。",
    authWaiting: "请在浏览器中完成登录，本页面会自动检查连接状态。",
    authActive: "连接完成，AI Worker 现在可以使用此应用。",
    authFailed: "连接未完成。",
    reopen: "重新打开授权页面",
    done: "完成",
    manageTitle: (name: string) => `${name} 连接管理`,
    manageDescription: "管理 AI Worker 可以使用的账号。",
    disconnect: "断开连接",
    disconnecting: "正在断开……",
    noConnections: "当前没有已认证账号。",
  },
} as const;

export function ComposioConnections(input: ComposioConnectionsProps) {
  const copy = COPY[input.language];
  const [overview, setOverview] =
    useState<ProductComposioOverviewResponse | null>(null);
  const [items, setItems] = useState<ProductComposioToolkit[]>([]);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<ProductComposioToolkitFilter>("all");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [authorization, setAuthorization] = useState<AuthorizationFlow | null>(
    null,
  );
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [authorizationBusySlug, setAuthorizationBusySlug] = useState<
    string | null
  >(null);
  const [managedToolkit, setManagedToolkit] =
    useState<ProductComposioToolkit | null>(null);
  const [disconnectingId, setDisconnectingId] = useState<string | null>(null);
  const queryGenerationRef = useRef(0);
  const connectionMutationInFlightRef = useRef(false);
  const authorizationDialogRef = useRef<HTMLElement>(null);
  const manageDialogRef = useRef<HTMLElement>(null);

  useTopmostModal({
    open: authorization !== null,
    containerRef: authorizationDialogRef,
    onClose: () => setAuthorization(null),
  });
  useTopmostModal({
    open: managedToolkit !== null,
    containerRef: manageDialogRef,
    onClose: () => setManagedToolkit(null),
  });

  const invalidateCatalogQuery = () => {
    queryGenerationRef.current += 1;
    setLoadingMore(false);
  };

  const reloadCatalog = () => {
    invalidateCatalogQuery();
    setReloadToken((value) => value + 1);
  };

  useEffect(() => {
    if (searchDraft.trim() === search) {
      return;
    }
    const timeout = window.setTimeout(() => {
      const nextSearch = searchDraft.trim();
      invalidateCatalogQuery();
      setSearch(nextSearch);
    }, 280);
    return () => window.clearTimeout(timeout);
  }, [search, searchDraft]);

  useEffect(() => {
    let cancelled = false;
    const generation = queryGenerationRef.current + 1;
    queryGenerationRef.current = generation;
    setLoading(true);
    setLoadingMore(false);
    setErrorMessage(null);
    void fetchProductComposioOverview({ search, filter, limit: 48 })
      .then((response) => {
        if (cancelled || queryGenerationRef.current !== generation) return;
        setOverview(response);
        setItems(response.items);
      })
      .catch((error: unknown) => {
        if (cancelled || queryGenerationRef.current !== generation) return;
        setErrorMessage(formatErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled && queryGenerationRef.current === generation) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [filter, reloadToken, search]);

  useSettledPolling({
    enabled: Boolean(
      authorization && !isTerminalAuthorizationStatus(authorization.status),
    ),
    intervalMs: 2_000,
    restartKey: `${authorization?.connectionId ?? "none"}:${authorization?.status ?? "idle"}`,
    poll: async ({ isCurrent }) => {
      const connectionId = authorization?.connectionId;
      if (!connectionId) {
        return;
      }
      try {
        const response = await fetchProductComposioConnection(connectionId);
        if (!isCurrent()) {
          return;
        }
        setAuthorization((current) => {
          if (
            current?.connectionId !== connectionId ||
            isTerminalAuthorizationStatus(current.status)
          ) {
            return current;
          }
          return {
            ...current,
            status: response.connection.status,
            errorMessage: response.connection.statusReason,
          };
        });
        if (response.connection.status === "ACTIVE") {
          reloadCatalog();
        }
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        setAuthorization((current) =>
          current?.connectionId === connectionId &&
          !isTerminalAuthorizationStatus(current.status)
            ? { ...current, errorMessage: formatErrorMessage(error) }
            : current,
        );
      }
    },
  });

  const visibleItems = useMemo(
    () => items.filter((item) => !item.noAuth),
    [items],
  );

  const connectedCount = useMemo(
    () => visibleItems.filter((item) => item.connected).length,
    [visibleItems],
  );

  const loadMore = async () => {
    if (!overview?.nextCursor || loadingMore) return;
    const generation = queryGenerationRef.current;
    const cursor = overview.nextCursor;
    setLoadingMore(true);
    setErrorMessage(null);
    try {
      const response = await fetchProductComposioOverview({
        cursor,
        search,
        filter,
        limit: 48,
      });
      if (queryGenerationRef.current !== generation) return;
      setOverview(response);
      setItems((current) => mergeToolkits(current, response.items));
    } catch (error) {
      if (queryGenerationRef.current !== generation) return;
      setErrorMessage(formatErrorMessage(error));
    } finally {
      if (queryGenerationRef.current === generation) {
        setLoadingMore(false);
      }
    }
  };

  const connectToolkit = async (toolkit: ProductComposioToolkit) => {
    if (connectionMutationInFlightRef.current) {
      return;
    }
    connectionMutationInFlightRef.current = true;
    setAuthorizationBusySlug(toolkit.slug);
    setErrorMessage(null);
    try {
      const response = await authorizeProductComposioToolkit({
        toolkitSlug: toolkit.slug,
        options: {
          toolkitName: toolkit.name,
          language: input.language,
        },
      });
      setAuthorizationUrl(response.redirectUrl);
      setAuthorization({
        toolkit,
        connectionId: response.connectionId,
        status: response.status,
        errorMessage: null,
      });
      await openExternalUrl(response.redirectUrl);
    } catch (error) {
      setErrorMessage(formatErrorMessage(error));
    } finally {
      connectionMutationInFlightRef.current = false;
      setAuthorizationBusySlug(null);
    }
  };

  const disconnect = async (connection: ProductComposioConnection) => {
    if (connectionMutationInFlightRef.current) {
      return;
    }
    connectionMutationInFlightRef.current = true;
    setDisconnectingId(connection.id);
    setErrorMessage(null);
    try {
      await disconnectProductComposioConnection(connection.id);
      setManagedToolkit((current) => {
        if (!current) {
          return current;
        }
        const nextConnections = current.connections.filter(
          (item) => item.id !== connection.id,
        );
        return {
          ...current,
          connections: nextConnections,
          connected: nextConnections.some(isActiveConnection),
        };
      });
      reloadCatalog();
    } catch (error) {
      setErrorMessage(formatErrorMessage(error));
    } finally {
      connectionMutationInFlightRef.current = false;
      setDisconnectingId(null);
    }
  };

  const configured = overview?.provider.configured ?? false;
  const initialLoading = overview === null && loading;
  const initialError = overview === null ? errorMessage : null;

  return (
    <section className="composio-connections" aria-labelledby="composio-title">
      <div className="composio-header">
        <div>
          <div className="composio-title-line">
            <div>
              <p className="eyebrow">{copy.eyebrow}</p>
              <h3 id="composio-title">{copy.title}</h3>
            </div>
          </div>
          <p className="composio-description">{copy.description}</p>
        </div>
        {configured ? (
          <span className="composio-provider-state ready">
            <span aria-hidden="true" />
            {copy.configured}
          </span>
        ) : null}
      </div>

      {initialLoading ? (
        <div className="composio-loading" aria-label={copy.loading}>
          <p>{copy.loading}</p>
          <div className="composio-grid">
            {Array.from({ length: 18 }, (_, index) => (
              <div className="composio-card-skeleton" key={index} />
            ))}
          </div>
        </div>
      ) : initialError ? (
        <div className="composio-inline-error" role="alert">
          <span>{initialError}</span>
          <button onClick={reloadCatalog}>{copy.retry}</button>
        </div>
      ) : configured ? (
        <>
          <div className="composio-controls">
            <label className="composio-search">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label={copy.searchPlaceholder}
                placeholder={copy.searchPlaceholder}
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
              />
            </label>
            <div
              className="composio-filters"
              role="group"
              aria-label={copy.filtersAria}
            >
              {(["all", "connected", "not_connected"] as const).map((value) => (
                <button
                  className={filter === value ? "active" : ""}
                  key={value}
                  onClick={() => {
                    if (filter === value) return;
                    invalidateCatalogQuery();
                    setFilter(value);
                  }}
                >
                  {copy.filters[value]}
                  {value === "connected" && connectedCount > 0 ? (
                    <span>{connectedCount}</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>

          {errorMessage ? (
            <div className="composio-inline-error" role="alert">
              <span>{errorMessage}</span>
              <button onClick={reloadCatalog}>{copy.retry}</button>
            </div>
          ) : null}

          {loading ? (
            <div className="composio-loading" aria-label={copy.loading}>
              <p>{copy.loading}</p>
              <div className="composio-grid">
                {Array.from({ length: 18 }, (_, index) => (
                  <div className="composio-card-skeleton" key={index} />
                ))}
              </div>
            </div>
          ) : visibleItems.length > 0 ? (
            <>
              <div className="composio-grid">
                {visibleItems.map((toolkit) => (
                  <ToolkitCard
                    busy={authorizationBusySlug === toolkit.slug}
                    disabled={
                      authorizationBusySlug !== null || disconnectingId !== null
                    }
                    copy={copy}
                    key={toolkit.slug}
                    toolkit={toolkit}
                    onConnect={() => void connectToolkit(toolkit)}
                    onManage={() => setManagedToolkit(toolkit)}
                  />
                ))}
              </div>
              <div className="composio-catalog-footer">
                <span>{copy.showing(visibleItems.length)}</span>
                {overview?.nextCursor ? (
                  <button
                    className="action-button"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore ? copy.loadingMore : copy.loadMore}
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="composio-empty">{copy.empty}</div>
          )}
        </>
      ) : (
        <div className="composio-inline-error" role="alert">
          <span>{copy.unavailable}</span>
          <button onClick={reloadCatalog}>{copy.retry}</button>
        </div>
      )}

      {authorization ? (
        <div className="composio-dialog-backdrop">
          <section
            ref={authorizationDialogRef}
            className="composio-dialog composio-auth-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composio-auth-title"
          >
            <div className="composio-dialog-header">
              <div className="composio-auth-app">
                <ToolkitLogo toolkit={authorization.toolkit} />
                <div>
                  <p className="eyebrow">{copy.eyebrow}</p>
                  <h3 id="composio-auth-title">
                    {copy.authTitle(authorization.toolkit.name)}
                  </h3>
                </div>
              </div>
              <button
                aria-label={copy.close}
                onClick={() => setAuthorization(null)}
              >
                ×
              </button>
            </div>
            <AuthorizationStatus status={authorization.status} />
            <p>
              {authorization.status === "ACTIVE"
                ? copy.authActive
                : isFailedAuthorizationStatus(authorization.status)
                  ? copy.authFailed
                  : copy.authWaiting}
            </p>
            {authorization.errorMessage ? (
              <p className="inline-error">{authorization.errorMessage}</p>
            ) : null}
            <div className="composio-dialog-actions composio-auth-actions">
              {authorization.status !== "ACTIVE" && authorizationUrl ? (
                <button
                  className="action-button"
                  onClick={() => void openExternalUrl(authorizationUrl)}
                >
                  {copy.reopen}
                </button>
              ) : (
                <span />
              )}
              <button
                className="action-button action-primary"
                onClick={() => setAuthorization(null)}
              >
                {copy.done}
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {managedToolkit ? (
        <div
          className="composio-dialog-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setManagedToolkit(null);
          }}
        >
          <section
            ref={manageDialogRef}
            className="composio-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="composio-manage-title"
          >
            <div className="composio-dialog-header">
              <div className="composio-auth-app">
                <ToolkitLogo toolkit={managedToolkit} />
                <div>
                  <p className="eyebrow">{copy.eyebrow}</p>
                  <h3 id="composio-manage-title">
                    {copy.manageTitle(managedToolkit.name)}
                  </h3>
                </div>
              </div>
              <button
                aria-label={copy.close}
                onClick={() => setManagedToolkit(null)}
              >
                ×
              </button>
            </div>
            <p>{copy.manageDescription}</p>
            <div className="composio-account-list">
              {managedToolkit.connections.length > 0 ? (
                managedToolkit.connections.map((connection) => (
                  <div className="composio-account-row" key={connection.id}>
                    <div>
                      <strong>{connection.alias || managedToolkit.name}</strong>
                      <small>
                        {connection.status} · {connection.id}
                      </small>
                    </div>
                    <button
                      className="action-button action-danger"
                      disabled={
                        disconnectingId !== null ||
                        authorizationBusySlug !== null
                      }
                      onClick={() => void disconnect(connection)}
                    >
                      {disconnectingId === connection.id
                        ? copy.disconnecting
                        : copy.disconnect}
                    </button>
                  </div>
                ))
              ) : (
                <div className="composio-empty compact">
                  {copy.noConnections}
                </div>
              )}
            </div>
            <div className="composio-dialog-actions">
              <span />
              <button
                className="action-button"
                onClick={() => setManagedToolkit(null)}
              >
                {copy.done}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function ToolkitCard(input: {
  toolkit: ProductComposioToolkit;
  busy: boolean;
  disabled: boolean;
  copy: (typeof COPY)[AppLanguage];
  onConnect: () => void;
  onManage: () => void;
}) {
  const activeConnections =
    input.toolkit.connections.filter(isActiveConnection);
  return (
    <article
      className={`composio-toolkit-card ${input.toolkit.connected ? "connected" : ""}`}
    >
      <div className="composio-toolkit-status">
        {input.toolkit.connected ? (
          <span title={input.copy.connected}>✓</span>
        ) : null}
      </div>
      <ToolkitLogo toolkit={input.toolkit} />
      <strong title={input.toolkit.name}>{input.toolkit.name}</strong>
      <small>
        {input.toolkit.connected
          ? activeConnections.length > 1
            ? `${input.copy.connected} (${activeConnections.length})`
            : input.copy.connected
          : input.copy.available}
      </small>
      <button
        disabled={input.disabled}
        onClick={input.toolkit.connected ? input.onManage : input.onConnect}
      >
        {input.busy
          ? "…"
          : input.toolkit.connected
            ? input.copy.manage
            : input.copy.connect}
      </button>
    </article>
  );
}

function ToolkitLogo(input: { toolkit: ProductComposioToolkit }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="composio-toolkit-logo">
      {input.toolkit.logo && !failed ? (
        <img
          alt=""
          loading="lazy"
          src={input.toolkit.logo}
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden="true">
          {input.toolkit.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </span>
  );
}

function AuthorizationStatus(input: { status: string }) {
  const active = input.status === "ACTIVE";
  const failed = isFailedAuthorizationStatus(input.status);
  return (
    <div
      className={`composio-auth-status ${active ? "active" : failed ? "failed" : "waiting"}`}
    >
      <span aria-hidden="true">{active ? "✓" : failed ? "!" : "↻"}</span>
      <strong>{input.status.replace(/_/gu, " ")}</strong>
    </div>
  );
}

function mergeToolkits(
  current: ProductComposioToolkit[],
  incoming: ProductComposioToolkit[],
): ProductComposioToolkit[] {
  const bySlug = new Map(current.map((item) => [item.slug, item]));
  incoming.forEach((item) => bySlug.set(item.slug, item));
  return Array.from(bySlug.values());
}

function isActiveConnection(connection: ProductComposioConnection): boolean {
  return connection.status === "ACTIVE" && !connection.isDisabled;
}

function isFailedAuthorizationStatus(status: string): boolean {
  return ["FAILED", "EXPIRED", "INACTIVE", "REVOKED"].includes(status);
}

function isTerminalAuthorizationStatus(status: string): boolean {
  return status === "ACTIVE" || isFailedAuthorizationStatus(status);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { useEffect, useState } from "react";
import type {
  ProductClawHubAuthState,
  ProductClawHubLoginStartResponse,
  ProductClawHubPublishResponse,
} from "../../src/product/contracts.js";
import {
  beginProductClawHubLogin,
  fetchProductClawHubAuth,
  fetchProductClawHubLoginStatus,
  publishProductWorkflowToClawHub,
} from "./product-runtime";
import { openExternalUrl } from "./runtime-env";

const LOGIN_POLL_INTERVAL_MS = 1_200;

export interface ClawHubPublishApi {
  fetchAuth: typeof fetchProductClawHubAuth;
  beginLogin: typeof beginProductClawHubLogin;
  fetchLoginStatus: typeof fetchProductClawHubLoginStatus;
  publishWorkflow: typeof publishProductWorkflowToClawHub;
  openExternal: typeof openExternalUrl;
  copyText: (value: string) => Promise<void>;
}

interface ClawHubPublishPanelProps {
  workflowId: string;
  workflowTitle: string;
  canPublish: boolean;
  api?: ClawHubPublishApi;
}

const DEFAULT_API: ClawHubPublishApi = {
  fetchAuth: fetchProductClawHubAuth,
  beginLogin: beginProductClawHubLogin,
  fetchLoginStatus: fetchProductClawHubLoginStatus,
  publishWorkflow: publishProductWorkflowToClawHub,
  openExternal: openExternalUrl,
  copyText: async (value) => {
    if (!navigator.clipboard?.writeText) {
      throw new Error("Clipboard access is not available in this window.");
    }
    await navigator.clipboard.writeText(value);
  },
};

/**
 * EN: Publishes one generated workflow to ClawHub and exposes share actions.
 * 中文: 将一个已生成工作流发布到 ClawHub，并提供分享操作。
 * @param props selected workflow and optional API overrides.
 * @returns ClawHub publishing panel.
 */
export function ClawHubPublishPanel({
  workflowId,
  workflowTitle,
  canPublish,
  api = DEFAULT_API,
}: ClawHubPublishPanelProps) {
  const [auth, setAuth] = useState<ProductClawHubAuthState | null>(null);
  const [login, setLogin] = useState<ProductClawHubLoginStartResponse | null>(
    null,
  );
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [result, setResult] = useState<ProductClawHubPublishResponse | null>(
    null,
  );
  const [copiedField, setCopiedField] = useState<"link" | "command" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAuth(null);
    setError(null);
    void api
      .fetchAuth()
      .then((nextAuth) => {
        if (!cancelled) {
          setAuth(nextAuth);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(toErrorMessage(nextError));
          setAuth({
            status: "signed_out",
            handle: null,
            siteUrl: "https://clawhub.ai",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    setResult(null);
    setConsentAccepted(false);
    setCopiedField(null);
    setError(null);
  }, [workflowId]);

  useEffect(() => {
    if (!login) {
      return undefined;
    }
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const status = await api.fetchLoginStatus(login.loginId);
        if (cancelled) {
          return;
        }
        if (status.status === "authorized") {
          setAuth(status.auth);
          setLogin(null);
          setIsConnecting(false);
          setError(null);
          return;
        }
        if (status.status === "failed") {
          setLogin(null);
          setIsConnecting(false);
          setError(status.error || "ClawHub authorization failed.");
          return;
        }
        timeout = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
      } catch (nextError) {
        if (!cancelled) {
          setLogin(null);
          setIsConnecting(false);
          setError(toErrorMessage(nextError));
        }
      }
    };

    timeout = setTimeout(poll, LOGIN_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    };
  }, [api, login]);

  async function handleConnect() {
    setIsConnecting(true);
    setError(null);
    try {
      const nextLogin = await api.beginLogin();
      setLogin(nextLogin);
      await api.openExternal(nextLogin.verificationUrl);
    } catch (nextError) {
      setIsConnecting(false);
      setError(toErrorMessage(nextError));
    }
  }

  async function handlePublish() {
    if (!consentAccepted || !canPublish) {
      return;
    }
    setIsPublishing(true);
    setError(null);
    try {
      setResult(await api.publishWorkflow(workflowId));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setIsPublishing(false);
    }
  }

  async function handleCopy(field: "link" | "command", value: string) {
    setError(null);
    try {
      await api.copyText(value);
      setCopiedField(field);
      window.setTimeout(() => setCopiedField(null), 1_500);
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    }
  }

  return (
    <section className="clawhub-publish-panel panel-card" aria-live="polite">
      <div className="clawhub-publish-heading">
        <div>
          <h2>Share publicly on ClawHub</h2>
          <p>
            Publish this workflow as a free OpenClaw skill and get a link anyone
            can share.
          </p>
        </div>
        {auth?.status === "signed_in" ? (
          <span className="clawhub-account">@{auth.handle}</span>
        ) : null}
      </div>

      {auth === null ? (
        <div className="clawhub-loading-state" role="status">
          <span />
          <span />
        </div>
      ) : null}

      {auth?.status === "signed_out" ? (
        <div className="clawhub-connect-state">
          <div>
            <strong>Connect ClawHub to publish</strong>
            <p>
              Authorization opens in your browser. Your friends do not need an
              account to view the public page.
            </p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={handleConnect}
            disabled={isConnecting}
          >
            {isConnecting ? "Waiting for authorization..." : "Connect ClawHub"}
          </button>
        </div>
      ) : null}

      {login ? (
        <div className="clawhub-device-code" role="status">
          <div>
            <span>Authorization code</span>
            <strong>{login.userCode}</strong>
          </div>
          <button
            className="ghost-button compact"
            type="button"
            onClick={() => void api.openExternal(login.verificationUrl)}
          >
            Open authorization page
          </button>
        </div>
      ) : null}

      {auth?.status === "signed_in" && !result ? (
        <div className="clawhub-publish-form">
          <label className="clawhub-license-consent">
            <input
              type="checkbox"
              checked={consentAccepted}
              onChange={(event) => setConsentAccepted(event.target.checked)}
            />
            <span>
              I understand that publishing makes this skill public under MIT-0.
              Anyone may use, modify, and redistribute it without attribution.
            </span>
          </label>
          {!canPublish ? (
            <p className="clawhub-availability-note">
              Generate this workflow before publishing it.
            </p>
          ) : null}
          <button
            className="primary-button large"
            type="button"
            disabled={!consentAccepted || !canPublish || isPublishing}
            onClick={handlePublish}
          >
            {isPublishing ? "Publishing to ClawHub..." : "Publish publicly"}
          </button>
        </div>
      ) : null}

      {result ? (
        <div className="clawhub-share-result">
          <div className="clawhub-share-summary">
            <div>
              <strong>Ready to share</strong>
              <span>
                {result.status === "unchanged"
                  ? `Version ${result.version} is already public.`
                  : `Version ${result.version} is now public.`}
              </span>
            </div>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => void api.openExternal(result.listingUrl)}
            >
              Open listing
            </button>
          </div>
          <div className="clawhub-share-field">
            <label htmlFor={`clawhub-link-${workflowId}`}>Share link</label>
            <div>
              <input
                id={`clawhub-link-${workflowId}`}
                readOnly
                value={result.listingUrl}
              />
              <button
                className="ghost-button compact"
                type="button"
                onClick={() => void handleCopy("link", result.listingUrl)}
              >
                {copiedField === "link" ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
          <div className="clawhub-install-command">
            <div>
              <span>OpenClaw install command</span>
              <code>{result.installCommand}</code>
            </div>
            <button
              className="ghost-button compact"
              type="button"
              onClick={() => void handleCopy("command", result.installCommand)}
            >
              {copiedField === "command" ? "Copied" : "Copy command"}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="inline-error">{error}</p> : null}

      <p className="clawhub-public-note">
        This publishes only the generated skill. Recorded screens, OCR, account
        credentials, and local sessions are not uploaded.
      </p>
      <span className="sr-only">Selected workflow: {workflowTitle}</span>
    </section>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

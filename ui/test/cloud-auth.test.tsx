import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudAuthClient } from "../src/cloud-auth-client";
import {
  AuthGate,
  AuthLoadingScreen,
  CloudSyncScreen,
} from "../src/cloud-auth";
import type { CloudAuthState } from "../../src/cloud/contracts.js";

const signedOutState: CloudAuthState = {
  status: "signed_out",
  configured: true,
  user: null,
  expiresAt: null,
};

const oauthPendingState: CloudAuthState = {
  ...signedOutState,
  status: "oauth_pending",
};

afterEach(() => {
  window.localStorage.removeItem("oysterworkflow.app-language");
});

describe("Google authentication state", () => {
  it("keeps workflows local in English and Chinese account copy", async () => {
    const user = userEvent.setup();
    const client = createAuthClient(
      vi.fn(async () => ({
        state: oauthPendingState,
      })),
    );

    render(
      <AuthGate
        client={client}
        initialState={signedOutState}
        externalError={null}
        onState={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Sync your AI workers across authorized computers. Workflow cloud sync is not currently available.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Sign in" }));
    expect(
      screen.getByText(
        "Sign in to restore AI workers and device access. Workflow cloud sync is not currently available.",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "中文" }));
    expect(
      screen.getByText(
        "登录后恢复 AI Worker 和设备访问权限。当前不提供 Workflow 云同步。",
      ),
    ).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "创建账号" }));
    expect(
      screen.getByText(
        "在授权电脑间同步 AI Worker。当前不提供 Workflow 云同步。",
      ),
    ).toBeVisible();
  });

  it("restores the Google button after opening OAuth successfully", async () => {
    const user = userEvent.setup();
    const continueWithGoogle = vi.fn(async () => ({
      state: oauthPendingState,
    }));
    const client = createAuthClient(continueWithGoogle);

    function Harness() {
      const [state, setState] = useState(signedOutState);
      return (
        <AuthGate
          client={client}
          initialState={state}
          externalError={null}
          onState={setState}
        />
      );
    }

    render(<Harness />);
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    expect(continueWithGoogle).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Continue with Google" }),
    ).toBeEnabled();
    expect(
      screen.getByText(
        "Finish signing in in your browser. This window will update automatically.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Opening Google...")).not.toBeInTheDocument();
  });

  it("locks authentication mode while an OAuth request is in flight", async () => {
    const user = userEvent.setup();
    const googleRequest = deferred<{ state: CloudAuthState }>();
    const client = createAuthClient(vi.fn(() => googleRequest.promise));

    render(
      <AuthGate
        client={client}
        initialState={signedOutState}
        externalError={null}
        onState={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    const tabs = screen.getByRole("tablist", { name: "Authentication mode" });
    expect(
      within(tabs).getByRole("tab", { name: "Create account" }),
    ).toBeDisabled();
    expect(within(tabs).getByRole("tab", { name: "Sign in" })).toBeDisabled();

    googleRequest.resolve({ state: oauthPendingState });
    expect(await screen.findByRole("tab", { name: "Sign in" })).toBeEnabled();
  });

  it("uses the persisted language for auth loading and cloud sync states", () => {
    window.localStorage.setItem("oysterworkflow.app-language", "zh");
    const { rerender } = render(<AuthLoadingScreen language="zh" />);
    expect(screen.getByText("正在恢复 OysterWorkflow 会话……")).toBeVisible();

    rerender(
      <CloudSyncScreen
        phase="syncing"
        email="person@example.com"
        language="en"
      />,
    );
    expect(
      screen.getByText(
        "Preparing your AI workers and this computer for person@example.com.",
      ),
    ).toBeVisible();

    rerender(
      <CloudSyncScreen
        phase="error"
        email="person@example.com"
        language="zh"
        errorMessage="同步超时"
        onRetry={vi.fn()}
        onContinueOffline={vi.fn()}
        onSignOut={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "AI Worker 同步需要处理" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "重试 AI Worker 同步" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "继续离线使用" })).toBeVisible();
    expect(screen.getByRole("button", { name: "退出登录" })).toBeVisible();
  });
});

function createAuthClient(
  continueWithGoogle: CloudAuthClient["continueWithGoogle"],
): CloudAuthClient {
  return {
    getState: async () => signedOutState,
    signUp: async (input) => ({
      state: signedOutState,
      requiresEmailConfirmation: true,
      email: input.email,
    }),
    signIn: async () => ({ state: signedOutState }),
    continueWithGoogle,
    signOut: async () => ({ state: signedOutState }),
    sync: async () => {
      throw new Error("Not used in this test.");
    },
    onStateChanged: () => () => undefined,
    onError: () => () => undefined,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

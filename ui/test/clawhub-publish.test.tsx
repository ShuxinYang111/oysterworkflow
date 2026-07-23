import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ClawHubPublishPanel,
  type ClawHubPublishApi,
} from "../src/clawhub-publish";
import { applyUiLocalization } from "../src/ui-localization";

function createApi(
  overrides: Partial<ClawHubPublishApi> = {},
): ClawHubPublishApi {
  return {
    fetchAuth: vi.fn(async () => ({
      status: "signed_out",
      handle: null,
      siteUrl: "https://clawhub.ai",
    })),
    beginLogin: vi.fn(async () => ({
      loginId: "login-1",
      verificationUrl: "https://clawhub.ai/device",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-10T18:10:00.000Z",
    })),
    fetchLoginStatus: vi.fn(async () => ({
      loginId: "login-1",
      status: "pending",
      auth: {
        status: "signed_out",
        handle: null,
        siteUrl: "https://clawhub.ai",
      },
      error: null,
    })),
    publishWorkflow: vi.fn(async () => ({
      status: "published",
      ownerHandle: "alex",
      slug: "review-lead-1234abcd",
      version: "1.0.0",
      listingUrl: "https://clawhub.ai/alex/skills/review-lead-1234abcd",
      installCommand: "openclaw skills install @alex/review-lead-1234abcd",
    })),
    openExternal: vi.fn(async () => undefined),
    copyText: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("ClawHubPublishPanel", () => {
  it("starts browser authorization and displays the device code", async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(
      <ClawHubPublishPanel
        workflowId="workflow-1"
        workflowTitle="Review inbound lead"
        canPublish
        api={api}
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Connect ClawHub" }),
    );

    expect(api.beginLogin).toHaveBeenCalledTimes(1);
    expect(api.openExternal).toHaveBeenCalledWith("https://clawhub.ai/device");
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
  });

  it("requires MIT-0 consent, publishes, and exposes share actions", async () => {
    const user = userEvent.setup();
    const api = createApi({
      fetchAuth: vi.fn(async () => ({
        status: "signed_in",
        handle: "alex",
        siteUrl: "https://clawhub.ai",
      })),
    });
    render(
      <ClawHubPublishPanel
        workflowId="workflow-1"
        workflowTitle="Review inbound lead"
        canPublish
        api={api}
      />,
    );

    const publishButton = await screen.findByRole("button", {
      name: "Publish publicly",
    });
    expect(publishButton).toBeDisabled();

    await user.click(
      screen.getByRole("checkbox", {
        name: /I understand that publishing makes this skill public/u,
      }),
    );
    expect(publishButton).toBeEnabled();
    await user.click(publishButton);

    expect(api.publishWorkflow).toHaveBeenCalledWith("workflow-1");
    expect(await screen.findByText("Ready to share")).toBeInTheDocument();
    expect(screen.getByDisplayValue(apiResultUrl())).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(api.copyText).toHaveBeenCalledWith(apiResultUrl()),
    );
  });

  it("keeps publishing unavailable until a workflow has a generated skill", async () => {
    const api = createApi({
      fetchAuth: vi.fn(async () => ({
        status: "signed_in",
        handle: "alex",
        siteUrl: "https://clawhub.ai",
      })),
    });
    render(
      <ClawHubPublishPanel
        workflowId="workflow-1"
        workflowTitle="Draft workflow"
        canPublish={false}
        api={api}
      />,
    );

    expect(
      await screen.findByText("Generate this workflow before publishing it."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Publish publicly" }),
    ).toBeDisabled();
  });

  it("keeps the English-first publishing flow understandable in Chinese", async () => {
    const api = createApi();
    const { container } = render(
      <ClawHubPublishPanel
        workflowId="workflow-1"
        workflowTitle="Draft workflow"
        canPublish
        api={api}
      />,
    );
    const cleanupLocalization = applyUiLocalization(container, "zh");

    try {
      expect(
        await screen.findByRole("heading", { name: "公开分享到 ClawHub" }),
      ).toBeInTheDocument();
      expect(
        await screen.findByRole("button", { name: "连接 ClawHub" }),
      ).toBeInTheDocument();
      expect(screen.getByText(/这里只会发布生成的技能/u)).toBeInTheDocument();
    } finally {
      cleanupLocalization();
    }
  });
});

function apiResultUrl(): string {
  return "https://clawhub.ai/alex/skills/review-lead-1234abcd";
}

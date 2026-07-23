import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildClawHubSlug,
  createProductClawHubService,
  type ProductClawHubServiceDependencies,
} from "../src/product/clawhub.js";

describe("product ClawHub service", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds stable readable slugs with a workflow-specific suffix", () => {
    const first = buildClawHubSlug(
      "Review a YC Co-Founder Profile",
      "workflow-123",
    );
    const repeated = buildClawHubSlug(
      "Review a YC Co-Founder Profile",
      "workflow-123",
    );
    const different = buildClawHubSlug(
      "Review a YC Co-Founder Profile",
      "workflow-456",
    );

    expect(first).toMatch(/^review-a-yc-co-founder-profile-[a-f0-9]{8}$/u);
    expect(repeated).toBe(first);
    expect(different).not.toBe(first);
    expect(buildClawHubSlug("中文流程", "workflow-zh")).toMatch(
      /^workflow-[a-f0-9]{8}$/u,
    );
  });

  it("reports signed out when no ClawHub token exists", async () => {
    const service = createProductClawHubService({
      readConfigFn: async () => null,
    });

    await expect(service.getAuthState()).resolves.toEqual({
      status: "signed_out",
      handle: null,
      siteUrl: "https://clawhub.ai",
    });
  });

  it("aborts a stalled ClawHub account request at the network deadline", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    ) as typeof fetch;
    const service = createProductClawHubService({
      readConfigFn: async () => ({
        registry: "https://clawhub.ai",
        token: "clh_test",
      }),
      fetchFn,
    });

    const request = service.getAuthState();
    const rejection = expect(request).rejects.toThrow(
      "ClawHub did not respond before the request deadline",
    );
    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
  });

  it("completes device authorization and stores the returned token", async () => {
    let storedConfig: { registry: string; token?: string } | null = null;
    const service = createProductClawHubService({
      now: () => new Date("2026-07-10T18:00:00.000Z"),
      requestDeviceCodeFn: async () => ({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://clawhub.ai/device",
        expires_in: 600,
        interval: 1,
      }),
      pollForDeviceTokenFn: async () => ({ access_token: "clh_test" }),
      readConfigFn: async () => storedConfig,
      writeConfigFn: async (config) => {
        storedConfig = config;
      },
      fetchFn: vi.fn(async () =>
        Response.json({ user: { handle: "alex" } }),
      ) as typeof fetch,
    });

    const started = await service.beginLogin();
    expect(started).toMatchObject({
      verificationUrl: "https://clawhub.ai/device",
      userCode: "ABCD-EFGH",
      expiresAt: "2026-07-10T18:10:00.000Z",
    });
    await vi.waitFor(() => {
      expect(storedConfig).toEqual({
        registry: "https://clawhub.ai",
        token: "clh_test",
      });
    });

    await expect(service.getLoginStatus(started.loginId)).resolves.toEqual({
      loginId: started.loginId,
      status: "authorized",
      auth: {
        status: "signed_in",
        handle: "alex",
        siteUrl: "https://clawhub.ai",
      },
      error: null,
    });
  });

  it("exports skill.json, publishes it, and returns share details", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-clawhub-test-"));
    const sourceSkillPath = join(tempRoot, "skill.json");
    await writeFile(sourceSkillPath, "{}\n", "utf8");
    const runCommandFn = vi.fn(async () => ({
      exitCode: 0,
      stdout: "OK. Published review-inbound-lead-5d29a9de@1.0.0 (version-id)\n",
      stderr: "",
    }));
    const exportSkillFn: ProductClawHubServiceDependencies["exportSkillFn"] =
      vi.fn(async (options) => {
        const installDir = join(options.installRoot, "generated-workflow");
        await mkdir(installDir, { recursive: true });
        const skillMdPath = join(installDir, "SKILL.md");
        await writeFile(
          skillMdPath,
          "---\nname: generated-workflow\ndescription: Test\n---\n",
          "utf8",
        );
        return {
          installName: "generated-workflow",
          installDir,
          skillMdPath,
          sourceSkillPath: options.skillPath,
          validation: {
            skill: {
              ok: true as const,
              skillId: "workflow-test",
              stepsCount: 1,
              whenToUseCount: 1,
              prerequisitesCount: 1,
              successCriteriaCount: 1,
            },
          },
        };
      });
    const service = createProductClawHubService({
      readConfigFn: async () => ({
        registry: "https://clawhub.ai",
        token: "clh_test",
      }),
      fetchFn: vi.fn(async (input) => {
        const url = new URL(String(input));
        return url.pathname === "/api/v1/whoami"
          ? Response.json({ user: { handle: "alex" } })
          : Response.json({ match: null, latestVersion: null });
      }) as typeof fetch,
      runCommandFn,
      exportSkillFn,
    });

    try {
      const result = await service.publishWorkflow({
        workflowId: "workflow-123",
        title: "Review inbound lead",
        skillPath: sourceSkillPath,
      });

      expect(exportSkillFn).toHaveBeenCalledWith(
        expect.objectContaining({
          skillPath: sourceSkillPath,
        }),
      );
      expect(runCommandFn).toHaveBeenCalledWith(
        expect.arrayContaining([
          "skill",
          "publish",
          "--slug",
          expect.stringMatching(/^review-inbound-lead-[a-f0-9]{8}$/u),
          "--version",
          "1.0.0",
        ]),
      );
      expect(result).toEqual({
        status: "published",
        ownerHandle: "alex",
        slug: "review-inbound-lead-5d29a9de",
        version: "1.0.0",
        listingUrl:
          "https://clawhub.ai/alex/skills/review-inbound-lead-5d29a9de",
        installCommand:
          "openclaw skills install @alex/review-inbound-lead-5d29a9de",
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("skips a duplicate upload when the same skill version is already public", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "oyster-clawhub-test-"));
    const skillDirectory = join(tempRoot, "same-workflow");
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: same-workflow\ndescription: Test\n---\n",
      "utf8",
    );
    const runCommandFn = vi.fn();
    const service = createProductClawHubService({
      readConfigFn: async () => ({
        registry: "https://clawhub.ai",
        token: "clh_test",
      }),
      fetchFn: vi.fn(async (input) => {
        const url = new URL(String(input));
        return url.pathname === "/api/v1/whoami"
          ? Response.json({ user: { handle: "alex" } })
          : Response.json({
              match: { version: "1.2.3" },
              latestVersion: { version: "1.2.3" },
            });
      }) as typeof fetch,
      runCommandFn,
    });

    try {
      await expect(
        service.publishWorkflow({
          workflowId: "workflow-same",
          title: "Same workflow",
          skillPath: skillDirectory,
        }),
      ).resolves.toMatchObject({
        status: "unchanged",
        version: "1.2.3",
      });
      expect(runCommandFn).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

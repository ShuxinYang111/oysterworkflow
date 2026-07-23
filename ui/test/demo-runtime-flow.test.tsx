// @vitest-environment jsdom

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import type {
  LabSession,
  OpenClawSkill,
  WorkflowCandidate,
} from "../../src/lab-api/api-contracts.js";
import type { ProductState } from "../../src/product/contracts.js";
import { seedProductState } from "../../src/product/seed-state.js";

describe("demo runtime workflow flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.oysterworkflow = {
      runtime: {
        apiBaseUrl: "http://127.0.0.1:3034",
        mode: "desktop",
        platform: "darwin",
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.oysterworkflow;
  });

  it("clicks through train, stop, and generate workflow without exposing the legacy Steps editor", async () => {
    const calls = {
      start: 0,
      stop: 0,
      discovery: 0,
      extraction: 0,
      save: 0,
      productState: 0,
    };
    const recordingSession = buildDemoSession({
      sessionId: "session-live",
      status: "recording",
      startedAt: "2026-06-17T10:00:00.000Z",
      requestedStopAt: null,
    });
    const capturedSession = buildDemoSession({
      sessionId: "session-live",
      status: "ready",
      startedAt: "2026-06-17T10:00:00.000Z",
      requestedStopAt: "2026-06-17T10:00:45.000Z",
      summary: {
        ui: 24,
        ocr: 41,
        audio: 2,
        durationMs: 45_000,
      },
    });
    const discoveredSession = buildDemoSession({
      ...sessionSeedFrom(capturedSession),
      candidates: [demoCandidate],
      workflowPath: "/tmp/session-live/workflow.json",
    });
    let generatedSession = buildDemoSession({
      ...sessionSeedFrom(discoveredSession),
      candidates: [demoCandidate],
      workflowPath: "/tmp/session-live/workflow.json",
      selectedWorkflowId: demoCandidate.workflowId,
      skill: demoSkill,
      skillPath: "/tmp/session-live/skill/skill.json",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";

        if (
          method === "GET" &&
          url.pathname === "/api/recorder/permissions/check"
        ) {
          return grantedRecorderPermissionsResponse();
        }
        if (method === "POST" && url.pathname === "/api/recorder/bootstrap") {
          return readyRecorderBootstrapResponse();
        }
        if (method === "GET" && url.pathname === "/api/llm/config") {
          return readyRuntimeLlmConfigResponse();
        }
        if (method === "POST" && url.pathname === "/api/product/hermes/probe") {
          return jsonResponse({ state: readyDemoProductState() });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/product/capabilities/chrome/prepare"
        ) {
          return readyChromeCapabilityResponse();
        }
        if (method === "GET" && url.pathname === "/api/sessions") {
          return jsonResponse({ sessions: [] });
        }
        if (method === "GET" && url.pathname === "/api/recorder/state") {
          return jsonResponse({ activeSession: null });
        }
        if (method === "GET" && url.pathname === "/api/product/state") {
          calls.productState += 1;
          return jsonResponse({ state: readyDemoProductState() });
        }
        if (method === "POST" && url.pathname === "/api/recorder/start") {
          calls.start += 1;
          return jsonResponse({ session: recordingSession });
        }
        if (method === "POST" && url.pathname === "/api/recorder/stop") {
          calls.stop += 1;
          return jsonResponse({ session: capturedSession });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/sessions/session-live/workflow-discovery"
        ) {
          calls.discovery += 1;
          return jsonResponse({ session: discoveredSession });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/sessions/session-live/skill-extraction"
        ) {
          calls.extraction += 1;
          return jsonResponse({ session: generatedSession });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/sessions/session-live/skill-artifact"
        ) {
          calls.save += 1;
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            skill: OpenClawSkill;
          };
          generatedSession = buildDemoSession({
            ...sessionSeedFrom(generatedSession),
            candidates: [demoCandidate],
            workflowPath: "/tmp/session-live/workflow.json",
            selectedWorkflowId: demoCandidate.workflowId,
            skill: body.skill,
            skillPath: "/tmp/session-live/skill/skill.json",
          });
          return jsonResponse({ session: generatedSession });
        }

        return jsonResponse(
          { error: { message: `Unhandled ${method} ${url.pathname}` } },
          500,
        );
      }),
    );

    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Train my AI worker" }),
    );

    await waitFor(() => {
      expect(calls.start).toBe(1);
      expect(
        screen.getByRole("button", { name: "Stop training" }),
      ).toBeTruthy();
    });

    await userEvent.click(
      screen.getByRole("button", { name: "Stop training" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Workflows" }),
    ).toBeTruthy();
    expect(calls.stop).toBe(1);
    await waitFor(() => {
      expect(calls.productState).toBeGreaterThanOrEqual(1);
    });
    const productStateCallsAfterStop = calls.productState;
    expect(
      screen.getAllByText("Captured training session").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Capture is ready. Analyze it to build an editable workflow.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Generate workflow",
      }).disabled,
    ).toBe(false);
    expect(screen.queryByLabelText("Workflow apps")).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Generate workflow" }),
    );

    expect(
      await screen.findByText("Workflow logic", {}, { timeout: 7_000 }),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Research YC launch demos and document notes").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("Chrome").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Google Docs").length).toBeGreaterThan(0);
    expect(calls.discovery).toBe(1);
    expect(calls.extraction).toBe(1);
    await waitFor(() => {
      expect(calls.productState).toBeGreaterThan(productStateCallsAfterStop);
    });

    expect(screen.queryByText("Current steps")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit steps" })).toBeNull();
    expect(calls.save).toBe(0);
  }, 30_000);

  it("restores and displays the persisted real workflow generation stage", async () => {
    window.localStorage.setItem("oysterworkflow.app-language", "en");
    const session = buildDemoSession({
      sessionId: "session-progress",
      status: "skill-extracting",
      startedAt: "2026-06-17T10:00:00.000Z",
      requestedStopAt: "2026-06-17T10:00:45.000Z",
      summary: {
        ui: 24,
        ocr: 41,
        audio: 2,
        durationMs: 45_000,
      },
      candidates: [demoCandidate],
      workflowPath: "/tmp/session-progress/workflow.json",
      selectedWorkflowId: demoCandidate.workflowId,
      generationProgress: {
        currentStage: "building-skill",
        failedStage: null,
        failedAt: null,
        completedAt: null,
        stages: {
          "analyzing-recording": {
            startedAt: "2026-06-17T10:00:45.000Z",
            completedAt: "2026-06-17T10:00:46.000Z",
          },
          "discovering-workflow": {
            startedAt: "2026-06-17T10:01:00.000Z",
            completedAt: "2026-06-17T10:01:15.000Z",
          },
          "building-skill": {
            startedAt: new Date().toISOString(),
            completedAt: null,
          },
          "building-workflow-graph": {
            startedAt: null,
            completedAt: null,
          },
        },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/api/recorder/permissions/check") {
          return grantedRecorderPermissionsResponse();
        }
        if (url.pathname === "/api/recorder/bootstrap") {
          return readyRecorderBootstrapResponse();
        }
        if (url.pathname === "/api/llm/config") {
          return readyRuntimeLlmConfigResponse();
        }
        if (url.pathname === "/api/product/hermes/probe") {
          return jsonResponse({ state: readyDemoProductState() });
        }
        if (url.pathname === "/api/product/capabilities/chrome/prepare") {
          return readyChromeCapabilityResponse();
        }
        if (url.pathname === "/api/sessions") {
          return jsonResponse({ sessions: [session] });
        }
        if (url.pathname === "/api/recorder/state") {
          return jsonResponse({ activeSession: null });
        }
        if (url.pathname === "/api/product/state") {
          return jsonResponse({ state: readyDemoProductState() });
        }
        return jsonResponse(
          {
            error: { message: `Unavailable in progress test: ${url.pathname}` },
          },
          500,
        );
      }),
    );

    render(<App />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Workflows" }),
    );

    const progress = await screen.findByLabelText(
      "Workflow generation progress",
    );
    expect(within(progress).getByText("Stage 3 of 4")).toBeTruthy();
    expect(within(progress).getAllByText("Building skill")).toHaveLength(2);
    expect(within(progress).getByText("In progress")).toBeTruthy();
    expect(within(progress).getAllByText("Done")).toHaveLength(2);
    expect(within(progress).getByText("Building workflow graph")).toBeTruthy();
  });

  it("pauses persisted multi-workflow generation until the user chooses a candidate", async () => {
    window.localStorage.setItem("oysterworkflow.app-language", "en");
    const secondaryCandidate: WorkflowCandidate = {
      ...demoCandidate,
      workflowId: "workflow-secondary",
      name: "Document the popup issue",
      description: "Write and submit a concise popup issue report.",
      goal: "Submit the issue report.",
      priority: 2,
      eventCount: 18,
      whyThisWorkflow: "This sequence has a distinct reporting outcome.",
    };
    const lowerPriorityCandidate: WorkflowCandidate = {
      ...demoCandidate,
      workflowId: "workflow-lower-priority",
      name: "Review audio settings",
      description: "Inspect the audio setting before reporting the issue.",
      goal: "Confirm the audio setting state.",
      priority: 3,
      eventCount: 30,
    };
    const candidates = [
      lowerPriorityCandidate,
      secondaryCandidate,
      demoCandidate,
    ];
    const waitingProgress: LabSession["generationProgress"] = {
      currentStage: null,
      failedStage: null,
      failedAt: null,
      completedAt: null,
      stages: {
        "analyzing-recording": {
          startedAt: "2026-06-17T10:00:45.000Z",
          completedAt: "2026-06-17T10:00:46.000Z",
        },
        "discovering-workflow": {
          startedAt: "2026-06-17T10:01:00.000Z",
          completedAt: "2026-06-17T10:01:15.000Z",
        },
        "building-skill": { startedAt: null, completedAt: null },
        "building-workflow-graph": { startedAt: null, completedAt: null },
      },
    };
    const capturedSession = buildDemoSession({
      sessionId: "session-multi",
      status: "ready",
      startedAt: "2026-06-17T10:00:00.000Z",
      requestedStopAt: "2026-06-17T10:00:45.000Z",
      summary: {
        ui: 72,
        ocr: 84,
        audio: 0,
        durationMs: 45_000,
      },
    });
    const waitingSession = buildDemoSession({
      ...sessionSeedFrom(capturedSession),
      candidates,
      workflowPath: "/tmp/session-multi/workflow.json",
      generationProgress: waitingProgress,
    });
    let currentSession = capturedSession;
    let discoveryCalls = 0;
    let extractionBody: { workflowId?: string } | null = null;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname === "/api/recorder/permissions/check") {
          return grantedRecorderPermissionsResponse();
        }
        if (url.pathname === "/api/recorder/bootstrap") {
          return readyRecorderBootstrapResponse();
        }
        if (url.pathname === "/api/llm/config") {
          return readyRuntimeLlmConfigResponse();
        }
        if (url.pathname === "/api/product/hermes/probe") {
          return jsonResponse({ state: readyDemoProductState() });
        }
        if (url.pathname === "/api/product/capabilities/chrome/prepare") {
          return readyChromeCapabilityResponse();
        }
        if (method === "GET" && url.pathname === "/api/sessions") {
          return jsonResponse({ sessions: [currentSession] });
        }
        if (
          method === "GET" &&
          url.pathname === "/api/sessions/session-multi"
        ) {
          return jsonResponse({ session: currentSession });
        }
        if (url.pathname === "/api/recorder/state") {
          return jsonResponse({ activeSession: null });
        }
        if (url.pathname === "/api/product/state") {
          return jsonResponse({ state: readyDemoProductState() });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/sessions/session-multi/workflow-discovery"
        ) {
          discoveryCalls += 1;
          currentSession = waitingSession;
          return jsonResponse({ session: currentSession });
        }
        if (
          method === "POST" &&
          url.pathname === "/api/sessions/session-multi/skill-extraction"
        ) {
          extractionBody = JSON.parse(String(init?.body ?? "{}")) as {
            workflowId?: string;
          };
          currentSession = buildDemoSession({
            ...sessionSeedFrom(currentSession),
            candidates,
            workflowPath: "/tmp/session-multi/workflow.json",
            selectedWorkflowId: secondaryCandidate.workflowId,
            skill: {
              ...demoSkill,
              skillId: "document-popup-issue",
              skillName: secondaryCandidate.name,
            },
            skillPath: "/tmp/session-multi/skill/skill.json",
          });
          return jsonResponse({ session: currentSession });
        }
        return jsonResponse(
          { error: { message: `Unhandled ${method} ${url.pathname}` } },
          500,
        );
      }),
    );

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Workflows" }));

    await user.click(
      await screen.findByRole("button", {
        name: "Generate workflow",
      }),
    );
    let dialog = await screen.findByRole("dialog", {
      name: "Choose what to generate",
    });
    expect(discoveryCalls).toBe(1);
    const progress = screen.getByLabelText("Workflow generation progress");
    expect(
      within(progress).getByText("3 workflows detected. Waiting for selection"),
    ).toBeTruthy();
    expect(within(progress).getByText("2 of 4 stages complete")).toBeTruthy();

    const radios = within(dialog).getAllByRole<HTMLInputElement>("radio");
    expect(radios.map((radio) => radio.value)).toEqual([
      demoCandidate.workflowId,
      secondaryCandidate.workflowId,
      lowerPriorityCandidate.workflowId,
    ]);
    expect(radios[0].checked).toBe(true);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(extractionBody).toBeNull();

    cleanup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    await user.click(
      await screen.findByRole("button", { name: "Choose workflow" }),
    );
    dialog = await screen.findByRole("dialog", {
      name: "Choose what to generate",
    });
    await user.click(
      within(dialog).getAllByRole("button", {
        name: "Close without generating",
      })[0],
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(extractionBody).toBeNull();

    await user.click(screen.getByRole("button", { name: "Choose workflow" }));
    dialog = await screen.findByRole("dialog", {
      name: "Choose what to generate",
    });
    await user.click(
      within(dialog).getAllByRole("button", {
        name: "Close without generating",
      })[1],
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(extractionBody).toBeNull();

    await user.click(screen.getByRole("button", { name: "Choose workflow" }));
    dialog = await screen.findByRole("dialog", {
      name: "Choose what to generate",
    });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /Document the popup issue/u,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Generate selected workflow",
      }),
    );

    await waitFor(() => {
      expect(extractionBody).toEqual({
        workflowPath: "/tmp/session-multi/workflow.json",
        workflowId: secondaryCandidate.workflowId,
      });
    });
    expect(
      await screen.findByText("Workflow logic", {}, { timeout: 7_000 }),
    ).toBeTruthy();
  });
});

function grantedRecorderPermissionsResponse(): Response {
  return jsonResponse({
    checkedAt: "2026-06-24T18:00:00.000Z",
    allGranted: true,
    canStartRecording: true,
    source: "host-app",
    summary: "All required recorder permissions are available.",
    items: [
      {
        kind: "screen-recording",
        label: "Screen Recording",
        description: "Allows screen capture.",
        state: "granted",
        detail: "",
      },
    ],
  });
}

function readyRecorderBootstrapResponse(): Response {
  return jsonResponse({
    startedAt: "2026-06-24T18:00:00.000Z",
    completedAt: "2026-06-24T18:00:01.000Z",
    stage: "ready",
    ready: true,
    summary: "Recorder is ready.",
    logPath: null,
  });
}

function readyRuntimeLlmConfigResponse(): Response {
  return jsonResponse({
    path: "/tmp/oysterworkflow-test/llm.config.json",
    config: {
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.4",
      wireApi: "responses",
      reasoningEffort: "high",
      responseReadTimeoutMs: 90_000,
      responseTimeoutMode: "idle",
      callProfiles: {},
      clientProfile: "openai-js",
      authMode: "env",
      apiKeyEnv: "OPENAI_API_KEY",
      hasStoredApiKey: false,
      hasResolvedApiKey: true,
    },
  });
}

function readyDemoProductState(): ProductState {
  const state = seedProductState("demo");
  return {
    ...state,
    hermes: {
      ...state.hermes,
      available: true,
      lastCheckedAt: "2026-06-24T18:00:00.000Z",
    },
    capabilityProviders: state.capabilityProviders.map((provider) =>
      provider.id === "chrome"
        ? {
            ...provider,
            status: "ready",
            enabled: true,
            installed: true,
            version: "test",
            commandPath: "/tmp/oysterworkflow-test/browser-act",
            lastCheckedAt: "2026-06-24T18:00:00.000Z",
            lastSuccessAt: "2026-06-24T18:00:00.000Z",
            detail: null,
          }
        : provider,
    ),
  };
}

function readyChromeCapabilityResponse(): Response {
  const state = readyDemoProductState();
  const provider = state.capabilityProviders.find(
    (candidate) => candidate.id === "chrome",
  );
  if (!provider) {
    throw new Error("Ready demo product state is missing Chrome.");
  }
  return jsonResponse({ state, provider });
}

const liveRuntimeApiBaseUrl = process.env.OYSTERWORKFLOW_LIVE_API_BASE_URL;
const liveDescribe = liveRuntimeApiBaseUrl ? describe : describe.skip;

liveDescribe("demo runtime live desktop integration", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await stopLiveSalesWorkerIfNeeded();
    await stopLiveRecorderIfNeeded();
    window.oysterworkflow = {
      runtime: {
        apiBaseUrl: liveRuntimeApiBaseUrl,
        mode: "desktop",
        platform: "darwin",
      },
    };
  });

  afterEach(async () => {
    await stopLiveSalesWorkerIfNeeded();
    await stopLiveRecorderIfNeeded();
    cleanup();
    vi.unstubAllGlobals();
    delete window.oysterworkflow;
  });

  it("clicks the demo train and stop controls against the real desktop Runtime", async () => {
    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Train my AI worker" }),
    );

    await waitFor(
      async () => {
        const state = await fetchLiveRecorderState();
        expect(state.activeSession?.status).toBe("recording");
      },
      { timeout: 25_000 },
    );

    await waitFor(
      () => {
        expect(
          screen.getByRole("button", { name: "Stop training" }),
        ).toBeTruthy();
      },
      { timeout: 10_000 },
    );

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await userEvent.click(
      screen.getByRole("button", { name: "Stop training" }),
    );

    await waitFor(
      async () => {
        const state = await fetchLiveRecorderState();
        expect(state.activeSession).toBeNull();
      },
      { timeout: 35_000 },
    );

    expect(
      await screen.findByRole(
        "heading",
        { name: "Workflows" },
        { timeout: 35_000 },
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Generate workflow" }),
    ).toBeTruthy();
  }, 70_000);

  it("starts Sales AI Worker, accepts an Agent command after Hermes is ready, and stops the worker", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeTruthy();

    await userEvent.click(
      await screen.findByRole("button", { name: "Start worker" }),
    );

    await waitFor(
      async () => {
        const activeRun = liveSalesRun(await fetchLiveProductState());
        expect(activeRun?.status).toBe("running");
        expect(activeRun?.hermesSessionId).toBeTruthy();
      },
      { timeout: 90_000 },
    );

    const composer = await screen.findByLabelText("Message Sales AI Worker");
    await waitFor(
      () => {
        expect(composer).not.toBeDisabled();
      },
      { timeout: 30_000 },
    );

    await userEvent.type(composer, "continue process inbound customer email");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(
      async () => {
        const state = await fetchLiveProductState();
        expect(
          state.commands.some(
            (command) =>
              command.workerId === "sales" &&
              command.command === "continue process inbound customer email" &&
              command.status === "accepted",
          ),
        ).toBe(true);
        expect(
          state.runEvents.some(
            (event) =>
              event.workerId === "sales" &&
              event.source === "user" &&
              event.body === "continue process inbound customer email",
          ),
        ).toBe(true);
      },
      { timeout: 35_000 },
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Stop worker" }),
    );

    await waitFor(
      async () => {
        expect(liveSalesRun(await fetchLiveProductState())).toBeNull();
      },
      { timeout: 35_000 },
    );
  }, 140_000);

  it("deploys a generated workflow to Sales AI Worker with its source skill artifact", async () => {
    const candidate = await selectLiveDeployCandidate();
    await deleteLiveInstalledWorkflowIfNeeded(candidate.installedWorkflowId);

    render(<App />);

    await userEvent.click(
      await screen.findByRole("button", { name: "Workflows" }),
    );
    const search = await screen.findByLabelText("Search detected workflows");
    await userEvent.clear(search);
    await userEvent.type(search, candidate.title);
    const workflowList = screen.getByRole("list", {
      name: "Detected workflow list",
    });
    const workflowCardTitles = await within(workflowList).findAllByText(
      candidate.title,
    );
    await userEvent.click(workflowCardTitles[0]);
    await userEvent.click(
      await screen.findByRole("button", { name: "Deploy to AI worker" }),
    );

    let installed = null;
    await waitFor(
      async () => {
        const state = await fetchLiveProductState();
        installed =
          state.installedWorkflows.find(
            (workflow) => workflow.id === candidate.installedWorkflowId,
          ) ?? null;
        expect(installed).toMatchObject({
          workerId: "sales",
          workflowId: candidate.workflowId,
          workflowTitle: candidate.title,
          baselineRuns: 0,
          baselineSuccesses: 0,
          baselineLastRun: "Not run yet",
          status: "Enabled",
        });
      },
      { timeout: 35_000 },
    );

    expect(
      await screen.findByText(
        `${candidate.title} deployed to this worker. Press Start worker to begin execution.`,
      ),
    ).toBeTruthy();

    const installMetadataPath = join(
      dirname(installed!.hermesSkillPath),
      "oysterworkflow-install.json",
    );
    const installMetadata = JSON.parse(
      await readFile(installMetadataPath, "utf8"),
    ) as { sourceSkillPath: string | null };
    expect(installMetadata.sourceSkillPath).toBe(candidate.artifactPath);

    await deleteLiveInstalledWorkflowIfNeeded(candidate.installedWorkflowId);
  }, 80_000);
});

async function fetchLiveRecorderState(): Promise<{
  activeSession: LabSession | null;
}> {
  if (!liveRuntimeApiBaseUrl) {
    return { activeSession: null };
  }
  const response = await fetch(`${liveRuntimeApiBaseUrl}/api/recorder/state`);
  if (!response.ok) {
    throw new Error(`Runtime recorder state failed: HTTP ${response.status}`);
  }
  return (await response.json()) as { activeSession: LabSession | null };
}

async function stopLiveRecorderIfNeeded(): Promise<void> {
  if (!liveRuntimeApiBaseUrl) {
    return;
  }
  const state = await fetchLiveRecorderState();
  if (!state.activeSession) {
    return;
  }
  const response = await fetch(`${liveRuntimeApiBaseUrl}/api/recorder/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    throw new Error(`Runtime recorder stop failed: HTTP ${response.status}`);
  }
}

async function fetchLiveProductState(): Promise<ProductState> {
  if (!liveRuntimeApiBaseUrl) {
    throw new Error("Live Runtime API base URL is not configured.");
  }
  const response = await fetch(`${liveRuntimeApiBaseUrl}/api/product/state`);
  if (!response.ok) {
    throw new Error(`Runtime product state failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { state: ProductState };
  return body.state;
}

async function stopLiveSalesWorkerIfNeeded(): Promise<void> {
  if (!liveRuntimeApiBaseUrl) {
    return;
  }
  const state = await fetchLiveProductState();
  if (!liveSalesRun(state)) {
    return;
  }
  const response = await fetch(
    `${liveRuntimeApiBaseUrl}/api/product/workers/sales/stop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Runtime Sales worker stop failed: HTTP ${response.status}`,
    );
  }
}

async function deleteLiveInstalledWorkflowIfNeeded(
  installedWorkflowId: string,
): Promise<void> {
  if (!liveRuntimeApiBaseUrl) {
    return;
  }
  const state = await fetchLiveProductState();
  if (
    !state.installedWorkflows.some(
      (workflow) => workflow.id === installedWorkflowId,
    )
  ) {
    return;
  }
  const response = await fetch(
    `${liveRuntimeApiBaseUrl}/api/product/installed-workflows/${encodeURIComponent(
      installedWorkflowId,
    )}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(
      `Runtime installed workflow delete failed: HTTP ${response.status}`,
    );
  }
}

async function selectLiveDeployCandidate(): Promise<{
  workflowId: string;
  title: string;
  artifactPath: string;
  installedWorkflowId: string;
}> {
  const state = await fetchLiveProductState();
  const installedSalesWorkflowIds = new Set(
    state.installedWorkflows
      .filter((workflow) => workflow.workerId === "sales")
      .map((workflow) => workflow.workflowId),
  );
  const workflow = state.workflows.find(
    (candidate) =>
      candidate.status === "Generated" &&
      candidate.artifactPath &&
      !installedSalesWorkflowIds.has(candidate.id),
  );
  if (!workflow?.artifactPath) {
    throw new Error(
      "No generated workflow with a source skill artifact is available for live deploy testing.",
    );
  }
  return {
    workflowId: workflow.id,
    title: workflow.title,
    artifactPath: workflow.artifactPath,
    installedWorkflowId: `installed-${workflow.id}-sales`,
  };
}

function liveSalesRun(state: ProductState) {
  return (
    state.runs.find(
      (run) => run.workerId === "sales" && run.status === "running",
    ) ?? null
  );
}

const demoCandidate: WorkflowCandidate = {
  workflowId: "workflow-yc-launch",
  name: "Research YC launch demos and document notes",
  description:
    "Find YC launch demos, inspect the product narrative, and record reusable notes.",
  goal: "Produce research notes from YC launch videos.",
  priority: 1,
  confidence: 0.91,
  startEventId: "event-1",
  endEventId: "event-24",
  startTs: "2026-06-17T10:00:00.000Z",
  endTs: "2026-06-17T10:00:45.000Z",
  eventCount: 24,
};

const demoSkill: OpenClawSkill = {
  schemaVersion: "openclaw-skill-v1",
  promptSet: "specific-v24",
  skillId: "research-yc-launch-demo",
  skillName: "Research YC launch demos and document notes",
  generatedAt: "2026-06-17T10:01:00.000Z",
  source: {
    runId: "run-live",
    runDir: "/tmp/session-live/run",
    episodeId: "episode-1",
    startTs: "2026-06-17T10:00:00.000Z",
    endTs: "2026-06-17T10:00:45.000Z",
  },
  executionMode: "autonomous",
  shortDescription: "Research YC launch demos and record notes.",
  description:
    "The workflow searches YC launch content, reviews the demo narrative, and writes structured notes for OysterWorkflow positioning.",
  goal: "Produce documented research notes from YC launch demos.",
  whenToUse: ["Use when researching comparable YC launch videos."],
  whenNotToUse: [],
  inputs: [],
  outputs: [],
  prerequisites: ["Chrome is available."],
  steps: [
    {
      step: 1,
      instruction: "Open Chrome and locate the launch page",
      intent:
        "Navigate from the existing ChatGPT conversation to the target YC launch page and confirm that the relevant demo material is visible before taking notes.",
      operationApp: "Chrome",
      hints: [
        "Use the existing research tab when available.",
        "If the launch page is missing, search YC Launch for the company name.",
        "Prefer launch pages with embedded YouTube videos.",
      ],
    },
    {
      step: 2,
      instruction: "Write structured notes in Google Docs",
      intent:
        "Record the link, core positioning, demo mechanics, and implications for OysterWorkflow in the research document.",
      operationApp: "Google Docs",
      hints: ["Keep notes concise and source-backed."],
    },
  ],
  successCriteria: [
    "The notes document contains source links and observations.",
  ],
  failureModes: [],
  fallback: [],
  examples: [],
  tags: ["YC RESEARCH", "DEMO RESEARCH"],
  assets: [],
  evidence: {
    totalEvents: 24,
    anchorEvents: 8,
    ocrEvents: 16,
    appsSeen: ["Google Chrome", "Google Docs"],
    windowsSeen: ["Y Combinator", "Google Docs"],
  },
};

function buildDemoSession(input: {
  sessionId: string;
  status: LabSession["status"];
  startedAt: string | null;
  requestedStopAt: string | null;
  summary?: {
    ui: number;
    ocr: number;
    audio: number;
    durationMs: number;
  };
  candidates?: WorkflowCandidate[];
  workflowPath?: string | null;
  selectedWorkflowId?: string | null;
  skill?: OpenClawSkill | null;
  skillPath?: string | null;
  generationProgress?: LabSession["generationProgress"];
}): LabSession {
  const summary = input.summary
    ? {
        runId: "run-live",
        startedAt: "2026-06-17T10:00:45.000Z",
        completedAt: "2026-06-17T10:00:46.000Z",
        durationMs: 1000,
        timeWindow: {
          requested: {
            startTs: input.startedAt ?? "2026-06-17T10:00:00.000Z",
            endTs: input.requestedStopAt ?? "2026-06-17T10:00:45.000Z",
            durationMs: input.summary.durationMs,
          },
          observed: {
            startTs: input.startedAt,
            endTs: input.requestedStopAt,
            durationMs: input.summary.durationMs,
          },
        },
        fetch: {
          ocrPages: 1,
          audioPages: 1,
          uiPages: 1,
          rawOcrCount: input.summary.ocr,
          rawAudioCount: input.summary.audio,
          rawUiEventsCount: input.summary.ui,
        },
        transform: {
          normalizedCount: input.summary.ui,
          dedupedCount: input.summary.ui,
          droppedDuplicates: 0,
        },
        episodes: {
          count: 1,
          avgDurationMs: input.summary.durationMs,
          medianDurationMs: input.summary.durationMs,
        },
        warnings: [],
      }
    : null;

  const baseSkillArtifact =
    input.skill && input.skillPath
      ? {
          workflowId: input.selectedWorkflowId ?? "workflow-yc-launch",
          workflowPath: input.workflowPath ?? "/tmp/session-live/workflow.json",
          latestOutDir: "/tmp/session-live/skill",
          skillPath: input.skillPath,
          summaryPath: "/tmp/session-live/skill/summary.json",
          skill: input.skill,
          summary: {
            runId: "run-live",
            episodeId: "episode-1",
            skillId: input.skill.skillId,
            generatedAt: input.skill.generatedAt,
            sourceEvents: input.skill.evidence.totalEvents,
            stepsCount: input.skill.steps.length,
            selectedWorkflowId:
              input.selectedWorkflowId ?? "workflow-yc-launch",
            output: {
              outDir: "/tmp/session-live/skill",
              skillPath: input.skillPath,
              summaryPath: "/tmp/session-live/skill/summary.json",
            },
            warnings: [],
          },
        }
      : null;

  return {
    schemaVersion: "recording-session-v1",
    sessionId: input.sessionId,
    sessionName: null,
    createdAt: "2026-06-17T10:00:00.000Z",
    updatedAt: "2026-06-17T10:00:46.000Z",
    status: input.status,
    paths: {
      sessionDir: "/tmp/session-live",
      dataDir: "/tmp/session-live/data",
      ingestOutDir: "/tmp/session-live/ingest",
      workflowDir: "/tmp/session-live/workflow",
      skillDir: "/tmp/session-live/skill",
      generalizationDir: "/tmp/session-live/generalization",
      plannerOptimizationDir: "/tmp/session-live/planner",
      sessionPath: "/tmp/session-live/session.json",
      recordingLogPath: "/tmp/session-live/recording.log",
      queryLogPath: "/tmp/session-live/query.log",
    },
    recordingConfig: {
      ocrLanguagePriority: ["chinese", "english"],
      enableAudio: false,
    },
    screenpipe: {
      recording: {
        state: input.status === "recording" ? "running" : "stopped",
        pid: null,
        port: 3030,
        workdir: "/tmp",
        command: [],
        logPath: null,
        startedAt: input.startedAt,
        stoppedAt: input.requestedStopAt,
        exitCode: null,
      },
      queryMode: {
        state: "stopped",
        pid: null,
        port: null,
        workdir: "/tmp",
        command: [],
        logPath: null,
        startedAt: null,
        stoppedAt: null,
        exitCode: null,
      },
    },
    recordingWindow: {
      startedAt: input.startedAt,
      requestedStopAt: input.requestedStopAt,
      scheduledStopAt: null,
      autoStopMinutes: null,
    },
    generationProgress: input.generationProgress ?? {
      currentStage: null,
      failedStage: null,
      failedAt: null,
      completedAt: null,
      stages: {
        "analyzing-recording": {
          startedAt: summary?.startedAt ?? null,
          completedAt: summary?.completedAt ?? null,
        },
        "discovering-workflow": { startedAt: null, completedAt: null },
        "building-skill": { startedAt: null, completedAt: null },
        "building-workflow-graph": { startedAt: null, completedAt: null },
      },
    },
    ingest: {
      latestRunId: summary?.runId ?? null,
      latestRunDir: summary ? "/tmp/session-live/run" : null,
      summaryPath: summary ? "/tmp/session-live/run/summary.json" : null,
      summary,
    },
    selection: {
      workflowId: input.selectedWorkflowId ?? null,
      workflowPath: input.workflowPath ?? null,
    },
    workflowDiscovery: {
      latestPath: input.workflowPath ?? null,
      workflowCandidates: input.candidates ?? [],
    },
    skillExtraction: {
      latestOutDir: baseSkillArtifact?.latestOutDir ?? null,
      skillPath: input.skillPath ?? null,
      summaryPath: baseSkillArtifact?.summaryPath ?? null,
      skill: input.skill ?? null,
      summary: baseSkillArtifact?.summary ?? null,
      artifacts: baseSkillArtifact ? [baseSkillArtifact] : [],
    },
    generalization: {
      latestOutDir: null,
      summaryPath: null,
      summary: null,
      artifacts: [],
    },
    plannerOptimization: {
      latestOutDir: null,
      skillPath: null,
      summaryPath: null,
      skill: null,
      summary: null,
    },
    warnings: [],
    error: null,
  };
}

function sessionSeedFrom(session: LabSession) {
  return {
    sessionId: session.sessionId,
    status: session.status,
    startedAt: session.recordingWindow.startedAt,
    requestedStopAt: session.recordingWindow.requestedStopAt,
    summary: session.ingest.summary
      ? {
          ui: session.ingest.summary.fetch.rawUiEventsCount,
          ocr: session.ingest.summary.fetch.rawOcrCount,
          audio: session.ingest.summary.fetch.rawAudioCount,
          durationMs: session.ingest.summary.timeWindow.requested.durationMs,
        }
      : undefined,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

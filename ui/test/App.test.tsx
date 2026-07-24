import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { applyUiLocalization } from "../src/ui-localization";
import type { LabSession } from "../../src/lab-api/api-contracts.js";
import type {
  ProductAccount,
  ProductDevice,
  ProductHermesStatus,
  ProductInstalledWorkflow,
  ProductRun,
  ProductRunEvent,
  ProductState,
  ProductWorker,
  ProductWorkflow,
} from "../../src/product/contracts.js";
import { defaultHermesProviderHealth } from "../../src/product/hermes-provider-status.js";

const productRuntimeMock = vi.hoisted(() => {
  let state: any = null;

  const clone = <T,>(value: T): T => structuredClone(value);

  const updateState = (mutator: (draft: any) => void) => {
    const draft = clone(state);
    mutator(draft);
    draft.updatedAt = "2026-06-24T18:00:00.000Z";
    state = draft;
    return clone(state);
  };

  const findWorker = (workerId: string) => {
    const worker = state.workers.find((item: any) => item.id === workerId);
    if (!worker) {
      throw new Error(`Unknown worker: ${workerId}`);
    }
    return worker;
  };

  const firstRunnableWorkflow = (workerId: string) => {
    const workflow = state.installedWorkflows.find(
      (item: any) => item.workerId === workerId && item.status === "Enabled",
    );
    if (!workflow) {
      throw new Error("Deploy a workflow before starting work.");
    }
    return workflow;
  };

  const event = (input: {
    runId: string;
    workerId: string;
    source: string;
    status: string;
    body: string;
  }) => ({
    id: `event-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    runId: input.runId,
    workerId: input.workerId,
    source: input.source,
    status: input.status,
    body: input.body,
    createdAt: new Date().toISOString(),
  });

  const isRuntimeRecoveryRunEvent = (item: any) =>
    /runtime recovered/i.test(item.status) ||
    /runtime restarted before this run finished/i.test(item.body);

  const isHermesAgentMessageStatus = (status: string) => {
    const normalized = status.toLowerCase();
    return (
      /ai worker (ready|started|response|completed|failed)/u.test(normalized) ||
      normalized === "waiting for user" ||
      normalized === "blocked"
    );
  };

  const isProductSystemAgentEvent = (item: any) => {
    const normalized = item.status.toLowerCase();
    if (item.source === "executor") {
      return normalized === "workflow selected";
    }
    if (item.source === "system") {
      return (
        normalized === "initializing" ||
        normalized === "initialized" ||
        normalized === "paused" ||
        normalized === "ai worker failed"
      );
    }
    return false;
  };

  const isAgentConversationEvent = (item: any) => {
    if (isRuntimeRecoveryRunEvent(item)) {
      return false;
    }
    if (item.source === "user") {
      return true;
    }
    if (item.source === "hermes") {
      const isInternalDiagnostic =
        /review diff|cua-driver-rs|cua-driver|Used terminal|Release notes:|Update with:/iu.test(
          item.body,
        );
      return isHermesAgentMessageStatus(item.status) && !isInternalDiagnostic;
    }
    return isProductSystemAgentEvent(item);
  };

  return {
    __setState(nextState: any) {
      state = clone(nextState);
    },
    __getState() {
      return clone(state);
    },
    fetchProductState: vi.fn(async () => clone(state)),
    fetchPendingProductWorkflowMerges: vi.fn(async () => ({ items: [] })),
    keepProductWorkflowAsNew: vi.fn(async (workflowId: string) => ({
      state: clone(state),
      sourceWorkflowId: workflowId,
      decision: "create_new",
    })),
    applyProductWorkflowMergeProposal: vi.fn(
      async (sourceWorkflowId: string, targetWorkflowId?: string) => ({
        state: clone(state),
        sourceWorkflowId,
        canonicalProductWorkflowId: targetWorkflowId ?? sourceWorkflowId,
        canonicalGraph: null,
        graphPath: "",
        alreadyApplied: false,
      }),
    ),
    fetchProductWorkflowVersions: vi.fn(async (workflowId: string) => ({
      workflowId,
      workflowTitle: "Workflow",
      currentRevisionId: "revision-1",
      versions: [],
    })),
    restoreProductWorkflowVersion: vi.fn(
      async (workflowId: string, revisionId: string) => ({
        state: clone(state),
        workflowId,
        restoredFromRevisionId: revisionId,
        canonicalGraph: null,
        graphPath: "",
      }),
    ),
    fetchProductWorkflowGraph: vi.fn(async (input: any) => ({
      workflowId: input.workflowId,
      canonicalGraph: null,
      candidate: null,
      mergeProposal: null,
      paths: {
        graphPath: input.graphPath ?? null,
        candidatePath: input.candidatePath ?? null,
        mergeProposalPath: input.mergeProposalPath ?? null,
      },
      errors: [],
    })),
    updateProductWorkflowGraph: vi.fn(),
    refreshProductHermes: vi.fn(async () => clone(state)),
    prepareProductCapabilityProvider: vi.fn(async () => ({
      state: clone(state),
      provider: clone(
        state.capabilityProviders?.find(
          (item: any) => item.id === "chrome",
        ) ?? {
          id: "chrome",
          label: "Chrome",
          installed: true,
          status: "not_checked",
          detail: "Browser automation is installed.",
        },
      ),
    })),
    checkProductCapabilityProvider: vi.fn(async (providerId: string) => {
      const nextState = updateState((draft) => {
        draft.capabilityProviders = draft.capabilityProviders.map(
          (provider: any) =>
            provider.id === providerId
              ? {
                  ...provider,
                  status: "ready",
                  installed: true,
                  lastError: null,
                  detail:
                    "Chrome is ready for web workflows that need the signed-in browser.",
                }
              : provider,
        );
      });
      return {
        state: nextState,
        provider: clone(
          nextState.capabilityProviders.find(
            (provider: any) => provider.id === providerId,
          ),
        ),
      };
    }),
    fetchProductClawHubAuth: vi.fn(async () => ({
      status: "signed_out",
      handle: null,
      siteUrl: "https://clawhub.ai",
    })),
    beginProductClawHubLogin: vi.fn(async () => ({
      loginId: "login-test",
      verificationUrl: "https://clawhub.ai/device",
      userCode: "TEST-CODE",
      expiresAt: "2026-06-24T18:10:00.000Z",
    })),
    fetchProductClawHubLoginStatus: vi.fn(async () => ({
      loginId: "login-test",
      status: "pending",
      auth: {
        status: "signed_out",
        handle: null,
        siteUrl: "https://clawhub.ai",
      },
      error: null,
    })),
    publishProductWorkflowToClawHub: vi.fn(async () => ({
      status: "published",
      ownerHandle: "test-publisher",
      slug: "test-workflow",
      version: "1.0.0",
      listingUrl: "https://clawhub.ai/test-publisher/skills/test-workflow",
      installCommand: "openclaw skills install @test-publisher/test-workflow",
    })),
    installProductWorkflow: vi.fn(async (input: any) => {
      const nextState = updateState((draft) => {
        const worker = draft.workers.find(
          (item: any) => item.id === input.workerId,
        );
        if (!worker) {
          throw new Error(`Unknown worker: ${input.workerId}`);
        }
        const existing = draft.installedWorkflows.find(
          (item: any) =>
            item.workerId === input.workerId &&
            item.workflowId === input.workflowId,
        );
        const installedWorkflow = {
          id: existing?.id ?? `installed-${input.workflowId}-${input.workerId}`,
          workerId: input.workerId,
          workflowId: input.workflowId,
          workflowTitle: input.workflowTitle,
          description: input.description,
          status: "Enabled",
          apps: input.apps,
          installedAt: existing?.installedAt ?? "2026-06-24T18:00:00.000Z",
          deployTargetDeviceId: worker.deviceId,
          approvalPolicy: "allow_all",
          hermesSkillReference: `hermes-skill:${input.workflowId}`,
          hermesInstallReference: `hermes-install:${input.workflowId}`,
          hermesSkillName: input.workflowTitle,
          hermesSkillPath: input.skillPath ?? null,
          baselineRuns: existing?.baselineRuns ?? 0,
          baselineSuccesses: existing?.baselineSuccesses ?? 0,
          baselineLastRun: existing?.baselineLastRun ?? "Not run yet",
          updateAvailable: false,
        };
        draft.installedWorkflows = existing
          ? draft.installedWorkflows.map((item: any) =>
              item.id === existing.id ? installedWorkflow : item,
            )
          : [installedWorkflow, ...draft.installedWorkflows];
        draft.workers = draft.workers.map((item: any) =>
          item.id === input.workerId
            ? {
                ...item,
                status: "Available",
                tone: "ready",
                heartbeat: "Workflow ready to start",
                activities: [
                  `${input.workflowTitle} installed`,
                  "Ready for the next run",
                  "No active task",
                ],
              }
            : item,
        );
      });
      return {
        state: nextState,
        installedWorkflow: nextState.installedWorkflows.find(
          (item: any) =>
            item.workerId === input.workerId &&
            item.workflowId === input.workflowId,
        ),
      };
    }),
    deleteProductWorkflow: vi.fn(async (input: any) => {
      const tombstone = {
        workflowId: input.workflowId,
        workflowTitle: input.workflowTitle,
        deletedAt: "2026-06-24T18:00:00.000Z",
        deletedByAccountId: state.account.id,
      };
      const nextState = updateState((draft) => {
        const removedAssignments = draft.installedWorkflows.filter(
          (item: any) => item.workflowId === input.workflowId,
        );
        const removedAssignmentIds = new Set(
          removedAssignments.map((item: any) => item.id),
        );
        draft.workflowTombstones = [
          tombstone,
          ...draft.workflowTombstones.filter(
            (item: any) => item.workflowId !== input.workflowId,
          ),
        ];
        draft.installedWorkflows = draft.installedWorkflows.filter(
          (item: any) => !removedAssignmentIds.has(item.id),
        );
        draft.approvalPolicies = draft.approvalPolicies.filter(
          (policy: any) =>
            policy.scopeType !== "installed_workflow" ||
            !removedAssignmentIds.has(policy.scopeId),
        );
        draft.workers = draft.workers.map((worker: any) => ({
          ...worker,
          selectedInstalledWorkflowId:
            worker.selectedInstalledWorkflowId &&
            removedAssignmentIds.has(worker.selectedInstalledWorkflowId)
              ? null
              : worker.selectedInstalledWorkflowId,
        }));
      });
      return { state: nextState, tombstone };
    }),
    setupProductAccount: vi.fn(async (input: any) =>
      updateState((draft) => {
        draft.account = {
          ...draft.account,
          name: input.name,
          email: input.email,
          signedInLabel: input.workspaceName,
          setupCompleted: true,
        };
        draft.workspace = {
          ...draft.workspace,
          name: input.workspaceName,
        };
      }),
    ),
    assignProductDevice: vi.fn(async (input: any) => {
      const nextState = updateState((draft) => {
        const worker = draft.workers.find(
          (item: any) => item.id === input.workerId,
        );
        const device = draft.devices.find(
          (item: any) => item.id === input.deviceId,
        );
        if (!worker || !device) {
          throw new Error("Unknown device assignment target.");
        }
        draft.devices = draft.devices.map((item: any) => {
          if (item.id === device.id) {
            return { ...item, assignedWorkerId: worker.id };
          }
          if (item.assignedWorkerId === worker.id) {
            return { ...item, assignedWorkerId: null };
          }
          return item;
        });
        draft.workers = draft.workers.map((item: any) => {
          if (item.id === worker.id) {
            return {
              ...item,
              deviceId: device.id,
              status: "Available",
              tone: "ready",
              heartbeat: `${device.name} assigned`,
            };
          }
          if (item.deviceId === device.id) {
            return {
              ...item,
              deviceId: null,
              status: "Needs device",
              tone: "warning",
              heartbeat: "No computer assigned",
            };
          }
          return item;
        });
      });
      return {
        state: nextState,
        worker: nextState.workers.find(
          (worker: any) => worker.id === input.workerId,
        ),
        device: nextState.devices.find(
          (device: any) => device.id === input.deviceId,
        ),
      };
    }),
    createProductWorker: vi.fn(async (input: any) => {
      const workerId = `worker-${input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/^-|-$/gu, "")}`;
      const channelPlatform = input.channel?.platform ?? "none";
      const channelLabel =
        channelPlatform === "slack"
          ? "Slack"
          : channelPlatform === "weixin"
            ? "WeChat"
            : channelPlatform === "wecom"
              ? "WeCom"
              : "No channel";
      const nextState = updateState((draft) => {
        const worker = {
          id: workerId,
          name: input.name,
          initials: input.name
            .split(/\s+/u)
            .slice(0, 2)
            .map((part: string) => part[0]?.toUpperCase() ?? "")
            .join(""),
          description: input.description,
          status: "Needs device",
          tone: "warning",
          avatarKey: "sales",
          deviceId: null,
          heartbeat: "AI worker profile created",
          activities: [
            `AI worker profile ow-${workerId} created`,
            "Device assignment needed",
            "Ready for workflow install",
          ],
          config: {
            identityScope: input.sourceText || input.description,
            runtimeProfile: "AI worker / isolated local profile",
            toolAccess: [
              "browser control",
              "desktop automation",
              ...(channelPlatform === "none"
                ? []
                : [`${channelLabel} channel`]),
            ],
            memoryContext: "Local workspace memory",
            approvalPolicy: "allow_all",
            heartbeatPolicy: "Check local AI worker profile health while idle.",
            hermesAgentReference: `hermes-profile:ow-${workerId}`,
            channel: {
              platform: channelPlatform,
              label: channelLabel,
              accessMode: input.channel?.accessMode ?? "disabled",
              homeChannel: input.channel?.homeChannel ?? null,
              allowedUsers: input.channel?.allowedUsers ?? [],
              configuredFields: Object.entries(input.channel?.credentials ?? {})
                .filter(([, value]) => String(value).trim().length > 0)
                .map(([key]) => key),
              missingFields: [],
              status:
                channelPlatform === "none" ? "not_configured" : "configured",
              lastTestedAt: null,
              lastError: null,
            },
          },
        };
        draft.workers = [worker, ...draft.workers];
        draft.approvalPolicies = [
          {
            id: `approval-policy-worker-${workerId}`,
            scopeType: "worker",
            scopeId: workerId,
            mode: "allow_all",
            description:
              "AI worker can proceed under allow_all; progress appears in run events.",
            updatedAt: "2026-06-24T18:00:00.000Z",
          },
          ...draft.approvalPolicies,
        ];
      });
      return {
        state: nextState,
        worker: nextState.workers.find((worker: any) => worker.id === workerId),
      };
    }),
    deleteProductWorker: vi.fn(async (workerId: string) => {
      const worker = findWorker(workerId);
      const removedAssignmentIds = new Set(
        state.installedWorkflows
          .filter((workflow: any) => workflow.workerId === workerId)
          .map((workflow: any) => workflow.id),
      );
      const nextState = updateState((draft) => {
        draft.workers = draft.workers.filter(
          (item: any) => item.id !== workerId,
        );
        draft.devices = draft.devices.map((device: any) =>
          device.assignedWorkerId === workerId
            ? { ...device, assignedWorkerId: null }
            : device,
        );
        draft.installedWorkflows = draft.installedWorkflows.filter(
          (workflow: any) => workflow.workerId !== workerId,
        );
        draft.channelConnections = (draft.channelConnections ?? []).filter(
          (connection: any) => connection.workerId !== workerId,
        );
        draft.channelSetups = (draft.channelSetups ?? []).filter(
          (setup: any) => setup.workerId !== workerId,
        );
        draft.channelBindings = (draft.channelBindings ?? []).filter(
          (binding: any) => binding.workerId !== workerId,
        );
        draft.approvalPolicies = draft.approvalPolicies.filter(
          (policy: any) =>
            !(policy.scopeType === "worker" && policy.scopeId === workerId) &&
            !(
              policy.scopeType === "installed_workflow" &&
              removedAssignmentIds.has(policy.scopeId)
            ),
        );
      });
      return { state: nextState, worker };
    }),
    testProductWorkerChannel: vi.fn(async (workerId: string) => {
      let testedWorker: any = null;
      const nextState = updateState((draft) => {
        draft.workers = draft.workers.map((worker: any) => {
          if (worker.id !== workerId) {
            return worker;
          }
          testedWorker = {
            ...worker,
            config: {
              ...worker.config,
              channel: {
                ...worker.config.channel,
                status: "connected",
                lastTestedAt: "2026-06-24T18:00:00.000Z",
                lastError: null,
              },
            },
          };
          return testedWorker;
        });
        draft.channelConnections = (draft.channelConnections ?? []).map(
          (connection: any) =>
            connection.workerId === workerId
              ? {
                  ...connection,
                  status: "connected",
                  lastCheckedAt: "2026-06-24T18:00:00.000Z",
                  lastConnectedAt: "2026-06-24T18:00:00.000Z",
                  lastError: null,
                }
              : connection,
        );
      });
      return {
        state: nextState,
        worker: testedWorker,
        channel: testedWorker.config.channel,
      };
    }),
    configureProductWorkerChannel: vi.fn(async (input: any) => {
      const channelPlatform = input.channel?.platform ?? "none";
      const channelLabel =
        channelPlatform === "telegram"
          ? "Telegram"
          : channelPlatform === "slack"
            ? "Slack"
            : channelPlatform === "weixin"
              ? "WeChat"
              : channelPlatform === "whatsapp"
                ? "WhatsApp"
                : channelPlatform === "wecom"
                  ? "WeCom"
                  : "No channel";
      let configuredWorker: any = null;
      const nextState = updateState((draft) => {
        draft.workers = draft.workers.map((worker: any) => {
          if (worker.id !== input.workerId) {
            return worker;
          }
          configuredWorker = {
            ...worker,
            config: {
              ...worker.config,
              channel: {
                platform: channelPlatform,
                label: channelLabel,
                accessMode: input.channel?.accessMode ?? "disabled",
                homeChannel: input.channel?.homeChannel ?? null,
                allowedUsers: input.channel?.allowedUsers ?? [],
                configuredFields: Object.entries(
                  input.channel?.credentials ?? {},
                )
                  .filter(([, value]) => String(value).trim().length > 0)
                  .map(([key]) => key),
                missingFields: [],
                status:
                  channelPlatform === "none" ? "not_configured" : "configured",
                lastTestedAt: null,
                lastError: null,
              },
            },
          };
          return configuredWorker;
        });
        if (channelPlatform !== "none") {
          const connection = {
            id: `channel-${input.workerId}-${channelPlatform}`,
            workerId: input.workerId,
            platform: channelPlatform,
            label: channelLabel,
            setupMethod:
              channelPlatform === "telegram" ? "bot_token" : "app_tokens",
            status: "connecting",
            accountLabel: null,
            hermesProfile: configuredWorker.config.hermesAgentReference,
            configuredFields: configuredWorker.config.channel.configuredFields,
            missingFields: [],
            lastCheckedAt: null,
            lastConnectedAt: null,
            lastError: null,
            createdAt: "2026-06-24T18:00:00.000Z",
            updatedAt: "2026-06-24T18:00:00.000Z",
          };
          draft.channelConnections = [
            connection,
            ...(draft.channelConnections ?? []).filter(
              (item: any) => item.id !== connection.id,
            ),
          ];
        }
      });
      return {
        state: nextState,
        worker: configuredWorker,
        channel: configuredWorker.config.channel,
      };
    }),
    beginProductWorkerChannelSetup: vi.fn(async (input: any) => {
      const setup = {
        id: `channel-setup-${input.workerId}-${input.setup.platform}`,
        connectionId: `channel-${input.workerId}-${input.setup.platform}`,
        workerId: input.workerId,
        platform: input.setup.platform,
        status: "starting",
        qrPayload: null,
        qrExpiresAt: null,
        accountLabel: null,
        processId: 4242,
        lastError: null,
        createdAt: "2026-06-24T18:00:00.000Z",
        updatedAt: "2026-06-24T18:00:00.000Z",
      };
      const connection = {
        id: setup.connectionId,
        workerId: input.workerId,
        platform: input.setup.platform,
        label: input.setup.platform === "weixin" ? "WeChat" : "WhatsApp",
        setupMethod: "qr_link",
        status: "connecting",
        accountLabel: null,
        hermesProfile: findWorker(input.workerId).config.hermesAgentReference,
        configuredFields: [],
        missingFields: ["QR_LINK"],
        lastCheckedAt: setup.updatedAt,
        lastConnectedAt: null,
        lastError: null,
        createdAt: setup.createdAt,
        updatedAt: setup.updatedAt,
      };
      const nextState = updateState((draft) => {
        draft.channelSetups = [
          setup,
          ...(draft.channelSetups ?? []).filter(
            (item: any) => item.id !== setup.id,
          ),
        ];
        draft.channelConnections = [
          connection,
          ...(draft.channelConnections ?? []).filter(
            (item: any) => item.id !== connection.id,
          ),
        ];
      });
      return { state: nextState, setup, connection };
    }),
    readProductWorkerChannelSetup: vi.fn(async (input: any) => {
      const setup = state.channelSetups.find(
        (item: any) => item.id === input.setupId,
      );
      const connection = state.channelConnections.find(
        (item: any) => item.id === setup?.connectionId,
      );
      return { state: clone(state), setup, connection };
    }),
    cancelProductWorkerChannelSetup: vi.fn(async (input: any) => {
      let cancelledSetup: any = null;
      const nextState = updateState((draft) => {
        draft.channelSetups = (draft.channelSetups ?? []).map((item: any) => {
          if (item.id !== input.setupId) return item;
          cancelledSetup = { ...item, status: "cancelled", processId: null };
          return cancelledSetup;
        });
      });
      const connection = nextState.channelConnections.find(
        (item: any) => item.id === cancelledSetup?.connectionId,
      );
      return { state: nextState, setup: cancelledSetup, connection };
    }),
    listProductWorkerChannelPeers: vi.fn(async () => ({ peers: [] })),
    approveProductWorkerChannelPairing: vi.fn(async (input: any) => ({
      state: clone(state),
      connection: state.channelConnections.find(
        (item: any) => item.id === input.pairing.connectionId,
      ),
      approval: {
        platform: "slack",
        userId: "U123",
        userName: "alex",
      },
    })),
    bindProductWorkerChannel: vi.fn(async () => ({ state: clone(state) })),
    disconnectProductWorkerChannel: vi.fn(async (input: any) => {
      const connection = state.channelConnections.find(
        (item: any) => item.id === input.connectionId,
      );
      const nextState = updateState((draft) => {
        draft.channelConnections = (draft.channelConnections ?? []).filter(
          (item: any) => item.id !== input.connectionId,
        );
        draft.channelBindings = (draft.channelBindings ?? []).filter(
          (item: any) => item.connectionId !== input.connectionId,
        );
        draft.channelSetups = (draft.channelSetups ?? []).filter(
          (item: any) => item.connectionId !== input.connectionId,
        );
        draft.workers = draft.workers.map((worker: any) =>
          worker.id === input.workerId
            ? {
                ...worker,
                config: {
                  ...worker.config,
                  channel: defaultTestChannelConfig("none"),
                },
              }
            : worker,
        );
      });
      return { state: nextState, connection };
    }),
    updateProductWorkerConfig: vi.fn(async (input: any) => {
      const nextState = updateState((draft) => {
        draft.workers = draft.workers.map((worker: any) =>
          worker.id === input.workerId
            ? {
                ...worker,
                config: {
                  ...input.config,
                  approvalPolicy: "allow_all",
                },
                activities: [
                  "AI worker setup saved",
                  "Runtime profile ready",
                  "Approval policy allow_all",
                ],
              }
            : worker,
        );
      });
      return {
        state: nextState,
        worker: nextState.workers.find(
          (worker: any) => worker.id === input.workerId,
        ),
      };
    }),
    startProductWorker: vi.fn(async (workerId: string) => {
      const worker = findWorker(workerId);
      const installedWorkflow = firstRunnableWorkflow(workerId);
      const run = {
        id: `run-${workerId}-active`,
        workerId,
        installedWorkflowId: installedWorkflow.id,
        workflowTitle: installedWorkflow.workflowTitle,
        status: "running",
        command: null,
        startedAt: "2026-06-24T18:01:00.000Z",
        endedAt: null,
        hermesSessionId: "hermes-session-1",
        errorMessage: null,
      };
      return updateState((draft) => {
        draft.runs = [run, ...draft.runs];
        draft.runEvents = [
          event({
            runId: run.id,
            workerId,
            source: "system",
            status: "Initialized",
            body: `${worker.name} connected to ${worker.config.hermesAgentReference}.`,
          }),
          event({
            runId: run.id,
            workerId,
            source: "hermes",
            status: "AI worker started",
            body: "AI worker loaded the installed workflow and is ready for the next screen action.",
          }),
          ...draft.runEvents,
        ];
        draft.workers = draft.workers.map((item: any) =>
          item.id === workerId
            ? {
                ...item,
                status: "Available",
                tone: "ready",
                heartbeat: "AI worker working",
                activities: [
                  `${installedWorkflow.workflowTitle} running`,
                  "AI worker returned first response",
                  "Run events are live",
                ],
              }
            : item,
        );
      });
    }),
    runProductInstalledWorkflow: vi.fn(async (installedWorkflowId: string) => {
      const installedWorkflow = state.installedWorkflows.find(
        (item: any) => item.id === installedWorkflowId,
      );
      if (!installedWorkflow) {
        throw new Error(`Unknown installed workflow: ${installedWorkflowId}`);
      }
      const worker = findWorker(installedWorkflow.workerId);
      const run = {
        id: `run-${installedWorkflowId}`,
        workerId: worker.id,
        installedWorkflowId: installedWorkflow.id,
        workflowTitle: installedWorkflow.workflowTitle,
        status: "running",
        command: null,
        startedAt: "2026-06-24T18:01:00.000Z",
        endedAt: null,
        hermesSessionId: "hermes-session-1",
        errorMessage: null,
      };
      const nextState = updateState((draft) => {
        draft.runs = [run, ...draft.runs];
        draft.runEvents = [
          event({
            runId: run.id,
            workerId: worker.id,
            source: "system",
            status: "Initialized",
            body: `${worker.name} connected to ${worker.config.hermesAgentReference}.`,
          }),
          event({
            runId: run.id,
            workerId: worker.id,
            source: "hermes",
            status: "AI worker started",
            body: "AI worker loaded the installed workflow and is ready for the next screen action.",
          }),
          ...draft.runEvents,
        ];
        draft.workers = draft.workers.map((item: any) =>
          item.id === worker.id
            ? {
                ...item,
                status: "Available",
                tone: "ready",
                heartbeat: "AI worker working",
                activities: [
                  `${installedWorkflow.workflowTitle} running`,
                  "AI worker returned first response",
                  "Run events are live",
                ],
              }
            : item,
        );
      });
      return {
        state: nextState,
        run: nextState.runs.find((item: any) => item.id === run.id),
      };
    }),
    stopProductWorker: vi.fn(async (workerId: string) =>
      updateState((draft) => {
        draft.runs = draft.runs.map((run: any) =>
          run.workerId === workerId && run.status === "running"
            ? {
                ...run,
                status: "paused",
                endedAt: "2026-06-24T18:04:00.000Z",
              }
            : run,
        );
        draft.workers = draft.workers.map((worker: any) =>
          worker.id === workerId
            ? {
                ...worker,
                status: "Available",
                tone: "ready",
                heartbeat: "Recently active",
              }
            : worker,
        );
      }),
    ),
    sendProductWorkerCommand: vi.fn(async (input: any) => {
      const activeRun = state.runs.find(
        (run: any) =>
          run.workerId === input.workerId && run.status === "running",
      );
      if (!activeRun) {
        throw new Error("Start worker before sending worker commands.");
      }
      const commandRecord = {
        id: `command-${Date.now()}`,
        runId: activeRun.id,
        workerId: input.workerId,
        command: input.command,
        source: "agent_chat",
        status: "accepted",
        createdAt: "2026-06-24T18:02:00.000Z",
        errorMessage: null,
      };
      const commandEvent = event({
        runId: activeRun.id,
        workerId: input.workerId,
        source: "user",
        status: "Command",
        body: input.command,
      });
      const workflowEvent = event({
        runId: activeRun.id,
        workerId: input.workerId,
        source: "executor",
        status: "Workflow selected",
        body: `Using ${activeRun.workflowTitle}. Sending the command to the AI worker with allow_all policy.`,
      });
      const hermesEvent = event({
        runId: activeRun.id,
        workerId: input.workerId,
        source: "hermes",
        status: "AI worker response",
        body: "AI worker is processing the inbound customer email with the installed workflow skill.",
      });
      const nextState = updateState((draft) => {
        draft.commands = [commandRecord, ...draft.commands];
        draft.runs = draft.runs.map((run: any) =>
          run.id === activeRun.id ? { ...run, command: input.command } : run,
        );
        draft.runEvents = [
          hermesEvent,
          workflowEvent,
          commandEvent,
          ...draft.runEvents,
        ];
      });
      return {
        state: nextState,
        run: nextState.runs.find((run: any) => run.id === activeRun.id),
        event: commandEvent,
        commandRecord,
      };
    }),
    updateProductInstalledWorkflowStatus: vi.fn(
      async (input: { installedWorkflowId: string; status: string }) =>
        updateState((draft) => {
          draft.installedWorkflows = draft.installedWorkflows.map(
            (workflow: any) =>
              workflow.id === input.installedWorkflowId
                ? { ...workflow, status: input.status }
                : workflow,
          );
        }),
    ),
    deleteProductInstalledWorkflow: vi.fn(
      async (installedWorkflowId: string) => {
        const deletedWorkflow = state.installedWorkflows.find(
          (workflow: any) => workflow.id === installedWorkflowId,
        );
        if (!deletedWorkflow) {
          throw new Error(`Unknown installed workflow: ${installedWorkflowId}`);
        }
        const nextState = updateState((draft) => {
          draft.installedWorkflows = draft.installedWorkflows.filter(
            (workflow: any) => workflow.id !== installedWorkflowId,
          );
        });
        return {
          state: nextState,
          installedWorkflow: deletedWorkflow,
        };
      },
    ),
    productWorkerAvatarUrl: vi.fn((worker: any) => `/avatars/${worker.id}.png`),
    productWorkerDeviceLabel: vi.fn((productState: any, worker: any) => {
      if (!worker.deviceId) {
        return "Unassigned";
      }
      return (
        productState.devices.find(
          (device: any) => device.id === worker.deviceId,
        )?.name ?? "Unassigned"
      );
    }),
    activeProductRunForWorker: vi.fn((productState: any, workerId: string) => {
      return (
        productState?.runs.find(
          (run: any) => run.workerId === workerId && run.status === "running",
        ) ?? null
      );
    }),
    productAgentConversationEventsForWorker: vi.fn(
      (productState: any, workerId: string, runId?: string | null) => {
        if (!productState) {
          return [];
        }
        return productState.runEvents
          .filter(
            (item: any) =>
              item.workerId === workerId && (!runId || item.runId === runId),
          )
          .filter(isAgentConversationEvent)
          .sort(
            (left: any, right: any) =>
              Date.parse(right.createdAt) - Date.parse(left.createdAt),
          )
          .slice(0, 100)
          .reverse();
      },
    ),
    installedProductWorkflowsForWorker: vi.fn(
      (productState: any, workerId: string) =>
        (productState?.installedWorkflows ?? []).filter(
          (workflow: any) => workflow.workerId === workerId,
        ),
    ),
  };
});

vi.mock("../src/product-runtime", () => productRuntimeMock);

const settingsRuntimeMock = vi.hoisted(() => {
  const callProfileKeys = [
    "workflow-discovery",
    "skill-extraction-step",
    "skill-extraction-terminal",
    "planner-optimization",
    "scenario-prediction",
    "scenario-generalization",
  ];
  const llmConfig = {
    provider: "dit",
    baseUrl: "https://morbuke.com/v1",
    model: "gpt-5.5",
    wireApi: "responses",
    reasoningEffort: "xhigh",
    responseReadTimeoutMs: 90_000,
    responseTimeoutMode: "idle",
    callProfiles: Object.fromEntries(
      callProfileKeys.map((key) => [
        key,
        {
          reasoningEffort: null,
          responseReadTimeoutMs: null,
        },
      ]),
    ),
    clientProfile: "openai-js",
    authMode: "env",
    apiKeyEnv: "OPENAI_API_KEY",
    hasStoredApiKey: false,
    hasResolvedApiKey: true,
  };

  return {
    checkRuntimeRecorderPermissions: vi.fn(async () => ({
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
    })),
    bootstrapRuntimeRecorder: vi.fn(async () => ({
      startedAt: "2026-06-24T18:00:00.000Z",
      completedAt: "2026-06-24T18:00:01.000Z",
      stage: "ready",
      ready: true,
      summary: "Recorder is ready.",
      logPath: null,
    })),
    fetchRuntimeLlmConfig: vi.fn(async () => ({
      path: "/Users/appleuser/Documents/New_project/config/llm.config.json",
      config: structuredClone(llmConfig),
    })),
    fetchRuntimeLlmModels: vi.fn(async () => ({
      endpoint: "https://morbuke.com/v1/models",
      models: ["gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
    })),
    updateRuntimeLlmConfig: vi.fn(async (input: any) => ({
      path: "/Users/appleuser/Documents/New_project/config/llm.config.json",
      config: {
        ...structuredClone(llmConfig),
        ...input,
        hasStoredApiKey: false,
        hasResolvedApiKey: true,
      },
    })),
  };
});

vi.mock("../src/settings-runtime", () => settingsRuntimeMock);

describe("OysterWorkflow product UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    settingsRuntimeMock.checkRuntimeRecorderPermissions
      .mockReset()
      .mockResolvedValue({
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
          {
            kind: "accessibility",
            label: "Accessibility",
            description: "Allows UI event capture.",
            state: "granted",
            detail: "",
          },
        ],
      });
    delete (window as any).oysterworkflow;
    window.localStorage.clear();
    productRuntimeMock.__setState(
      buildProductState({
        installedWorkflows: buildInstalledWorkflows({
          includeFreshDeploy: true,
          total: 33,
        }),
      }),
    );
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      window.setTimeout(callback, 0);
      return 0;
    };
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders the productized AI worker workspace from real product state", async () => {
    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "AI workers" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByText("alexyang@oysterworkflow.com")).toBeInTheDocument();
    expect(productRuntimeMock.fetchProductState).toHaveBeenCalledTimes(1);
    expect(productRuntimeMock.refreshProductHermes).not.toHaveBeenCalled();

    const summary = screen.getByLabelText("Installed workflow summary");
    expect(
      within(summary).getByText("Installed workflows"),
    ).toBeInTheDocument();
    expect(within(summary).getByText("33")).toBeInTheDocument();
    expect(within(summary).getByText("Total runs")).toBeInTheDocument();
    expect(within(summary).getByText("147")).toBeInTheDocument();
    expect(within(summary).getByText("Success rate")).toBeInTheDocument();
    expect(within(summary).getByText("93.2%")).toBeInTheDocument();

    expect(
      screen.getByRole("tab", { name: "Installed workflows" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByText("Showing 1-6 of 33 matching workflows"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Trigger")).not.toBeInTheDocument();
    expect(screen.getAllByText("Allow all").length).toBeGreaterThan(0);
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Setup incomplete")).toBeInTheDocument();
    expect(screen.getAllByText("WeChat").length).toBeGreaterThan(0);
    expect(screen.getByText("LLM provider")).toBeInTheDocument();
    expect(screen.getByText("local / gpt-5.5")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(
      await screen.findByRole("heading", { name: "Devices" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Planned work" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Availability rules" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Think when idle")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Review inbox when work starts"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Message routing" }),
    ).toBeInTheDocument();
  });

  it("shows a neutral message channel until the user configures one", async () => {
    const state = productRuntimeMock.__getState();
    const salesWorker = state.workers.find(
      (worker: any) => worker.id === "sales",
    );
    salesWorker.config.channel = {
      ...salesWorker.config.channel,
      platform: "slack",
      label: "Slack",
      status: "not_configured",
      configuredFields: [],
      missingFields: ["Local credentials"],
    };
    productRuntimeMock.__setState(state);

    render(<App />);

    expect(await screen.findByText("Message channel")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(
      screen.getByText("Choose the message app this AI worker should use"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Finish verification and bind a conversation"),
    ).not.toBeInTheDocument();
  });

  it("offers Chrome recovery without exposing raw window-binding diagnostics", async () => {
    const user = userEvent.setup();
    const state = productRuntimeMock.__getState();
    const rawDiagnostic =
      "Error 210101: {'code': -32000, 'message': 'Browser window not found'}";
    state.capabilityProviders = [
      {
        id: "chrome",
        kind: "browser",
        label: "Chrome",
        description: "Use the signed-in local Chrome session.",
        status: "unavailable",
        enabled: true,
        installed: true,
        required: false,
        pinnedVersion: "1.0.6",
        version: "1.0.6",
        commandPath: "/tmp/oysterworkflow-browseract",
        lastCheckedAt: "2026-06-24T17:55:00.000Z",
        lastError: rawDiagnostic,
        lastSuccessAt: null,
        detail: "Chrome debug mode is active, but no window is connected.",
      },
    ];
    productRuntimeMock.__setState(state);

    render(<App />);

    const connectionsHeading = await screen.findByRole("heading", {
      name: "Connections",
    });
    const connectionsPanel = connectionsHeading.closest("section");
    expect(connectionsPanel).not.toBeNull();
    const detail = within(connectionsPanel!).getByText(
      /OysterWorkflow could not bind the current browser window after waiting for Chrome to start/u,
    );
    expect(within(connectionsPanel!).queryByText(rawDiagnostic)).toBeNull();
    const chromeRow = detail.closest(".worker-application-row");
    expect(chromeRow).not.toBeNull();

    await user.click(
      within(chromeRow!).getByRole("button", {
        name: "Reconnect",
      }),
    );

    await waitFor(() => {
      expect(
        productRuntimeMock.checkProductCapabilityProvider,
      ).toHaveBeenCalledWith("chrome");
    });
    expect(
      within(chromeRow!).getByRole("button", { name: "Check" }),
    ).toBeInTheDocument();
  });

  it("keeps Chrome actions disabled while the provider snapshot is checking", async () => {
    const state = productRuntimeMock.__getState();
    state.capabilityProviders = [
      {
        id: "chrome",
        kind: "browser",
        label: "Chrome",
        description: "Use the signed-in local Chrome session.",
        status: "checking",
        enabled: true,
        installed: true,
        required: false,
        pinnedVersion: "1.0.6",
        version: "1.0.6",
        commandPath: "/tmp/oysterworkflow-browseract",
        lastCheckedAt: null,
        lastError: null,
        lastSuccessAt: null,
        detail: "Checking Chrome from this device...",
      },
    ];
    productRuntimeMock.__setState(state);

    render(<App />);

    const connectionsPanel = (
      await screen.findByRole("heading", { name: "Connections" })
    ).closest("section");
    expect(connectionsPanel).not.toBeNull();
    expect(
      within(connectionsPanel!).getByRole("button", { name: "Checking" }),
    ).toBeDisabled();
  });

  it("checks the saved Hermes config without rewriting it from the worker panel", async () => {
    const user = userEvent.setup();
    render(<App />);

    const connectionsHeading = await screen.findByRole("heading", {
      name: "Connections",
    });
    const connectionsPanel = connectionsHeading.closest("section");
    expect(connectionsPanel).not.toBeNull();
    expect(productRuntimeMock.refreshProductHermes).not.toHaveBeenCalled();

    const checkButtons = within(connectionsPanel!).getAllByRole("button", {
      name: "Check",
    });
    await user.click(checkButtons.at(-1)!);

    await waitFor(() => {
      expect(productRuntimeMock.refreshProductHermes).toHaveBeenCalledTimes(1);
    });
    expect(settingsRuntimeMock.updateRuntimeLlmConfig).not.toHaveBeenCalled();
  });

  it("runs the desktop startup recorder check and prepares the recorder when permissions are ready", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "AI workers" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        within(screen.getByLabelText("Installed workflow summary")).getByText(
          "33",
        ),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        settingsRuntimeMock.checkRuntimeRecorderPermissions,
      ).toHaveBeenCalledWith({ force: false });
    });
    await waitFor(() => {
      expect(settingsRuntimeMock.bootstrapRuntimeRecorder).toHaveBeenCalledWith(
        {
          enableAudio: false,
          ocrLanguagePriority: ["chinese", "english"],
        },
      );
    });
  });

  it("opens first-run model setup while the recorder prepares in the background", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };
    settingsRuntimeMock.fetchRuntimeLlmConfig.mockResolvedValueOnce({
      path: "/Users/appleuser/Library/Application Support/OysterWorkflow/config/llm.config.json",
      config: {
        provider: "codex-local",
        baseUrl: "http://127.0.0.1:18080/v1",
        model: "gpt-5.5",
        wireApi: "responses",
        reasoningEffort: "xhigh",
        responseReadTimeoutMs: 180_000,
        responseTimeoutMode: "idle",
        callProfiles: Object.fromEntries(
          [
            "workflow-discovery",
            "skill-extraction-step",
            "skill-extraction-terminal",
            "planner-optimization",
            "scenario-prediction",
            "scenario-generalization",
          ].map((key) => [
            key,
            { reasoningEffort: null, responseReadTimeoutMs: null },
          ]),
        ),
        clientProfile: null,
        authMode: "env",
        apiKeyEnv: "OYSTERWORKFLOW_CODEX_API_KEY",
        hasStoredApiKey: false,
        hasResolvedApiKey: false,
      },
    });
    const startupState = productRuntimeMock.__getState();
    productRuntimeMock.prepareProductCapabilityProvider.mockResolvedValue({
      state: startupState,
      provider: {
        id: "chrome",
        label: "Chrome",
        installed: true,
        status: "not_checked",
        detail: "Browser automation is installed.",
      },
    });
    productRuntimeMock.refreshProductHermes
      .mockResolvedValueOnce({
        ...startupState,
        hermes: {
          ...startupState.hermes,
          available: false,
          lastError: "Model authentication is not configured yet.",
        },
      })
      .mockResolvedValueOnce(startupState);
    settingsRuntimeMock.bootstrapRuntimeRecorder
      .mockResolvedValueOnce({
        startedAt: "2026-06-24T18:00:00.000Z",
        completedAt: "2026-06-24T18:00:01.000Z",
        stage: "failed",
        ready: false,
        summary: "Recorder health check failed temporarily.",
        logPath: "/tmp/screenpipe-bootstrap.log",
      })
      .mockResolvedValueOnce({
        startedAt: "2026-06-24T18:00:02.000Z",
        completedAt: "2026-06-24T18:00:03.000Z",
        stage: "ready",
        ready: true,
        summary: "Recorder is ready.",
        logPath: null,
      });

    render(<App />);

    const setup = await screen.findByRole("dialog", {
      name: "Prepare OysterWorkflow",
    });
    expect(
      within(setup).getByRole("heading", { name: "Prepare OysterWorkflow" }),
    ).toBeInTheDocument();
    expect(within(setup).queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(
      within(setup).getByRole("combobox", { name: "Authentication" }),
    ).toHaveValue("none");
    expect(
      within(setup).getByText(/AI worker, Learning Mode/u),
    ).toBeInTheDocument();
    expect(within(setup).getAllByRole("progressbar")).toHaveLength(3);
    expect(
      within(setup).queryByRole("button", { name: "Set up later" }),
    ).not.toBeInTheDocument();
    expect(
      within(setup).queryByRole("button", { name: /close/iu }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".demo-main")).toHaveAttribute("inert");
    expect(document.querySelector(".demo-sidebar")).toHaveAttribute("inert");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(
      screen.getByRole("dialog", { name: "Prepare OysterWorkflow" }),
    ).toBeInTheDocument();
    const scrollRegion = within(setup).getByLabelText("LLM setup form");
    const scrollTo = vi.fn();
    Object.defineProperties(scrollRegion, {
      clientHeight: { configurable: true, value: 500 },
      scrollHeight: { configurable: true, value: 1_200 },
      scrollTop: { configurable: true, value: 0, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.keyDown(scrollRegion, { key: "PageDown" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 400, behavior: "smooth" });
    const startButton = within(setup).getByRole("button", {
      name: "Start using OysterWorkflow",
    });
    expect(startButton).toBeDisabled();
    await userEvent.click(
      within(setup).getByRole("button", { name: "Test LLM" }),
    );
    const resultToast = await screen.findByText("LLM provider is ready.");
    expect(resultToast).toHaveClass("demo-toast");
    expect(resultToast).toHaveAttribute("role", "status");
    expect(resultToast).toHaveAttribute("aria-live", "polite");
    expect(
      await within(setup).findByText("3 of 4 checks are ready."),
    ).toBeInTheDocument();
    expect(startButton).toBeDisabled();
    const retryLocalTools = within(setup).getByRole("button", {
      name: "Retry local tools",
    });
    await userEvent.click(retryLocalTools);
    await waitFor(() => {
      expect(
        settingsRuntimeMock.bootstrapRuntimeRecorder,
      ).toHaveBeenCalledTimes(2);
    });
    expect(
      await within(setup).findByText("Setup complete"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Prepare OysterWorkflow" }),
    ).toBeInTheDocument();
    await waitFor(() => expect(startButton).toBeEnabled());
    await userEvent.click(startButton);
    expect(
      screen.queryByRole("dialog", { name: "Prepare OysterWorkflow" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".demo-main")).not.toHaveAttribute("inert");
    expect(document.querySelector(".demo-sidebar")).not.toHaveAttribute(
      "inert",
    );
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    expect(settingsRuntimeMock.bootstrapRuntimeRecorder).toHaveBeenCalled();
    expect(productRuntimeMock.refreshProductHermes).toHaveBeenCalled();
    expect(
      productRuntimeMock.prepareProductCapabilityProvider,
    ).toHaveBeenCalledWith("chrome");
  });

  it("does not reprepare or reopen a completed workspace when enabling audio", async () => {
    window.localStorage.setItem(
      "oysterworkflow.startup-llm-setup-completed",
      "1",
    );
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };
    const user = userEvent.setup();

    render(<App />);

    await waitFor(() => {
      expect(settingsRuntimeMock.bootstrapRuntimeRecorder).toHaveBeenCalledWith(
        {
          enableAudio: false,
          ocrLanguagePriority: ["chinese", "english"],
        },
      );
    });
    expect(
      screen.queryByRole("dialog", { name: "Prepare OysterWorkflow" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(
      within(settings).getByRole("button", { name: "Learning Mode" }),
    );
    await user.click(within(settings).getByLabelText("Enable audio"));

    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(settings);
    expect(settingsRuntimeMock.bootstrapRuntimeRecorder).toHaveBeenCalledTimes(
      1,
    );
    expect(productRuntimeMock.refreshProductHermes).toHaveBeenCalledTimes(1);
    expect(
      productRuntimeMock.prepareProductCapabilityProvider,
    ).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("dialog", { name: "Prepare OysterWorkflow" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toEqual([settings]);
  });

  it("shows an empty-safe worker loading state before desktop product state hydrates", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };
    productRuntimeMock.fetchProductState.mockImplementationOnce(
      () => new Promise(() => undefined),
    );

    render(<App />);

    expect(await screen.findByText("Loading AI workers")).toBeInTheDocument();
    expect(screen.queryByText("Marketing Worker")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Prepare renewal risk note"),
    ).not.toBeInTheDocument();
  });

  it("prepares the recorder on desktop startup even when an old bootstrap cache exists", async () => {
    window.localStorage.setItem(
      "oysterworkflow.startup-recorder-bootstrap.completed",
      "true",
    );
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "AI workers" }),
      ).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(settingsRuntimeMock.bootstrapRuntimeRecorder).toHaveBeenCalledWith(
        {
          enableAudio: false,
          ocrLanguagePriority: ["chinese", "english"],
        },
      );
    });
  });

  it("blocks the desktop startup flow when recorder permissions are missing", async () => {
    const quitAndReopen = vi.fn(async () => true);
    const openPermissionSettings = vi.fn(async () => undefined);
    const requestRecorderPermission = vi.fn(async () => false);
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
      desktop: {
        quitAndReopen,
        openPermissionSettings,
        requestRecorderPermission,
      },
    };
    settingsRuntimeMock.checkRuntimeRecorderPermissions.mockResolvedValue({
      checkedAt: "2026-06-24T18:00:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "host-app",
      summary: "Screen Recording is required before recording.",
      items: [
        {
          kind: "screen-recording",
          label: "Screen Recording",
          description: "Allows screen capture.",
          state: "missing",
          detail: "Grant access in macOS System Settings.",
        },
      ],
    });

    render(<App />);

    expect(
      await screen.findByRole("dialog", {
        name: "Allow Learning Mode before continuing",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Request each permission below. macOS will guide you if System Settings is required.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Probe log:/u)).not.toBeInTheDocument();
    expect(settingsRuntimeMock.bootstrapRuntimeRecorder).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "Settings" }),
    ).not.toBeInTheDocument();
    settingsRuntimeMock.checkRuntimeRecorderPermissions.mockResolvedValue({
      checkedAt: "2026-06-24T18:00:01.000Z",
      allGranted: true,
      canStartRecording: true,
      source: "host-app",
      summary: "All required permissions are available.",
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
    await userEvent.click(
      screen.getByRole("button", { name: "Request permission" }),
    );
    expect(requestRecorderPermission).toHaveBeenCalledWith("screen-recording");
    expect(openPermissionSettings).not.toHaveBeenCalled();
    expect(await screen.findByText("Granted")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
    expect(settingsRuntimeMock.bootstrapRuntimeRecorder).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Quit & Reopen to Verify" }),
    );
    expect(quitAndReopen).toHaveBeenCalledTimes(1);
    settingsRuntimeMock.checkRuntimeRecorderPermissions.mockResolvedValue({
      checkedAt: "2026-06-24T18:00:02.000Z",
      allGranted: true,
      canStartRecording: true,
      source: "host-app",
      summary: "All required permissions are available.",
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
    expect(
      await screen.findByText("Granted", {}, { timeout: 3_000 }),
    ).toBeInTheDocument();
  });

  it("shows account setup only after the startup permission blocker closes", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };
    productRuntimeMock.__setState(
      buildProductState({
        account: {
          ...buildAccount(),
          setupCompleted: false,
        },
      }),
    );
    settingsRuntimeMock.checkRuntimeRecorderPermissions
      .mockResolvedValueOnce({
        checkedAt: "2026-06-24T18:00:00.000Z",
        allGranted: false,
        canStartRecording: false,
        source: "host-app",
        summary: "Screen Recording is required before recording.",
        items: [
          {
            kind: "screen-recording",
            label: "Screen Recording",
            description: "Allows screen capture.",
            state: "missing",
            detail: "Grant access in macOS System Settings.",
          },
        ],
      })
      .mockResolvedValueOnce({
        checkedAt: "2026-06-24T18:00:00.500Z",
        allGranted: false,
        canStartRecording: false,
        source: "host-app",
        summary: "Screen Recording is required before recording.",
        items: [
          {
            kind: "screen-recording",
            label: "Screen Recording",
            description: "Allows screen capture.",
            state: "missing",
            detail: "Grant access in macOS System Settings.",
          },
        ],
      })
      .mockResolvedValue({
        checkedAt: "2026-06-24T18:00:01.000Z",
        allGranted: true,
        canStartRecording: true,
        source: "host-app",
        summary: "All required permissions are available.",
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
    const user = userEvent.setup();

    render(<App />);

    const permissionDialog = await screen.findByRole("dialog", {
      name: "Allow Learning Mode before continuing",
    });
    expect(screen.getAllByRole("dialog")).toEqual([permissionDialog]);
    expect(
      screen.queryByRole("dialog", { name: "Account settings" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(permissionDialog).getByRole("button", { name: "Refresh status" }),
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Allow Learning Mode before continuing",
        }),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByRole("dialog", { name: "Account settings" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("keeps permission actions available during passive status polling", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
      desktop: {
        quitAndReopen: vi.fn(async () => true),
        requestRecorderPermission: vi.fn(async () => false),
      },
    };
    const missingPermissions = {
      checkedAt: "2026-06-24T18:00:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "host-app" as const,
      summary: "Screen Recording is required before recording.",
      items: [
        {
          kind: "screen-recording" as const,
          label: "Screen Recording",
          description: "Allows screen capture.",
          state: "missing" as const,
          detail: "Grant access in macOS System Settings.",
        },
      ],
    };
    settingsRuntimeMock.checkRuntimeRecorderPermissions
      .mockResolvedValueOnce(missingPermissions)
      .mockImplementationOnce(() => new Promise(() => undefined));

    render(<App />);

    const requestButton = await screen.findByRole("button", {
      name: "Request permission",
    });
    expect(requestButton).toBeEnabled();
    await waitFor(
      () => {
        expect(
          settingsRuntimeMock.checkRuntimeRecorderPermissions,
        ).toHaveBeenCalledTimes(2);
      },
      { timeout: 3_000 },
    );
    expect(requestButton).toBeEnabled();
  });

  it("serializes permission requests and restart actions while a system prompt is active", async () => {
    let finishPermissionRequest!: (value: boolean) => void;
    const permissionRequest = new Promise<boolean>((resolve) => {
      finishPermissionRequest = resolve;
    });
    const requestRecorderPermission = vi.fn(() => permissionRequest);
    const quitAndReopen = vi.fn(async () => true);
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
      desktop: {
        quitAndReopen,
        requestRecorderPermission,
      },
    };
    settingsRuntimeMock.checkRuntimeRecorderPermissions.mockResolvedValue({
      checkedAt: "2026-06-24T18:00:00.000Z",
      allGranted: false,
      canStartRecording: false,
      source: "host-app",
      summary: "Two permissions are required before recording.",
      items: [
        {
          kind: "screen-recording",
          label: "Screen Recording",
          description: "Allows screen capture.",
          state: "missing",
          detail: "Grant access in macOS System Settings.",
        },
        {
          kind: "accessibility",
          label: "Accessibility",
          description: "Allows interface observation.",
          state: "missing",
          detail: "Grant access in macOS System Settings.",
        },
      ],
    });
    const user = userEvent.setup();

    render(<App />);

    const dialog = await screen.findByRole("dialog", {
      name: "Allow Learning Mode before continuing",
    });
    const requestButtons = within(dialog).getAllByRole("button", {
      name: "Request permission",
    });
    await user.click(requestButtons[0]);

    expect(requestRecorderPermission).toHaveBeenCalledTimes(1);
    expect(requestButtons[1]).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Refresh status" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", {
        name: "Quit & Reopen to Verify",
      }),
    ).toBeDisabled();
    await user.click(requestButtons[1]);
    expect(requestRecorderPermission).toHaveBeenCalledTimes(1);
    expect(quitAndReopen).not.toHaveBeenCalled();

    finishPermissionRequest(false);
    await waitFor(() =>
      expect(
        within(dialog).getAllByRole("button", {
          name: "Request permission",
        })[0],
      ).toBeEnabled(),
    );
  });

  it("maps Hermes readiness into non-technical AI worker config without exposing provider details", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Config" }));

    expect(screen.getByText("Computer control ready")).toBeInTheDocument();
    expect(
      screen.getByText("Browser, files, screen reading, and workflow skills"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Managed automatically by OysterWorkflow"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Provider")).not.toBeInTheDocument();
    expect(screen.queryByText("Model")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Hermes Agent Reference"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByDisplayValue(/hermes-agent:/u),
    ).not.toBeInTheDocument();
  });

  it("keeps runtime restart recovery failures out of business summaries", async () => {
    productRuntimeMock.__setState(
      buildProductState({
        workers: buildWorkers().map((worker) =>
          worker.id === "sales"
            ? {
                ...worker,
                heartbeat: "Recovered after restart",
              }
            : worker,
        ),
        runs: [
          {
            ...run({
              id: "run-recovered-after-restart-a",
              workflowId: "installed-outlook-product-inquiry-sales",
              title: "Qualify Outlook inbound inquiry and draft follow-up",
              status: "failed",
              endedAt: "2026-06-24T17:54:00.000Z",
            }),
            errorMessage: "Runtime restarted before this run finished",
          },
          {
            ...run({
              id: "run-recovered-after-restart-b",
              workflowId: "installed-outlook-product-inquiry-sales",
              title: "Qualify Outlook inbound inquiry and draft follow-up",
              status: "failed",
              endedAt: "2026-06-24T17:53:00.000Z",
            }),
            errorMessage: "Runtime restarted before this run finished",
          },
          ...buildRuns(),
        ],
      }),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();

    const summary = screen.getByLabelText("Installed workflow summary");
    expect(within(summary).getByText("Total runs")).toBeInTheDocument();
    expect(within(summary).getByText("147")).toBeInTheDocument();
    expect(within(summary).getByText("Successful runs")).toBeInTheDocument();
    expect(within(summary).getByText("137")).toBeInTheDocument();
    expect(within(summary).getByText("Success rate")).toBeInTheDocument();
    expect(within(summary).getByText("93.2%")).toBeInTheDocument();

    const deployedRow = installedWorkflowRow(
      "Qualify Outlook inbound inquiry and draft follow-up",
    );
    expect(within(deployedRow).getByText("Runs")).toBeInTheDocument();
    expect(within(deployedRow).getByText("Success")).toBeInTheDocument();
    expect(within(deployedRow).getAllByText("0").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(within(deployedRow).getByText("Not run yet")).toBeInTheDocument();

    expect(
      screen.queryByText("Runtime restarted before this run finished"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Recovered after restart"),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByText("Start worker to prepare this AI worker").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Extract action items from customer meeting").length,
    ).toBeGreaterThan(0);
  });

  it("opens account utility panels from the sidebar profile", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Notifications" }));
    const notifications = await screen.findByRole("dialog", {
      name: "Notifications",
    });
    expect(
      within(notifications).queryByText("Workflow waiting for review"),
    ).not.toBeInTheDocument();
    expect(
      within(notifications).getByText("Latest run completed"),
    ).toBeInTheDocument();
    expect(
      within(notifications).getByText(/workers need a device/),
    ).toBeInTheDocument();

    await user.click(
      within(notifications).getAllByRole("button", { name: "Close" })[0],
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Notifications" }),
      ).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Help" }));
    const help = await screen.findByRole("dialog", { name: "Help" });
    expect(within(help).getByText("Demo path")).toBeInTheDocument();
    expect(within(help).getByText("Local data")).toBeInTheDocument();

    await user.click(
      within(help).getByRole("button", { name: "Account settings" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Account settings" }),
    ).toBeInTheDocument();
  });

  it("moves the selected worker forward from the worker strip arrow", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Sales AI Worker" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next worker" }));

    expect(
      await screen.findByRole("heading", { name: "Marketing Worker" }),
    ).toBeInTheDocument();
  });

  it("keeps future avatar and context attachment actions disabled", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();

    const uploadAvatar = screen.getByRole("button", { name: "Upload avatar" });
    expect(uploadAvatar).toBeDisabled();
    expect(uploadAvatar).toHaveAttribute(
      "title",
      "Avatar upload requires profile storage and is not available yet.",
    );

    await user.click(screen.getByRole("button", { name: "Start worker" }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });

    const attachContext = screen.getByRole("button", {
      name: "Attach context",
    });
    expect(attachContext).toBeDisabled();
    expect(attachContext).toHaveAttribute(
      "title",
      "Context attachments are not available until the command protocol supports them.",
    );
  });

  it("opens the unified Settings modal and saves Learning Mode plus model config", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    expect(
      within(settings).getByRole("button", { name: "General" }),
    ).toBeInTheDocument();

    await user.click(
      within(settings).getByRole("button", { name: "Learning Mode" }),
    );
    await user.selectOptions(
      within(settings).getByLabelText("OCR Priority 1"),
      "chinese",
    );
    await user.click(
      within(settings).getByRole("button", {
        name: "Save Learning Settings",
      }),
    );
    expect(
      within(settings).getByText(/Learning settings saved/u),
    ).toBeInTheDocument();

    await user.click(within(settings).getByRole("button", { name: "Model" }));
    await waitFor(() => {
      expect(settingsRuntimeMock.fetchRuntimeLlmConfig).toHaveBeenCalledTimes(
        1,
      );
    });
    expect(
      await within(settings).findByDisplayValue("gpt-5.5"),
    ).toBeInTheDocument();

    await user.click(
      within(settings).getByRole("button", { name: "Fetch models" }),
    );
    await waitFor(() => {
      expect(settingsRuntimeMock.fetchRuntimeLlmModels).toHaveBeenCalledWith({
        baseUrl: "https://morbuke.com/v1",
        authMode: "env",
        apiKey: null,
        apiKeyEnv: "OPENAI_API_KEY",
      });
    });
    await user.selectOptions(
      within(settings).getByRole("combobox", { name: "Model" }),
      "model:gpt-5.6-luna",
    );

    await user.click(
      within(settings).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => {
      expect(settingsRuntimeMock.updateRuntimeLlmConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://morbuke.com/v1",
          model: "gpt-5.6-luna",
          authMode: "env",
        }),
      );
    });
    expect(
      within(settings).getByText("Model settings saved."),
    ).toBeInTheDocument();
  });

  it("checks, downloads, and installs a desktop update from Settings", async () => {
    window.localStorage.setItem(
      "oysterworkflow.startup-llm-setup-completed",
      "1",
    );
    const available = {
      supported: true,
      phase: "available" as const,
      currentVersion: "0.2.2",
      availableVersion: "0.2.3",
      releaseName: "OysterWorkflow 0.2.3",
      releaseNotes: "Faster startup and update support.",
      releaseDate: "2026-07-21T18:00:00.000Z",
      checkedAt: "2026-07-21T18:05:00.000Z",
      progress: null,
      errorMessage: null,
    };
    const downloaded = { ...available, phase: "downloaded" as const };
    const installing = { ...available, phase: "installing" as const };
    const downloadUpdate = vi.fn(async () => downloaded);
    const installUpdate = vi.fn(async () => installing);
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
      desktop: {
        getUpdateState: vi.fn(async () => available),
        checkForUpdates: vi.fn(async () => available),
        downloadUpdate,
        installUpdate,
        onUpdateStateChanged: vi.fn(() => () => undefined),
      },
    };
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(
      within(settings).getByRole("button", { name: "Software Update" }),
    );

    expect(await within(settings).findByText("v0.2.2")).toBeInTheDocument();
    expect(within(settings).getByText("v0.2.3")).toBeInTheDocument();
    await user.click(
      within(settings).getByRole("button", { name: "Download Update" }),
    );
    await waitFor(() => {
      expect(downloadUpdate).toHaveBeenCalledTimes(1);
    });
    await user.click(
      await within(settings).findByRole("button", {
        name: "Restart and Install",
      }),
    );
    await waitFor(() => {
      expect(installUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("localizes update failures without showing release response details", async () => {
    window.localStorage.setItem(
      "oysterworkflow.startup-llm-setup-completed",
      "1",
    );
    window.localStorage.setItem("oysterworkflow.app-language", "zh");
    const updateError = {
      supported: true,
      phase: "error" as const,
      currentVersion: "0.2.2",
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      checkedAt: "2026-07-23T08:05:00.000Z",
      progress: null,
      errorMessage:
        "Cannot find latest.yml: HttpError 404 Headers: private details",
      errorCode: "release_metadata_unavailable" as const,
    };
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "win32",
      },
      desktop: {
        getUpdateState: vi.fn(async () => updateError),
        checkForUpdates: vi.fn(async () => updateError),
        downloadUpdate: vi.fn(),
        installUpdate: vi.fn(),
        onUpdateStateChanged: vi.fn(() => () => undefined),
      },
    };
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "设置" }));
    const settings = await screen.findByRole("dialog", { name: "设置" });
    await user.click(
      within(settings).getByRole("button", { name: "软件更新" }),
    );

    expect(
      await within(settings).findByText(
        "当前 Windows 版本的更新信息暂未发布，请稍后重试。",
      ),
    ).toBeInTheDocument();
    expect(
      within(settings).queryByText(/latest\.yml/iu),
    ).not.toBeInTheDocument();
    expect(within(settings).queryByText(/Headers/iu)).not.toBeInTheDocument();
  });

  it("tests the edited model fields without saving them", async () => {
    let finishConnectionCheck!: (value: {
      endpoint: string;
      models: string[];
    }) => void;

    settingsRuntimeMock.fetchRuntimeLlmModels.mockReturnValueOnce(
      new Promise((resolve) => {
        finishConnectionCheck = resolve;
      }),
    );

    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Settings" }));

    const settings = await screen.findByRole("dialog", {
      name: "Settings",
    });

    await user.click(within(settings).getByRole("button", { name: "Model" }));

    await within(settings).findByDisplayValue("gpt-5.5");

    await user.click(
      within(settings).getByRole("button", {
        name: "Test connection",
      }),
    );

    expect(
      await within(settings).findByRole("button", {
        name: "Testing...",
      }),
    ).toBeDisabled();

    expect(
      within(settings).getByRole("combobox", {
        name: "Authentication",
      }),
    ).toBeDisabled();

    expect(
      within(settings).getByRole("button", {
        name: "Save changes",
      }),
    ).toBeDisabled();

    expect(settingsRuntimeMock.fetchRuntimeLlmModels).toHaveBeenCalledWith({
      baseUrl: "https://morbuke.com/v1",
      authMode: "env",
      apiKey: null,
      apiKeyEnv: "OPENAI_API_KEY",
    });

    expect(settingsRuntimeMock.updateRuntimeLlmConfig).not.toHaveBeenCalled();

    expect(productRuntimeMock.refreshProductHermes).not.toHaveBeenCalled();

    finishConnectionCheck({
      endpoint: "https://morbuke.com/v1/models",
      models: ["gpt-5.5"],
    });

    expect(
      await within(settings).findByText(
        "Connection test passed. Save changes to use these settings.",
      ),
    ).toBeInTheDocument();

    expect(
      within(settings).getByRole("button", {
        name: "Test connection",
      }),
    ).toBeEnabled();
  });

  it("keeps manual model entry available when discovery fails or returns no models", async () => {
    const user = userEvent.setup();
    settingsRuntimeMock.fetchRuntimeLlmModels
      .mockRejectedValueOnce(new Error("Provider does not expose /models"))
      .mockResolvedValueOnce({
        endpoint: "https://morbuke.com/v1/models",
        models: [],
      });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(settings).getByRole("button", { name: "Model" }));

    await user.click(
      await within(settings).findByRole("button", { name: "Fetch models" }),
    );
    expect(
      await within(settings).findByText(
        /Unable to load models: Provider does not expose/u,
      ),
    ).toBeInTheDocument();
    expect(within(settings).getByLabelText("Custom model")).toHaveValue(
      "gpt-5.5",
    );

    await user.click(
      within(settings).getByRole("button", { name: "Fetch models" }),
    );
    expect(
      await within(settings).findByText(
        "No models were returned. Enter a model manually.",
      ),
    ).toBeInTheDocument();
    expect(within(settings).getByLabelText("Custom model")).toHaveValue(
      "gpt-5.5",
    );
  });

  it("assigns a trusted device to an AI worker from the Devices page", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Devices" }));
    expect(
      await screen.findByRole("heading", { name: "Alex's MacBook Pro" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Sales AI Worker").length).toBeGreaterThan(0);
    expect(screen.queryByText(/^sales$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Assign device" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Assign device",
    });
    await user.selectOptions(
      within(dialog).getByLabelText("AI worker"),
      "finance",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Trusted computer"),
      "alex-mbp",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save assignment" }),
    );

    expect(productRuntimeMock.assignProductDevice).toHaveBeenCalledWith({
      workerId: "finance",
      deviceId: "alex-mbp",
    });
    expect(
      await screen.findByText("Finance Worker assigned to Alex's MacBook Pro."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Finance Worker").length).toBeGreaterThan(0);
  });

  it("deploys a workflow, keeps run counts at zero, then shows live Agent messages only after Run", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        installedWorkflows: buildInstalledWorkflows({
          includeFreshDeploy: false,
          total: 32,
        }),
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    expect(
      await screen.findByRole("heading", { name: "Workflows" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Detected workflow:/)).toBeInTheDocument();
    expect(screen.getByLabelText("Workflow apps")).toHaveTextContent(
      "Microsoft Outlook",
    );
    expect(screen.queryByText("Current steps")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit steps" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Deploy to AI worker" }),
    );

    expect(productRuntimeMock.installProductWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "sales",
        workflowId: "inbound",
        workflowTitle: "Handle inbound opportunity",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        /Handle inbound opportunity deployed to this worker\./,
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Use the Run button on the installed workflow/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "AI worker loaded the installed workflow and is ready for the next screen action.",
      ),
    ).not.toBeInTheDocument();

    const deployedRow = installedWorkflowRow("Handle inbound opportunity");
    expect(within(deployedRow).getByText("Runs")).toBeInTheDocument();
    expect(within(deployedRow).getByText("Success")).toBeInTheDocument();
    expect(within(deployedRow).getAllByText("0").length).toBeGreaterThanOrEqual(
      2,
    );
    expect(within(deployedRow).getByText("Not run yet")).toBeInTheDocument();

    await user.click(
      within(deployedRow).getByRole("button", {
        name: "Run Handle inbound opportunity",
      }),
    );

    await waitFor(() => {
      expect(productRuntimeMock.runProductInstalledWorkflow).toHaveBeenCalled();
      expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Agent" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });

    await user.type(
      screen.getByLabelText("Message Sales AI Worker"),
      "continue process inbound customer email",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(productRuntimeMock.sendProductWorkerCommand).toHaveBeenCalledWith({
      workerId: "sales",
      command: "continue process inbound customer email",
    });
    expect(
      await screen.findByText("continue process inbound customer email"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Sending the command to the AI worker with allow_all policy/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "AI worker is processing the inbound customer email with the installed workflow skill.",
      ),
    ).toBeInTheDocument();
  });

  it("runs a ready installed workflow from Play and changes the active row to Pause", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        workers: buildWorkers().map((worker) =>
          worker.id === "sales"
            ? {
                ...worker,
                status: "Available",
                tone: "ready",
                heartbeat: "Workflow ready to start",
              }
            : worker,
        ),
      }),
    );

    render(<App />);

    expect(
      await screen.findByRole("button", { name: "Start worker" }),
    ).not.toBeDisabled();
    const workflowName = "Extract action items from customer meeting";
    const workflowRow = installedWorkflowRow(workflowName);
    await user.click(
      within(workflowRow).getByRole("button", {
        name: `Run ${workflowName}`,
      }),
    );

    await waitFor(() => {
      expect(
        productRuntimeMock.runProductInstalledWorkflow,
      ).toHaveBeenCalledWith("installed-action-items");
    });

    await user.click(screen.getByRole("tab", { name: "Installed workflows" }));
    const runningRow = installedWorkflowRow(workflowName);
    const pauseButton = await within(runningRow).findByRole("button", {
      name: `Pause ${workflowName}`,
    });
    expect(pauseButton).toHaveAttribute("aria-pressed", "true");

    await user.click(pauseButton);
    expect(productRuntimeMock.stopProductWorker).toHaveBeenCalledWith("sales");
  });

  it("passes the generated product workflow skill path when deploying to a Hermes worker", async () => {
    const user = userEvent.setup();
    const sourceSkillPath =
      "/Users/appleuser/Library/Application Support/oysterworkflow/runs/session-a/skill/skill.json";
    const generatedWorkflow = {
      ...workflow({
        id: "runtime-generated-skill",
        title: "Generated customer follow-up workflow",
        description:
          "Use a real generated workflow artifact when installing to Hermes.",
        status: "Generated",
        confidence: 91,
        apps: ["Microsoft Outlook", "Google Docs"],
        uiEvents: 412,
        duration: "4:18",
        decisions: 6,
      }),
      sourceType: "runtime",
      artifactPath: sourceSkillPath,
    } satisfies ProductWorkflow;
    productRuntimeMock.__setState(
      buildProductState({
        workflows: [generatedWorkflow],
        installedWorkflows: buildInstalledWorkflows({
          includeFreshDeploy: false,
          total: 0,
        }),
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    const workflowList = await screen.findByRole("list", {
      name: "Detected workflow list",
    });
    const generatedWorkflowButton = within(workflowList)
      .getByText("Generated customer follow-up workflow")
      .closest("button");
    expect(generatedWorkflowButton).not.toBeNull();
    await user.click(generatedWorkflowButton!);
    await user.click(
      await screen.findByRole("button", { name: "Deploy to AI worker" }),
    );

    expect(productRuntimeMock.installProductWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "sales",
        workflowId: "runtime-generated-skill",
        workflowTitle: "Generated customer follow-up workflow",
        skillPath: sourceSkillPath,
      }),
    );
  });

  it("clears local deploy affordances after the real installed workflow record is removed", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        installedWorkflows: buildInstalledWorkflows({
          includeFreshDeploy: false,
          total: 32,
        }),
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    await user.click(
      await screen.findByRole("button", { name: "Deploy to AI worker" }),
    );

    expect(
      installedWorkflowRow("Handle inbound opportunity"),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Remove Handle inbound opportunity",
      }),
    );

    expect(
      productRuntimeMock.deleteProductInstalledWorkflow,
    ).toHaveBeenCalledWith("installed-inbound-sales");
    await waitFor(() => {
      expect(
        screen.queryByText(
          /Handle inbound opportunity deployed to this worker\./,
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("heading", { name: "Handle inbound opportunity" }),
    ).not.toBeInTheDocument();
  });

  it("shows the in-flight Hermes command state before the runtime response returns", async () => {
    const user = userEvent.setup();
    let resolveCommand!: (value: any) => void;
    const commandPromise = new Promise<any>((resolve) => {
      resolveCommand = resolve;
    });

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Start worker" }),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });

    productRuntimeMock.sendProductWorkerCommand.mockImplementationOnce(
      () => commandPromise,
    );

    await user.type(
      screen.getByLabelText("Message Sales AI Worker"),
      "continue process inbound customer email",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      screen.getByText("continue process inbound customer email"),
    ).toBeInTheDocument();
    expect(screen.getByText("AI worker working")).toBeInTheDocument();
    expect(
      screen.getByText("Worker is running the next step..."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Message Sales AI Worker")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    const state = productRuntimeMock.__getState();
    const activeRun = state.runs.find(
      (run: any) => run.workerId === "sales" && run.status === "running",
    );
    await act(async () => {
      resolveCommand({
        state,
        run: activeRun,
        event: null,
        commandRecord: null,
      });
      await commandPromise;
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });
  });

  it("locks Start worker while Hermes startup is pending", async () => {
    const user = userEvent.setup();
    let resolveStart!: (value: ProductState) => void;
    const startPromise = new Promise<ProductState>((resolve) => {
      resolveStart = resolve;
    });
    productRuntimeMock.startProductWorker.mockImplementationOnce(
      () => startPromise,
    );

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Start worker" }),
    );

    const pendingButton = await screen.findByRole("button", {
      name: "Initializing...",
    });
    expect(pendingButton).toBeDisabled();
    expect(pendingButton).toHaveAttribute("aria-busy", "true");

    await user.click(pendingButton);

    expect(productRuntimeMock.startProductWorker).toHaveBeenCalledTimes(1);
    expect(productRuntimeMock.stopProductWorker).not.toHaveBeenCalled();

    const activeRun = run({
      id: "run-starting-sales",
      workflowId: "installed-outlook-product-inquiry-sales",
      title: "Qualify Outlook inbound inquiry and draft follow-up",
      status: "running",
      endedAt: null,
    });
    const nextState = buildProductState({
      runs: [activeRun, ...buildRuns()],
      runEvents: [
        {
          id: "event-starting-sales",
          runId: activeRun.id,
          workerId: "sales",
          source: "hermes",
          status: "AI worker started",
          body: "AI worker loaded the installed workflow and is ready for the next screen action.",
          createdAt: "2026-06-24T18:01:03.000Z",
        },
      ],
    });

    await act(async () => {
      resolveStart(nextState);
      await startPromise;
    });

    expect(
      await screen.findByRole("button", { name: "Stop worker" }),
    ).toBeInTheDocument();
  });

  it("keeps Agent commands disabled until Hermes readiness returns a session", async () => {
    const user = userEvent.setup();
    const startingRun: ProductRun = {
      ...run({
        id: "run-starting-without-session",
        workflowId: "installed-outlook-product-inquiry-sales",
        title: "Qualify Outlook inbound inquiry and draft follow-up",
        status: "running",
        endedAt: null,
      }),
      hermesSessionId: null,
    };
    const startingState = buildProductState({
      runs: [startingRun, ...buildRuns()],
      runEvents: [
        {
          id: "event-starting-initialized",
          runId: startingRun.id,
          workerId: "sales",
          source: "system",
          status: "Initialized",
          body: "Sales AI Worker connected to hermes-profile:ow-sales-sales-ai-worker.",
          createdAt: "2026-06-24T18:01:00.000Z",
        },
      ],
    });
    productRuntimeMock.startProductWorker.mockImplementationOnce(async () => {
      productRuntimeMock.__setState(startingState);
      return startingState;
    });

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Start worker" }),
    );

    const composer = await screen.findByLabelText("Message Sales AI Worker");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute(
      "placeholder",
      "Waiting for AI worker to finish initializing...",
    );
    expect(screen.getByText("AI worker initializing")).toBeInTheDocument();

    const readyState = {
      ...startingState,
      runs: startingState.runs.map((item) =>
        item.id === startingRun.id
          ? { ...item, hermesSessionId: "hermes-session-ready" }
          : item,
      ),
      runEvents: [
        {
          id: "event-starting-ready",
          runId: startingRun.id,
          workerId: "sales",
          source: "hermes",
          status: "AI worker started",
          body: "AI worker loaded the installed workflow and is ready for the next screen action.",
          createdAt: "2026-06-24T18:01:03.000Z",
        },
        ...startingState.runEvents,
      ],
    };
    productRuntimeMock.__setState(readyState);

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 3200));
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });
    expect(
      screen.getByText(
        "AI worker loaded the installed workflow and is ready for the next screen action.",
      ),
    ).toBeInTheDocument();
  }, 10_000);

  it("shows working after executor activity before the session becomes command-ready", async () => {
    const activeRun: ProductRun = {
      ...run({
        id: "run-working-without-session",
        workflowId: "installed-outlook-product-inquiry-sales",
        title: "Qualify Outlook inbound inquiry and draft follow-up",
        status: "running",
        endedAt: null,
      }),
      hermesSessionId: null,
    };
    const workers = buildWorkers().map((worker) =>
      worker.id === "sales"
        ? {
            ...worker,
            status: "Working" as const,
            tone: "working" as const,
            heartbeat: "AI worker working",
          }
        : worker,
    );
    productRuntimeMock.__setState(
      buildProductState({
        workers,
        runs: [activeRun, ...buildRuns()],
        runEvents: [
          {
            id: "event-executor-working",
            runId: activeRun.id,
            workerId: "sales",
            source: "executor",
            status: "AI worker working",
            body: "AI worker started executing Qualify Outlook inbound inquiry and draft follow-up.",
            createdAt: "2026-06-24T18:01:02.000Z",
          },
          {
            id: "event-working-initialized",
            runId: activeRun.id,
            workerId: "sales",
            source: "system",
            status: "Initialized",
            body: "Sales AI Worker initialized for Qualify Outlook inbound inquiry and draft follow-up.",
            createdAt: "2026-06-24T18:01:00.000Z",
          },
        ],
      }),
    );

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "Agent" }));

    const composer = await screen.findByLabelText("Message Sales AI Worker");
    expect(composer).toBeDisabled();
    expect(composer).toHaveAttribute(
      "placeholder",
      "AI worker is working on the workflow...",
    );
    expect(screen.getByText("AI worker working")).toBeInTheDocument();
    expect(
      screen.queryByText("AI worker initializing"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Sales AI Worker agent")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("deduplicates the pending command when polling already returned the user event", async () => {
    const user = userEvent.setup();
    let resolveCommand!: (value: any) => void;
    const commandPromise = new Promise<any>((resolve) => {
      resolveCommand = resolve;
    });
    const command = "continue process inbound customer email";

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Start worker" }),
    );
    await waitFor(() => {
      expect(
        screen.getByLabelText("Message Sales AI Worker"),
      ).not.toBeDisabled();
    });

    productRuntimeMock.sendProductWorkerCommand.mockImplementationOnce(
      () => commandPromise,
    );

    await user.type(screen.getByLabelText("Message Sales AI Worker"), command);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(screen.getByText(command)).toBeInTheDocument();

    const stateWithPending = productRuntimeMock.__getState();
    const activeRun = stateWithPending.runs.find(
      (run: any) => run.workerId === "sales" && run.status === "running",
    );
    productRuntimeMock.__setState({
      ...stateWithPending,
      runs: stateWithPending.runs.map((run: any) =>
        run.id === activeRun.id ? { ...run, command } : run,
      ),
      runEvents: [
        {
          id: "event-polled-command",
          runId: activeRun.id,
          workerId: "sales",
          source: "user",
          status: "Command",
          body: command,
          createdAt: "2026-06-24T18:02:01.000Z",
        },
        ...stateWithPending.runEvents,
      ],
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 3200));
    });

    await waitFor(() => {
      expect(screen.getAllByText(command)).toHaveLength(1);
    });
    expect(screen.getByText("AI worker working")).toBeInTheDocument();

    const refreshedState = productRuntimeMock.__getState();
    const refreshedRun = refreshedState.runs.find(
      (run: any) => run.id === activeRun.id,
    );
    await act(async () => {
      resolveCommand({
        state: refreshedState,
        run: refreshedRun,
        event: null,
        commandRecord: null,
      });
      await commandPromise;
    });
  }, 10_000);

  it("does not force the Agent thread to latest when polling refreshes while the user is reading history", async () => {
    const user = userEvent.setup();
    const activeRun = run({
      id: "run-active-sales-history",
      workflowId: "installed-outlook-product-inquiry-sales",
      title: "Qualify Outlook inbound inquiry and draft follow-up",
      status: "running",
      endedAt: null,
    });
    const runEvents: ProductRunEvent[] = Array.from(
      { length: 8 },
      (_, index) => ({
        id: `event-history-${index + 1}`,
        runId: activeRun.id,
        workerId: "sales",
        source: index % 2 === 0 ? "hermes" : "executor",
        status: index % 2 === 0 ? "AI worker response" : "Workflow selected",
        body: `History message ${index + 1}`,
        createdAt: `2026-06-24T18:0${index}:00.000Z`,
      }),
    );
    productRuntimeMock.__setState(
      buildProductState({
        runs: [activeRun, ...buildRuns()],
        runEvents,
      }),
    );
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Agent" }));
    const thread = document.querySelector(
      ".agent-thread",
    ) as HTMLElement | null;
    expect(thread).not.toBeNull();
    const scrollTo = vi.fn();
    Object.defineProperty(thread!, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    Object.defineProperties(thread!, {
      clientHeight: {
        configurable: true,
        value: 300,
      },
      scrollHeight: {
        configurable: true,
        value: 1200,
      },
    });
    thread!.scrollTop = 160;
    fireEvent.scroll(thread!);
    scrollTo.mockClear();
    const fetchCallsBefore =
      productRuntimeMock.fetchProductState.mock.calls.length;

    productRuntimeMock.__setState(
      buildProductState({
        runs: [activeRun, ...buildRuns()],
        runEvents: [...runEvents],
      }),
    );
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 3200));
    });

    expect(
      productRuntimeMock.fetchProductState.mock.calls.length,
    ).toBeGreaterThan(fetchCallsBefore);
    expect(scrollTo).not.toHaveBeenCalled();
  }, 10_000);

  it("keeps runtime recovery diagnostics out of Agent chat while preserving Activity history", async () => {
    const user = userEvent.setup();
    const recoveryBody =
      "OysterWorkflow restarted before this run finished, so the run was marked failed and the worker was returned to idle.";
    const activeRun = run({
      id: "run-active-sales",
      workflowId: "installed-outlook-product-inquiry-sales",
      title: "Qualify Outlook inbound inquiry and draft follow-up",
      status: "running",
      endedAt: null,
    });
    const recoveryRun: ProductRun = {
      ...run({
        id: "run-runtime-recovery",
        workflowId: "installed-outlook-product-inquiry-sales",
        title: "Qualify Outlook inbound inquiry and draft follow-up",
        status: "failed",
        endedAt: "2026-06-24T17:57:00.000Z",
      }),
      errorMessage: recoveryBody,
    };
    const runEvents: ProductRunEvent[] = [
      {
        id: "event-runtime-recovery",
        runId: recoveryRun.id,
        workerId: "sales",
        source: "system",
        status: "Runtime recovered",
        body: recoveryBody,
        createdAt: "2026-06-24T17:58:00.000Z",
      },
      {
        id: "event-hermes-live",
        runId: activeRun.id,
        workerId: "sales",
        source: "hermes",
        status: "AI worker response",
        body: "Progress: workflow skill reloaded; continuing inbound customer email processing.",
        createdAt: "2026-06-24T17:59:00.000Z",
      },
    ];

    productRuntimeMock.__setState(
      buildProductState({
        runs: [activeRun, recoveryRun, ...buildRuns()],
        runEvents,
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    expect(
      await screen.findByText(
        "Progress: workflow skill reloaded; continuing inbound customer email processing.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Runtime recovered")).not.toBeInTheDocument();
    expect(screen.queryByText(recoveryBody)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByText("Runtime recovered")).toBeInTheDocument();
    expect(screen.getAllByText(recoveryBody).length).toBeGreaterThan(0);
  });

  it("keeps Hermes stdout and tool diagnostics out of Agent chat", async () => {
    const user = userEvent.setup();
    const finalBody =
      "Final assistant export should be the only worker message shown.";
    const runEvents: ProductRunEvent[] = [
      {
        id: "event-stdout-debug",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "AI worker output",
        body: "┊ review diff\n--- /tmp/outlook_message.applescript",
        createdAt: "2026-06-24T17:41:00.000Z",
      },
      {
        id: "event-tool-debug",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "Tool action completed",
        body: "Used terminal (0.20s, 29093 chars).",
        createdAt: "2026-06-24T17:42:00.000Z",
      },
      {
        id: "event-mislabeled-cli-banner",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "AI worker started",
        body: "✨ cua-driver-rs: update available\nRelease notes: https://github.com/trycua/cua",
        createdAt: "2026-06-24T17:42:15.000Z",
      },
      {
        id: "event-final-message",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "AI worker response",
        body: finalBody,
        createdAt: "2026-06-24T17:43:00.000Z",
      },
      {
        id: "event-duplicate-started",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "AI worker started",
        body: finalBody,
        createdAt: "2026-06-24T17:42:30.000Z",
      },
    ];
    productRuntimeMock.__setState(
      buildProductState({
        runEvents,
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    expect(await screen.findByText(finalBody)).toBeInTheDocument();
    expect(screen.getAllByText(finalBody)).toHaveLength(1);
    expect(screen.queryByText(/review diff/u)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/outlook_message\.applescript/u),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Tool action completed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Used terminal/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/cua-driver/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Release notes:/u)).not.toBeInTheDocument();
  });

  it("uses product language for legacy runtime and browser-provider messages", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        runEvents: [
          {
            id: "event-legacy-provider-message",
            runId: "run-installed-action-items",
            workerId: "sales",
            source: "hermes",
            status: "AI worker response",
            body: "BrowserAct/managed browser was unavailable, so Hermes stopped with signal SIGKILL.",
            createdAt: "2026-06-24T17:43:00.000Z",
          },
        ],
      }),
    );

    render(<App />);
    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    expect(
      await screen.findByText(
        "browser connection was unavailable, so AI worker stopped unexpectedly.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Hermes/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/BrowserAct/u)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Activity" }));
    expect(
      await screen.findByText(
        "browser connection was unavailable, so AI worker stopped unexpectedly.",
      ),
    ).toBeInTheDocument();
  });

  it("shows Product-owned Agent events as OysterWorkflow system messages", async () => {
    const user = userEvent.setup();
    const initializedBody =
      "Sales AI Worker initialized for Handle inbound opportunity.";
    const workflowBody =
      "Using Handle inbound opportunity. Sending the command to the AI worker with allow_all policy.";
    const runEvents: ProductRunEvent[] = [
      {
        id: "event-initialized-system",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "system",
        status: "Initialized",
        body: initializedBody,
        createdAt: "2026-06-24T17:41:00.000Z",
      },
      {
        id: "event-workflow-selected",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "executor",
        status: "Workflow selected",
        body: workflowBody,
        createdAt: "2026-06-24T17:42:00.000Z",
      },
    ];
    productRuntimeMock.__setState(
      buildProductState({
        runEvents,
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    const initializedMessage = (
      await screen.findByText(initializedBody)
    ).closest(".agent-message");
    const workflowMessage = screen
      .getByText(workflowBody)
      .closest(".agent-message");

    expect(initializedMessage).toHaveClass("is-system");
    expect(workflowMessage).toHaveClass("is-system");
    expect(
      within(initializedMessage as HTMLElement).getByText("OysterWorkflow"),
    ).toBeInTheDocument();
    expect(
      within(workflowMessage as HTMLElement).getByText("OysterWorkflow"),
    ).toBeInTheDocument();
  });

  it("restores completed run messages in the idle Agent thread", async () => {
    const user = userEvent.setup();
    const historicalBody =
      "Historical AI worker response from a completed run should reopen in Agent history.";
    const runEvents: ProductRunEvent[] = [
      {
        id: "event-completed-hermes",
        runId: "run-installed-action-items",
        workerId: "sales",
        source: "hermes",
        status: "AI worker response",
        body: historicalBody,
        createdAt: "2026-06-24T17:43:00.000Z",
      },
    ];
    productRuntimeMock.__setState(
      buildProductState({
        runEvents,
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    expect(screen.queryByText("Workflow deployed")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Use Run from installed workflows/u),
    ).not.toBeInTheDocument();
    expect(await screen.findByText(historicalBody)).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Start worker to prepare an AI worker session before sending live commands.",
      ),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Activity" }));

    expect(await screen.findByText(historicalBody)).toBeInTheDocument();
  });

  it("limits restored Agent history to the selected worker's latest 100 messages", async () => {
    const user = userEvent.setup();
    const runEvents: ProductRunEvent[] = [
      ...Array.from({ length: 105 }, (_, index) => {
        const messageNumber = index + 1;
        return {
          id: `event-sales-history-${messageNumber}`,
          runId: "run-installed-action-items",
          workerId: "sales",
          source: "hermes" as const,
          status: "AI worker response",
          body: `Sales history message ${messageNumber}`,
          createdAt: new Date(
            Date.UTC(2026, 5, 24, 18, messageNumber),
          ).toISOString(),
        };
      }),
      {
        id: "event-marketing-history",
        runId: "run-marketing-history",
        workerId: "marketing",
        source: "hermes",
        status: "AI worker response",
        body: "Marketing worker history should not appear in Sales.",
        createdAt: "2026-06-24T22:00:00.000Z",
      },
    ];
    productRuntimeMock.__setState(
      buildProductState({
        runEvents,
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("tab", { name: "Agent" }));

    expect(
      await screen.findByText("Sales history message 105"),
    ).toBeInTheDocument();
    expect(screen.getByText("Sales history message 6")).toBeInTheDocument();
    expect(
      screen.queryByText("Sales history message 5"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "Marketing worker history should not appear in Sales.",
      ),
    ).not.toBeInTheDocument();
  });

  it("polls product state while a worker run is active", async () => {
    vi.useFakeTimers();
    productRuntimeMock.__setState({
      ...buildProductState(),
      runs: [
        {
          id: "run-polling-active",
          workerId: "sales",
          installedWorkflowId: "installed-action-items",
          workflowTitle: "Extract action items from customer meeting",
          status: "running",
          command: null,
          startedAt: "2026-06-24T18:05:00.000Z",
          endedAt: null,
          hermesSessionId: "hermes-session-polling",
          errorMessage: null,
        },
      ],
    });

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(productRuntimeMock.refreshProductHermes).not.toHaveBeenCalled();
    expect(productRuntimeMock.fetchProductState).toHaveBeenCalled();
    productRuntimeMock.fetchProductState.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(productRuntimeMock.fetchProductState).toHaveBeenCalled();
  });

  it("refreshes product state when the desktop window regains focus", async () => {
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };

    render(<App />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    productRuntimeMock.fetchProductState.mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(productRuntimeMock.fetchProductState).toHaveBeenCalled(),
    );
  });

  it("refreshes product state when Start worker hits a stale active-run conflict", async () => {
    const user = userEvent.setup();
    const refreshedState = buildProductState({
      runs: [
        {
          id: "run-stale-active",
          workerId: "sales",
          installedWorkflowId: "installed-action-items",
          workflowTitle: "Extract action items from customer meeting",
          status: "running",
          command: null,
          startedAt: "2026-06-24T18:06:00.000Z",
          endedAt: null,
          hermesSessionId: "hermes-session-stale",
          errorMessage: null,
        },
      ],
    });
    productRuntimeMock.startProductWorker.mockRejectedValueOnce(
      new Error("This worker is already running a workflow."),
    );

    render(<App />);

    const startButton = await screen.findByRole("button", {
      name: "Start worker",
    });
    productRuntimeMock.fetchProductState.mockResolvedValueOnce(refreshedState);
    await user.click(startButton);

    expect(
      await screen.findByText("This worker is already running a workflow."),
    ).toBeInTheDocument();
    expect(productRuntimeMock.fetchProductState).toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: "Stop worker" }),
    ).toBeInTheDocument();
  });

  it("manages installed workflows with consistent actions and pagination", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByText("Showing 1-6 of 33 matching workflows"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Trigger")).not.toBeInTheDocument();

    const searchInput = screen.getByRole("textbox", {
      name: "Search workflows",
    });
    await user.type(searchInput, "nda");
    expect(
      await screen.findByRole("heading", { name: "Prepare NDA handoff" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Extract action items from customer meeting",
      }),
    ).not.toBeInTheDocument();

    await user.clear(searchInput);
    await user.type(searchInput, "no workflow has this phrase");
    expect(
      await screen.findByText("No matching workflows"),
    ).toBeInTheDocument();

    await user.clear(searchInput);
    await user.selectOptions(
      screen.getByLabelText("Filter workflow status"),
      "Paused",
    );
    expect(
      await screen.findByRole("heading", { name: "Create onboarding handoff" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Prepare NDA handoff" }),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Filter workflow status"),
      "All",
    );
    expect(
      await screen.findByText("Showing 1-6 of 33 matching workflows"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByText("Showing 7-12 of 33 matching workflows"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Disable Extract action items from customer meeting",
      }),
    );
    expect(
      productRuntimeMock.updateProductInstalledWorkflowStatus,
    ).toHaveBeenCalledWith({
      installedWorkflowId: "installed-action-items",
      status: "Paused",
    });
    expect(
      await screen.findByRole("button", {
        name: "Enable Extract action items from customer meeting",
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "Remove Track unanswered customer questions",
      }),
    );
    expect(
      productRuntimeMock.deleteProductInstalledWorkflow,
    ).toHaveBeenCalledWith("installed-unanswered-questions");
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", {
          name: "Track unanswered customer questions",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("does not expose workflow update until the update contract exists", async () => {
    productRuntimeMock.__setState(
      buildProductState({
        installedWorkflows: [
          {
            ...installedWorkflow({
              id: "installed-update-pending",
              workflowId: "update-pending",
              title: "Track unanswered customer questions",
              description:
                "Find open customer questions across email and chat, then prepare owner follow-up",
              apps: [
                "Microsoft Outlook",
                "Slack",
                "Google Sheets",
                "Salesforce",
              ],
              runs: 27,
              successes: 24,
              lastRun: "43 min ago",
            }),
            updateAvailable: true,
          },
        ],
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "Track unanswered customer questions",
        }),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", {
        name: "Update Track unanswered customer questions",
      }),
    ).not.toBeInTheDocument();
  });

  it("does not show a review panel for installed workflows", async () => {
    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Needs review" }),
    ).not.toBeInTheDocument();
  });

  it("filters detected workflows by search text and status", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        workflows: [
          ...buildWorkflows(),
          workflow({
            id: "tracker-review",
            title: "Prepare follow-up tracker",
            description: "Create a tracker and review unanswered questions.",
            status: "Needs review",
            confidence: 82,
            apps: ["Salesforce", "Gmail"],
            uiEvents: 86,
            duration: "18:09",
            decisions: 5,
          }),
        ],
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    const workflowList = await screen.findByRole("list", {
      name: "Detected workflow list",
    });
    expect(
      within(workflowList).getByText("Handle inbound opportunity"),
    ).toBeInTheDocument();

    await user.type(
      screen.getByLabelText("Search detected workflows"),
      "linkedin",
    );
    expect(
      await within(workflowList).findByText(
        "Qualify Outlook product inquiry and draft sales reply",
      ),
    ).toBeInTheDocument();
    expect(
      within(workflowList).queryByText("Handle inbound opportunity"),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        name: /Qualify Outlook product inquiry and draft sales reply/,
      }),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Search detected workflows"));
    await user.selectOptions(
      screen.getByLabelText("Filter detected workflow status"),
      "Review needed",
    );
    expect(
      await within(workflowList).findByText("Prepare follow-up tracker"),
    ).toBeInTheDocument();
    expect(
      within(workflowList).queryByText("Handle inbound opportunity"),
    ).not.toBeInTheDocument();

    await user.selectOptions(
      screen.getByLabelText("Filter detected workflow status"),
      "All",
    );
    await user.type(
      screen.getByLabelText("Search detected workflows"),
      "no detected workflow has this phrase",
    );
    expect(
      await within(workflowList).findByText("No matching workflows"),
    ).toBeInTheDocument();
  });

  it("shows recent runtime workflows before seeded demo workflows", async () => {
    const user = userEvent.setup();
    const runtimeSession = buildRuntimeWorkflowSession();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "http://localhost");

        if (url.pathname === "/api/sessions") {
          return jsonResponse({ sessions: [runtimeSession] });
        }
        if (url.pathname === "/api/recorder/state") {
          return jsonResponse({ activeSession: null });
        }

        return jsonResponse(
          { error: { message: `Unhandled GET ${url.pathname}` } },
          500,
        );
      }),
    );

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    const workflowList = await screen.findByRole("list", {
      name: "Detected workflow list",
    });

    await waitFor(() => {
      const workflowRows = within(workflowList).getAllByRole("listitem");
      expect(
        within(workflowRows[0]).getByText("Captured training session"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByRole("heading", { name: /Captured training session/ }),
    ).toBeInTheDocument();
  });

  it("does not expose manual workflow creation or import entry points", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    const pageHeader = screen.getByRole("heading", { name: "Workflows" })
      .parentElement?.parentElement;

    expect(pageHeader).not.toBeNull();
    expect(pageHeader?.querySelector(".header-actions")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "New workflow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import workflow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /workflow/iu }),
    ).not.toBeInTheDocument();
  });

  it("does not expose workflow creation or import entry points in Chinese", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("oysterworkflow.app-language", "zh");

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "工作流" }));
    expect(
      screen.queryByRole("button", { name: "新建工作流" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导入工作流" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("检查最近训练会话中学习到的工作流"),
    ).toBeInTheDocument();
  });

  it("creates an AI worker from the worker dialog", async () => {
    const user = userEvent.setup();

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "AI workers" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import worker" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New AI worker" }));
    const newDialog = await screen.findByRole("dialog", {
      name: "New AI worker",
    });
    expect(
      within(newDialog).queryByText("Message channel"),
    ).not.toBeInTheDocument();
    expect(within(newDialog).queryByRole("radio")).not.toBeInTheDocument();
    const workerSetupForm =
      within(newDialog).getByLabelText("Worker setup form");
    const scrollTo = vi.fn();
    Object.defineProperties(workerSetupForm, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 900 },
      scrollTop: { configurable: true, value: 0, writable: true },
      scrollTo: { configurable: true, value: scrollTo },
    });
    fireEvent.keyDown(workerSetupForm, { key: "PageDown" });
    expect(scrollTo).toHaveBeenCalledWith({ top: 320, behavior: "smooth" });
    await user.clear(within(newDialog).getByLabelText("Worker name"));
    await user.type(
      within(newDialog).getByLabelText("Worker name"),
      "Customer Success Worker",
    );
    await user.clear(within(newDialog).getByLabelText("Identity and scope"));
    await user.type(
      within(newDialog).getByLabelText("Identity and scope"),
      "General purpose desktop worker for customer follow-up and onboarding handoff",
    );
    await user.click(
      within(newDialog).getByRole("button", { name: "Create worker" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Customer Success Worker" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Needs device").length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Runs will appear after this worker has an installed workflow and its Run button is pressed.",
      ),
    ).toBeInTheDocument();
    expect(productRuntimeMock.createProductWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "new",
        channel: {
          platform: "none",
          accessMode: "disabled",
          homeChannel: null,
          allowedUsers: [],
          credentials: {},
          testAfterCreate: false,
        },
      }),
    );
  });

  it("deletes an AI worker from Config after explicit confirmation", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /Marketing Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await user.click(screen.getByRole("button", { name: "Delete AI worker" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Marketing Worker",
    });
    expect(
      within(dialog).getByText(/Run history is kept for audit\./u),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Delete worker" }),
    );

    expect(productRuntimeMock.deleteProductWorker).toHaveBeenCalledWith(
      "marketing",
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: /Marketing Worker/u }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Marketing Worker deleted.")).toBeInTheDocument();
  });

  it("blocks AI worker deletion while the worker has an active session", async () => {
    const user = userEvent.setup();
    productRuntimeMock.__setState(
      buildProductState({
        runs: [
          {
            id: "run-marketing-active",
            workerId: "marketing",
            installedWorkflowId: "installed-marketing-active",
            workflowTitle: "Active marketing workflow",
            kind: "workflow",
            status: "running",
            command: null,
            startedAt: "2026-07-20T18:00:00.000Z",
            endedAt: null,
            hermesSessionId: "session-marketing-active",
            errorMessage: null,
          },
        ],
      }),
    );

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /Marketing Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await user.click(screen.getByRole("button", { name: "Delete AI worker" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Marketing Worker",
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Stop the active AI worker session before deleting it.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Delete worker" }),
    ).toBeDisabled();
    expect(productRuntimeMock.deleteProductWorker).not.toHaveBeenCalled();
  });

  it("keeps a fresh workspace free of phantom workflows after creating a worker", async () => {
    const user = userEvent.setup();
    (window as any).oysterworkflow = {
      runtime: {
        apiBaseUrl: "",
        mode: "desktop",
        platform: "darwin",
      },
    };
    productRuntimeMock.__setState(
      buildProductState({
        devices: [],
        workers: [],
        workflows: [],
        installedWorkflows: [],
        runs: [],
        runEvents: [],
        approvalPolicies: [],
      }),
    );

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "No AI workers yet" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Marketing Worker")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import worker" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New worker" }));
    const dialog = await screen.findByRole("dialog", {
      name: "New AI worker",
    });
    await user.clear(within(dialog).getByLabelText("Worker name"));
    await user.type(
      within(dialog).getByLabelText("Worker name"),
      "Test Worker",
    );
    await user.clear(within(dialog).getByLabelText("Identity and scope"));
    await user.type(
      within(dialog).getByLabelText("Identity and scope"),
      "Test fresh-workspace deployment routing",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Create worker" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Test Worker" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start worker" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Workflows" }));
    expect(
      await screen.findByRole("heading", { name: "No workflows yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Record your first workflow from a training session."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New workflow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import workflow" }),
    ).not.toBeInTheDocument();
    const emptyPageHeader = screen.getByRole("heading", {
      name: "Workflows",
    }).parentElement?.parentElement;
    expect(emptyPageHeader?.querySelector(".header-actions")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Deploy to AI worker" }),
    ).not.toBeInTheDocument();
    expect(productRuntimeMock.installProductWorkflow).not.toHaveBeenCalled();
  });

  it("opens message channel setup from the worker side panel", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /Marketing Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Config" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Configure Marketing Worker message channel",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Connect a message channel",
    });
    expect(dialog).toHaveTextContent("Message channels / Marketing Worker");
    await user.click(within(dialog).getByRole("radio", { name: /Slack/u }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(
      within(dialog).getByRole("button", { name: "Open Slack app creator" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Copy app manifest" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Bot token/u)).toHaveAttribute(
      "placeholder",
      "xoxb-...",
    );
    productRuntimeMock.configureProductWorkerChannel.mockClear();
    await user.type(within(dialog).getByLabelText(/^Bot token/u), "A012APPID");
    await user.type(
      within(dialog).getByLabelText(/^App token/u),
      "verification-token",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Connect and verify" }),
    );
    expect(
      await within(dialog).findByText(/must start with xoxb-/u),
    ).toBeInTheDocument();
    expect(
      productRuntimeMock.configureProductWorkerChannel,
    ).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(/^Bot token/u));
    await user.clear(within(dialog).getByLabelText(/^App token/u));
    await user.type(within(dialog).getByLabelText(/^Bot token/u), "xoxb-test");
    await user.type(within(dialog).getByLabelText(/^App token/u), "xapp-test");
    await user.click(
      within(dialog).getByRole("button", { name: "Connect and verify" }),
    );

    expect(
      productRuntimeMock.configureProductWorkerChannel,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workerId: "marketing",
        channel: expect.objectContaining({
          platform: "slack",
        }),
      }),
    );
    expect(productRuntimeMock.testProductWorkerChannel).toHaveBeenCalledWith(
      "marketing",
    );
    expect(
      await within(dialog).findByRole("heading", {
        name: "Send one message to Slack",
      }),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Pairing code"), "ab23cdef");
    await user.click(
      within(dialog).getByRole("button", { name: "Approve code" }),
    );
    expect(
      productRuntimeMock.approveProductWorkerChannelPairing,
    ).toHaveBeenCalledWith({
      workerId: "marketing",
      pairing: {
        connectionId: "channel-marketing-slack",
        code: "AB23CDEF",
      },
    });
    expect(
      await within(dialog).findByText(
        "Access approved for alex. Send one new message, then refresh.",
      ),
    ).toBeInTheDocument();
  });

  it("opens an existing bound channel in connected state", async () => {
    const user = userEvent.setup();
    const connectedAt = "2026-06-24T18:00:00.000Z";
    const connectedState = buildProductState();
    const salesWorker = connectedState.workers.find(
      (worker) => worker.id === "sales",
    )!;
    connectedState.workers = connectedState.workers.map((worker) =>
      worker.id === "sales"
        ? {
            ...worker,
            config: {
              ...worker.config,
              channel: {
                ...defaultTestChannelConfig("slack"),
                configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
                status: "connected",
              },
            },
          }
        : worker,
    );
    connectedState.channelConnections = [
      {
        id: "channel-sales-slack",
        workerId: "sales",
        platform: "slack",
        label: "Slack",
        setupMethod: "app_tokens",
        status: "connected",
        accountLabel: null,
        hermesProfile: salesWorker.config.hermesAgentReference,
        configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
        missingFields: [],
        lastCheckedAt: connectedAt,
        lastConnectedAt: connectedAt,
        lastError: null,
        createdAt: connectedAt,
        updatedAt: connectedAt,
      },
    ];
    connectedState.channelBindings = [
      {
        id: "binding-sales-slack-dm",
        connectionId: "channel-sales-slack",
        workerId: "sales",
        platform: "slack",
        conversationId: "D123",
        threadId: null,
        conversationLabel: "alex",
        hermesProfile: salesWorker.config.hermesAgentReference,
        hermesSessionId: "session-sales-bound",
        status: "bound",
        lastError: null,
        createdAt: connectedAt,
        updatedAt: connectedAt,
      },
    ];
    productRuntimeMock.__setState(connectedState);

    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: /Sales AI Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Configure Sales AI Worker message channel",
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: "Manage Slack" });
    expect(dialog).toHaveTextContent(
      "This account is connected and bound to Sales AI Worker.",
    );
    expect(dialog).toHaveTextContent("Messages are ready");
    expect(dialog).toHaveTextContent(
      "New messages in the bound conversation resume AI worker session session-sales-bound.",
    );
    expect(
      within(dialog).queryByRole("heading", {
        name: "Send one message to Slack",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByLabelText("Pairing code"),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Switch app" }),
    );
    expect(
      await within(dialog).findByRole("heading", {
        name: "Switch away from Slack?",
      }),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Existing message routing will stop until another app is connected and bound.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await user.click(
      within(dialog).getByRole("button", { name: "Change conversation" }),
    );
    expect(
      await within(dialog).findByRole("heading", {
        name: "Send one message to Slack",
      }),
    ).toBeInTheDocument();
  });

  it("disconnects the existing app before returning to channel choice", async () => {
    const user = userEvent.setup();
    const connectedAt = "2026-06-24T18:00:00.000Z";
    const connectedState = buildProductState();
    const salesWorker = connectedState.workers.find(
      (worker) => worker.id === "sales",
    )!;
    connectedState.workers = connectedState.workers.map((worker) =>
      worker.id === "sales"
        ? {
            ...worker,
            config: {
              ...worker.config,
              channel: {
                ...defaultTestChannelConfig("slack"),
                configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
                status: "connected",
              },
            },
          }
        : worker,
    );
    connectedState.channelConnections = [
      {
        id: "channel-sales-slack",
        workerId: "sales",
        platform: "slack",
        label: "Slack",
        setupMethod: "app_tokens",
        status: "connected",
        accountLabel: null,
        hermesProfile: salesWorker.config.hermesAgentReference,
        configuredFields: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
        missingFields: [],
        lastCheckedAt: connectedAt,
        lastConnectedAt: connectedAt,
        lastError: null,
        createdAt: connectedAt,
        updatedAt: connectedAt,
      },
    ];
    connectedState.channelBindings = [
      {
        id: "binding-sales-slack-dm",
        connectionId: "channel-sales-slack",
        workerId: "sales",
        platform: "slack",
        conversationId: "D123",
        threadId: null,
        conversationLabel: "alex",
        hermesProfile: salesWorker.config.hermesAgentReference,
        hermesSessionId: "session-sales-bound",
        status: "bound",
        lastError: null,
        createdAt: connectedAt,
        updatedAt: connectedAt,
      },
    ];
    productRuntimeMock.__setState(connectedState);

    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /Sales AI Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Configure Sales AI Worker message channel",
      }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Manage Slack" });
    await user.click(
      within(dialog).getByRole("button", { name: "Switch app" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Disconnect Slack" }),
    );

    expect(
      productRuntimeMock.disconnectProductWorkerChannel,
    ).toHaveBeenCalledWith({
      workerId: "sales",
      connectionId: "channel-sales-slack",
    });
    expect(
      await within(dialog).findByRole("heading", {
        name: "Choose where messages arrive",
      }),
    ).toBeInTheDocument();
  });

  it("shows a retryable QR setup error instead of an endless placeholder", async () => {
    const user = userEvent.setup();
    const stateWithStaleSlackAllowlist = productRuntimeMock.__getState();
    stateWithStaleSlackAllowlist.workers =
      stateWithStaleSlackAllowlist.workers.map((worker: any) =>
        worker.id === "marketing"
          ? {
              ...worker,
              config: {
                ...worker.config,
                channel: {
                  ...worker.config.channel,
                  platform: "slack",
                  label: "Slack",
                  accessMode: "allowlist",
                  allowedUsers: ["U0BBU88PUH3"],
                },
              },
            }
          : worker,
      );
    productRuntimeMock.__setState(stateWithStaleSlackAllowlist);
    const failedSetup = {
      id: "channel-setup-marketing-weixin",
      connectionId: "channel-marketing-weixin",
      workerId: "marketing",
      platform: "weixin",
      status: "failed",
      qrPayload: null,
      qrExpiresAt: null,
      accountLabel: null,
      processId: null,
      lastError:
        "The QR setup process stopped before it produced a connection code. Try again.",
      createdAt: "2026-06-24T18:00:00.000Z",
      updatedAt: "2026-06-24T18:00:01.000Z",
    };
    const failedConnection = {
      id: "channel-marketing-weixin",
      workerId: "marketing",
      platform: "weixin",
      label: "WeChat",
      setupMethod: "qr_link",
      status: "failed",
      accountLabel: null,
      hermesProfile: "hermes-profile:ow-marketing",
      configuredFields: [],
      missingFields: ["QR_LINK"],
      lastCheckedAt: failedSetup.updatedAt,
      lastConnectedAt: null,
      lastError: failedSetup.lastError,
      createdAt: failedSetup.createdAt,
      updatedAt: failedSetup.updatedAt,
    };
    productRuntimeMock.readProductWorkerChannelSetup.mockResolvedValueOnce({
      state: productRuntimeMock.__getState(),
      setup: failedSetup,
      connection: failedConnection,
    });

    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /Marketing Worker/u }),
    );
    await user.click(screen.getByRole("tab", { name: "Config" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Configure Marketing Worker message channel",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Connect a message channel",
    });
    await user.click(within(dialog).getByRole("radio", { name: /WeChat/u }));
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(
      productRuntimeMock.beginProductWorkerChannelSetup,
    ).toHaveBeenCalledWith({
      workerId: "marketing",
      setup: {
        platform: "weixin",
        mode: undefined,
        allowedUsers: [],
      },
    });

    expect(
      await within(dialog).findByText("Could not create a connection code"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "The QR setup process stopped before it produced a connection code. Try again.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(
      productRuntimeMock.beginProductWorkerChannelSetup,
    ).toHaveBeenCalledTimes(2);
  });

  it("deletes a detected workflow through the confirmation dialog", async () => {
    const user = userEvent.setup();
    const installedInbound = installedWorkflow({
      id: "installed-inbound-sales",
      workflowId: "inbound",
      title: "Handle inbound opportunity",
      description:
        "Qualify customer emails, check feasibility, and prepare follow-up",
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
      runs: 1,
      successes: 1,
      lastRun: "Yesterday",
    });
    const retainedRun = run({
      id: "run-installed-inbound",
      workflowId: installedInbound.id,
      title: installedInbound.workflowTitle,
      status: "succeeded",
      endedAt: "2026-06-23T16:55:00.000Z",
    });
    const initialState = productRuntimeMock.__getState();
    productRuntimeMock.__setState({
      ...initialState,
      installedWorkflows: [
        installedInbound,
        ...initialState.installedWorkflows,
      ],
      runs: [retainedRun, ...initialState.runs],
    });

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Delete workflow Handle inbound opportunity",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Handle inbound opportunity",
    });
    expect(
      within(dialog).getByText(
        "This permanently removes the workflow from this workspace and removes its installation from 1 AI worker. Those workers will no longer be able to run it.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Raw captures and run history are kept for audit. This action cannot be undone in the app.",
      ),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Delete workflow" }),
    );

    expect(productRuntimeMock.deleteProductWorkflow).toHaveBeenCalledWith({
      workflowId: "inbound",
      workflowTitle: "Handle inbound opportunity",
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", {
        name: "Delete workflow Handle inbound opportunity",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Handle inbound opportunity deleted."),
    ).toBeInTheDocument();
    expect(
      productRuntimeMock
        .__getState()
        .installedWorkflows.some(
          (workflow: ProductInstalledWorkflow) =>
            workflow.workflowId === "inbound",
        ),
    ).toBe(false);
    expect(
      productRuntimeMock
        .__getState()
        .runs.some(
          (existingRun: ProductRun) => existingRun.id === retainedRun.id,
        ),
    ).toBe(true);
  });

  it("blocks workflow deletion while an installed copy has an active run", async () => {
    const user = userEvent.setup();
    const installedInbound = installedWorkflow({
      id: "installed-inbound-sales",
      workflowId: "inbound",
      title: "Handle inbound opportunity",
      description:
        "Qualify customer emails, check feasibility, and prepare follow-up",
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
      runs: 1,
      successes: 0,
      lastRun: "Running now",
    });
    const activeRun = run({
      id: "run-installed-inbound-active",
      workflowId: installedInbound.id,
      title: installedInbound.workflowTitle,
      status: "running",
      endedAt: null,
    });
    const initialState = productRuntimeMock.__getState();
    productRuntimeMock.__setState({
      ...initialState,
      installedWorkflows: [
        installedInbound,
        ...initialState.installedWorkflows,
      ],
      runs: [activeRun, ...initialState.runs],
    });

    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Workflows" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Delete workflow Handle inbound opportunity",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Handle inbound opportunity",
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Stop every active run for this workflow before deleting it.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Delete workflow" }),
    ).toBeDisabled();
    expect(productRuntimeMock.deleteProductWorkflow).not.toHaveBeenCalled();
  });
});

describe("UI localization utility", () => {
  it("localizes visible labels while preserving product names and paths", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <h1>OysterWorkflow</h1>
      <p>Next: Find workflows to pick the path worth turning into a skill.</p>
      <dl>
        <dt>runId</dt>
        <dd>20260426T021819Z-4fmexw</dd>
        <dt>recording duration</dt>
        <dd>12s</dd>
      </dl>
      <p>/Users/appleuser/Documents/New project/.runs/ui-recording-codex-20260426/summary.json</p>
      <p>No active workflow is running. Start worker or run an installed workflow to send live commands.</p>
      <p>Start the AI worker first, then run this workflow.</p>
      <textarea placeholder="Tell the AI what to include, avoid, rename, or generalize."></textarea>
      <button aria-label="Delete session">x</button>
      <button aria-label="Run Extract action items" title="Start AI worker before running Extract action items">play</button>
    `;
    document.body.appendChild(root);

    const cleanupLocalization = applyUiLocalization(root, "zh");

    expect(root).toHaveTextContent("OysterWorkflow");
    expect(root).toHaveTextContent(
      "下一步：查找工作流，选择值得转成技能的路径。",
    );
    expect(root).toHaveTextContent("运行 ID");
    expect(root).toHaveTextContent("录制时长");
    expect(root).toHaveTextContent("ui-recording-codex-20260426");
    expect(root).toHaveTextContent(
      "暂无运行中的工作流。开始工作或运行已安装工作流后，可发送实时指令。",
    );
    expect(root).toHaveTextContent("你应该先启动 AI worker，然后再去执行");
    expect(root.querySelector("textarea")).toHaveAttribute(
      "placeholder",
      "告诉 AI 哪些内容要包含、避免、改名或泛化。",
    );
    const buttons = root.querySelectorAll("button");
    expect(buttons[0]).toHaveAttribute("aria-label", "删除会话");
    expect(buttons[1]).toHaveAttribute(
      "aria-label",
      "执行 Extract action items",
    );
    expect(buttons[1]).toHaveAttribute(
      "title",
      "请先启动 AI Worker，再执行 Extract action items",
    );

    cleanupLocalization();
    root.remove();
  });

  it("restores localized text and attributes when switching back to English", async () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <p>Review Capture</p>
      <p>Check what this session captured.</p>
      <button aria-label="Delete session">x</button>
      <textarea placeholder="Tell the AI what to include, avoid, rename, or generalize."></textarea>
    `;
    document.body.appendChild(root);

    const cleanupZh = applyUiLocalization(root, "zh");

    expect(root).toHaveTextContent("检查采集");
    expect(root).toHaveTextContent("检查本次会话采集到了什么。");
    expect(root.querySelector("button")).toHaveAttribute(
      "aria-label",
      "删除会话",
    );

    cleanupZh();
    const cleanupEn = applyUiLocalization(root, "en");

    await waitFor(() => {
      expect(root).toHaveTextContent("Review Capture");
    });
    expect(root).toHaveTextContent("Check what this session captured.");
    expect(root.querySelector("button")).toHaveAttribute(
      "aria-label",
      "Delete session",
    );
    expect(root.querySelector("textarea")).toHaveAttribute(
      "placeholder",
      "Tell the AI what to include, avoid, rename, or generalize.",
    );

    cleanupEn();
    root.remove();
  });
});

function installedWorkflowRow(name: string): HTMLElement {
  const row =
    screen
      .getAllByRole("heading", { name })
      .map((heading) => heading.closest("article"))
      .find((element): element is HTMLElement => element !== null) ?? null;
  if (!row) {
    throw new Error(`Installed workflow row not found: ${name}`);
  }
  return row;
}

/**
 * EN: Builds product state that mirrors the productized demo data contract.
 * 中文: 构造符合产品化 demo 数据契约的状态。
 * @param overrides selected state fields to replace for a scenario.
 * @returns complete product state snapshot.
 */
function buildProductState(
  overrides: Partial<ProductState> = {},
): ProductState {
  const state: ProductState = {
    schemaVersion: 1,
    account: buildAccount(),
    workspace: {
      id: "workspace-demo",
      name: "OysterWorkflow",
      mode: "local",
    },
    permissionSnapshot: null,
    devices: buildDevices(),
    workers: buildWorkers(),
    workflows: buildWorkflows(),
    captureSessions: [],
    artifacts: [],
    installedWorkflows: buildInstalledWorkflows({
      includeFreshDeploy: true,
      total: 33,
    }),
    runs: buildRuns(),
    runEvents: [],
    commands: [],
    approvalPolicies: buildApprovalPolicies(),
    workflowTombstones: [],
    hermes: buildHermesStatus(),
    updatedAt: "2026-06-24T17:55:00.000Z",
  };
  return {
    ...state,
    ...overrides,
  };
}

function buildAccount(): ProductAccount {
  return {
    id: "account-alex",
    name: "Alex Yang",
    email: "alexyang@oysterworkflow.com",
    workspaceId: "workspace-demo",
    signedInLabel: "OysterWorkflow",
    cloudProvider: null,
    cloudUserId: null,
    setupCompleted: true,
    updatedAt: "2026-06-24T17:55:00.000Z",
  };
}

function buildDevices(): ProductDevice[] {
  return [
    {
      id: "alex-mbp",
      name: "Alex's MacBook Pro",
      status: "Available now",
      owner: "Alex Yang",
      assignedWorkerId: "sales",
      heartbeat: "Last check 9 sec ago",
      location: "Local desktop runtime",
      runtimeVersion: "0.1.0",
      queue: ["Inbound inquiry queue", "Draft logging review"],
    },
    {
      id: "studio-mini",
      name: "Studio Mac mini",
      status: "Idle today",
      owner: "Demo workspace",
      assignedWorkerId: "product",
      heartbeat: "Idle today",
      location: "Office lab",
      runtimeVersion: "0.1.0",
      queue: ["Observe product research workflow", "Wait for assigned work"],
    },
  ];
}

function buildWorkers(): ProductWorker[] {
  return [
    buildWorker({
      id: "marketing",
      name: "Marketing Worker",
      initials: "MK",
      status: "Needs device",
      tone: "warning",
      avatarKey: "marketing",
      deviceId: null,
      heartbeat: "No computer assigned",
    }),
    buildWorker({
      id: "product",
      name: "Product Worker",
      initials: "PD",
      status: "Available",
      tone: "ready",
      avatarKey: "product",
      deviceId: "studio-mini",
      heartbeat: "Recently active",
    }),
    buildWorker({
      id: "finance",
      name: "Finance Worker",
      initials: "FN",
      status: "Setup needed",
      tone: "warning",
      avatarKey: "finance",
      deviceId: null,
      heartbeat: "Permissions missing",
    }),
    buildWorker({
      id: "sales",
      name: "Sales AI Worker",
      initials: "SA",
      status: "Available",
      tone: "ready",
      avatarKey: "sales",
      deviceId: "alex-mbp",
      heartbeat: "Recently active",
    }),
  ];
}

function buildWorker(input: {
  id: ProductWorker["id"];
  name: ProductWorker["name"];
  initials: ProductWorker["initials"];
  status: ProductWorker["status"];
  tone: ProductWorker["tone"];
  avatarKey: ProductWorker["avatarKey"];
  deviceId: ProductWorker["deviceId"];
  heartbeat: ProductWorker["heartbeat"];
}): ProductWorker {
  return {
    ...input,
    description: "General purpose desktop worker",
    activities: ["No active workflow running", "AI worker runtime idle"],
    config: {
      identityScope: `${input.name} handles assigned desktop workflows.`,
      runtimeProfile: "AI worker local desktop agent",
      toolAccess: ["computer", "browser", "mail", "documents"],
      memoryContext:
        "Use installed workflow skills and current screen context.",
      approvalPolicy: "allow_all",
      heartbeatPolicy: "Think when idle",
      hermesAgentReference: defaultHermesProfileReference(input.id, input.name),
      channel:
        input.id === "sales"
          ? {
              ...defaultTestChannelConfig("weixin"),
              status: "configured",
            }
          : defaultTestChannelConfig("none"),
    },
  };
}

function defaultTestChannelConfig(
  platform: ProductWorker["config"]["channel"]["platform"],
): ProductWorker["config"]["channel"] {
  const label =
    platform === "slack"
      ? "Slack"
      : platform === "weixin"
        ? "WeChat"
        : platform === "wecom"
          ? "WeCom"
          : "No channel";
  return {
    platform,
    label,
    accessMode: platform === "none" ? "disabled" : "allowlist",
    homeChannel: null,
    allowedUsers: [],
    configuredFields: [],
    missingFields: [],
    status: platform === "none" ? "not_configured" : "configured",
    lastTestedAt: null,
    lastError: null,
  };
}

function defaultHermesProfileReference(workerId: string, workerName: string) {
  const seed = slugifyForHermesProfile(`${workerId}-${workerName}`) || "worker";
  return `hermes-profile:${`ow-${seed}`.slice(0, 63).replace(/-$/u, "")}`;
}

function slugifyForHermesProfile(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);
}

function buildRuntimeWorkflowSession(): LabSession {
  const startedAt = "2026-06-24T18:10:00.000Z";
  const stoppedAt = "2026-06-24T18:12:00.000Z";
  const sessionId = "session-real-latest";
  const sessionRoot = `/tmp/${sessionId}`;
  const durationMs = 120_000;
  const summary = {
    runId: "run-real-latest",
    startedAt: stoppedAt,
    completedAt: "2026-06-24T18:12:01.000Z",
    durationMs: 1000,
    timeWindow: {
      requested: {
        startTs: startedAt,
        endTs: stoppedAt,
        durationMs,
      },
      observed: {
        startTs: startedAt,
        endTs: stoppedAt,
        durationMs,
      },
    },
    fetch: {
      ocrPages: 1,
      audioPages: 1,
      uiPages: 1,
      rawOcrCount: 33,
      rawAudioCount: 1,
      rawUiEventsCount: 27,
    },
    transform: {
      normalizedCount: 27,
      dedupedCount: 25,
      droppedDuplicates: 2,
    },
    episodes: {
      count: 1,
      avgDurationMs: durationMs,
      medianDurationMs: durationMs,
    },
    warnings: [],
  };

  return {
    schemaVersion: "recording-session-v1",
    sessionId,
    sessionName: null,
    createdAt: startedAt,
    updatedAt: stoppedAt,
    status: "ready",
    paths: {
      sessionDir: sessionRoot,
      dataDir: `${sessionRoot}/data`,
      ingestOutDir: `${sessionRoot}/ingest`,
      workflowDir: `${sessionRoot}/workflow`,
      skillDir: `${sessionRoot}/skill`,
      generalizationDir: `${sessionRoot}/generalization`,
      plannerOptimizationDir: `${sessionRoot}/planner`,
      sessionPath: `${sessionRoot}/session.json`,
      recordingLogPath: `${sessionRoot}/recording.log`,
      queryLogPath: `${sessionRoot}/query.log`,
    },
    recordingConfig: {
      ocrLanguagePriority: ["chinese", "english"],
      enableAudio: false,
    },
    screenpipe: {
      recording: {
        state: "stopped",
        pid: null,
        port: 3030,
        workdir: "/tmp",
        command: [],
        logPath: null,
        startedAt,
        stoppedAt,
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
      startedAt,
      requestedStopAt: stoppedAt,
      scheduledStopAt: null,
      autoStopMinutes: null,
    },
    ingest: {
      latestRunId: summary.runId,
      latestRunDir: `${sessionRoot}/runs/${summary.runId}`,
      summaryPath: `${sessionRoot}/runs/${summary.runId}/summary.json`,
      summary,
    },
    selection: {
      workflowId: null,
      workflowPath: null,
    },
    workflowDiscovery: {
      latestPath: null,
      workflowCandidates: [],
    },
    skillExtraction: {
      latestOutDir: null,
      skillPath: null,
      summaryPath: null,
      skill: null,
      summary: null,
      artifacts: [],
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function buildWorkflows(): ProductWorkflow[] {
  return [
    workflow({
      id: "inbound",
      title: "Handle inbound opportunity",
      description:
        "Qualify customer emails, check feasibility, and prepare follow-up",
      status: "Installable",
      confidence: 94,
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
      uiEvents: 162,
      duration: "45:18",
      decisions: 12,
    }),
    workflow({
      id: "outlook-product-inquiry",
      title: "Qualify Outlook product inquiry and draft sales reply",
      description:
        "Verify company fit, ask the team, reference cases, and save an Outlook draft",
      status: "Generated",
      confidence: null,
      apps: [
        "Microsoft Outlook",
        "Chrome",
        "LinkedIn",
        "ChatGPT",
        "Slack",
        "Microsoft Word",
        "HubSpot",
      ],
      uiEvents: 1147,
      duration: "6:36",
      decisions: 5,
    }),
    ...Array.from({ length: 10 }, (_, index) =>
      workflow({
        id: `runtime-${index + 1}`,
        title: `Captured training session ${index + 1}`,
        description:
          "Capture is ready. Analyze it to build an editable workflow.",
        status: index % 3 === 0 ? "Captured" : "Installable",
        confidence: index % 3 === 0 ? null : 80 + index,
        apps: index % 2 === 0 ? ["Google Chrome"] : ["Gmail", "Google Docs"],
        uiEvents: 80 + index * 7,
        duration: `0${index + 1}:3${index % 10}`,
        decisions: index % 3 === 0 ? null : 2 + index,
      }),
    ),
  ];
}

function workflow(input: {
  id: string;
  title: string;
  description: string;
  status: ProductWorkflow["status"];
  confidence: number | null;
  apps: string[];
  uiEvents: number;
  duration: string;
  decisions: number | null;
}): ProductWorkflow {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    status: input.status,
    sourceType: input.id.startsWith("runtime-") ? "runtime" : "demo",
    confidence: input.confidence,
    apps: input.apps,
    stats: {
      uiEvents: input.uiEvents,
      ocrObservations: input.uiEvents > 200 ? 70 : 418,
      voiceNotes: input.uiEvents > 200 ? 12 : 5,
      duration: input.duration,
      decisionPoints: input.decisions,
    },
    detectedAt:
      input.status === "Generated"
        ? "Generated on Jun 18, 2026 at 9:21 PM"
        : "Detected on May 21, 2025 at 10:42 AM",
    artifactPath: null,
    createdAt: `2026-06-${String(10 + input.id.length).padStart(2, "0")}T10:42:00.000Z`,
    updatedAt: "2026-06-24T17:55:00.000Z",
  };
}

function buildInstalledWorkflows(input: {
  includeFreshDeploy: boolean;
  total: number;
}): ProductInstalledWorkflow[] {
  const base: ProductInstalledWorkflow[] = [
    input.includeFreshDeploy
      ? installedWorkflow({
          id: "installed-outlook-product-inquiry-sales",
          workflowId: "outlook-product-inquiry",
          title: "Qualify Outlook inbound inquiry and draft follow-up",
          description:
            "Screen an Outlook inquiry, verify the company, ask tech team, reference Clients, draft a reply, and log the company",
          apps: [
            "Microsoft Outlook",
            "Chrome",
            "LinkedIn",
            "ChatGPT",
            "Slack",
            "Microsoft Word",
            "HubSpot",
          ],
          runs: 0,
          successes: 0,
          lastRun: "Not run yet",
        })
      : null,
    installedWorkflow({
      id: "installed-action-items",
      workflowId: "action-items",
      title: "Extract action items from customer meeting",
      description:
        "Turn call notes into owners, deadlines, CRM tasks, and follow-up reminders",
      apps: ["Google Docs", "Slack", "Salesforce", "Microsoft Outlook"],
      runs: 34,
      successes: 33,
      lastRun: "18 min ago",
    }),
    installedWorkflow({
      id: "installed-unanswered-questions",
      workflowId: "unanswered-questions",
      title: "Track unanswered customer questions",
      description:
        "Find open customer questions across email and chat, then prepare owner follow-up",
      apps: ["Microsoft Outlook", "Slack", "Google Sheets", "Salesforce"],
      runs: 27,
      successes: 24,
      lastRun: "43 min ago",
    }),
    installedWorkflow({
      id: "installed-nda-handoff",
      workflowId: "nda-handoff",
      title: "Prepare NDA handoff",
      description:
        "Collect account context, contact details, scope, and legal notes before NDA routing",
      apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word", "Slack"],
      runs: 19,
      successes: 18,
      lastRun: "Yesterday",
    }),
    installedWorkflow({
      id: "installed-funding-news",
      workflowId: "funding-news",
      title: "Check funding and company news",
      description:
        "Research recent funding, hiring, product launches, and executive signals before outreach",
      apps: ["Chrome", "LinkedIn", "Google Docs"],
      runs: 22,
      successes: 20,
      lastRun: "Yesterday",
    }),
    installedWorkflow({
      id: "installed-deal-stage",
      workflowId: "deal-stage",
      title: "Update deal stage from email thread",
      description:
        "Read customer replies, infer stage changes, and update CRM next steps",
      apps: ["Microsoft Outlook", "Salesforce", "HubSpot"],
      runs: 31,
      successes: 29,
      lastRun: "Jun 20",
    }),
    installedWorkflow({
      id: "installed-onboarding",
      workflowId: "onboarding",
      title: "Create onboarding handoff",
      description:
        "Package closed-won context, implementation notes, risks, and success criteria for CS",
      apps: ["Salesforce", "Google Docs", "Slack", "Google Drive"],
      runs: 14,
      successes: 13,
      lastRun: "Jun 17",
      status: "Paused",
    }),
  ].filter((workflow): workflow is ProductInstalledWorkflow =>
    Boolean(workflow),
  );

  const fillerCount = Math.max(0, input.total - base.length);
  const fillers = Array.from({ length: fillerCount }, (_, index) =>
    installedWorkflow({
      id: `installed-demo-${index + 1}`,
      workflowId: `demo-${index + 1}`,
      title: `Sales workflow library item ${index + 1}`,
      description:
        "Reusable sales operations workflow kept in the worker library",
      apps:
        index % 2 === 0
          ? ["Microsoft Outlook", "Slack"]
          : ["Chrome", "LinkedIn"],
      runs: 0,
      successes: 0,
      lastRun: "Not run yet",
    }),
  );
  return [...base, ...fillers];
}

function installedWorkflow(input: {
  id: string;
  workflowId: string;
  title: string;
  description: string;
  apps: string[];
  runs: number;
  successes: number;
  lastRun: string;
  status?: ProductInstalledWorkflow["status"];
}): ProductInstalledWorkflow {
  return {
    id: input.id,
    workerId: "sales",
    workflowId: input.workflowId,
    workflowTitle: input.title,
    description: input.description,
    status: input.status ?? "Enabled",
    apps: input.apps,
    installedAt: "2026-06-24T17:50:00.000Z",
    deployTargetDeviceId: "alex-mbp",
    approvalPolicy: "allow_all",
    hermesSkillReference: `hermes-skill:${input.workflowId}`,
    hermesInstallReference: `hermes-install:${input.workflowId}`,
    hermesSkillName: input.title,
    hermesSkillPath: `/Users/appleuser/.hermes/skills/${input.workflowId}.json`,
    baselineRuns: input.runs,
    baselineSuccesses: input.successes,
    baselineLastRun: input.lastRun,
    updateAvailable: false,
  };
}

function buildRuns(): ProductRun[] {
  return [
    run({
      id: "run-installed-action-items",
      workflowId: "installed-action-items",
      title: "Extract action items from customer meeting",
      status: "succeeded",
      endedAt: "2026-06-24T17:42:00.000Z",
    }),
    run({
      id: "run-installed-unanswered",
      workflowId: "installed-unanswered-questions",
      title: "Track unanswered customer questions",
      status: "succeeded",
      endedAt: "2026-06-24T17:17:00.000Z",
    }),
    run({
      id: "run-installed-onboarding",
      workflowId: "installed-onboarding",
      title: "Create onboarding handoff",
      status: "paused",
      endedAt: "2026-06-24T16:55:00.000Z",
    }),
  ];
}

function run(input: {
  id: string;
  workflowId: string;
  title: string;
  status: ProductRun["status"];
  endedAt: string | null;
}): ProductRun {
  return {
    id: input.id,
    workerId: "sales",
    installedWorkflowId: input.workflowId,
    workflowTitle: input.title,
    status: input.status,
    command: null,
    startedAt: "2026-06-24T16:40:00.000Z",
    endedAt: input.endedAt,
    hermesSessionId: "hermes-session-history",
    errorMessage: null,
  };
}

function buildApprovalPolicies() {
  return [
    {
      id: "approval-worker-sales",
      scopeType: "worker",
      scopeId: "sales",
      mode: "allow_all",
      description:
        "AI worker can proceed under allow_all; progress appears in run events.",
      updatedAt: "2026-06-24T17:50:00.000Z",
    },
  ] as ProductState["approvalPolicies"];
}

function buildHermesStatus(): ProductHermesStatus {
  return {
    command: "hermes",
    available: true,
    model: "gpt-5.5",
    provider: "local",
    providerHealth: defaultHermesProviderHealth(),
    enabledToolsets: [
      "browser",
      "terminal",
      "file",
      "vision",
      "skills",
      "memory",
    ],
    missingComputerUseToolsets: [],
    computerUseReady: true,
    computerUseSummary: "Computer control is ready",
    configSource: "OysterWorkflow LLM config",
    configPath: "/tmp/llm.config.json",
    runtimeHome: "/tmp/hermes-runtime",
    lastCheckedAt: "2026-06-24T17:55:00.000Z",
    lastProbeSessionId: "probe-session-1",
    lastError: null,
  };
}

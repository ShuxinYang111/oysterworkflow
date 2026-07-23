import express from "express";
import { timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  LAB_SCREENPIPE_LANGUAGES,
  RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT,
} from "../lab-api/contracts.js";
import type {
  LabArtifactKind,
  LlmModelsResponse,
  LlmConfigResponse,
  OpenClawInstallResponse,
  OpenClawSkillsResponse,
  OpenClawUninstallResponse,
  SessionResponse,
  SkillManagerConfigResponse,
  SkillManagerExportResponse,
  SkillManagerPathCandidatesResponse,
  SkillManagerSkillsResponse,
  SkillManagerUninstallResponse,
} from "../lab-api/contracts.js";
import { loadCodexEnv } from "../lab-api/env.js";
import { createLabService, type LabService } from "../lab-api/service.js";
import type { WorkflowFamilyArtifactSource } from "../lab-api/workflow-family-catalog.js";
import type { RuntimeErrorContext } from "../observability/sentry-config.js";
import {
  CodexWorkflowServiceError,
  createCodexWorkflowService,
  type CodexWorkflowService,
} from "../codex-workflow/service.js";
import { handleOysterWorkflowMcpMessage } from "../codex-workflow/mcp.js";
import {
  createProductClawHubService,
  type ProductClawHubService,
} from "../product/clawhub.js";
import { createProductStore, type ProductStore } from "../product/store.js";
import { readProductWorkflowGraph } from "../product/workflow-graph-view.js";
import {
  isWorkflowGraphEditConflict,
  parseProductWorkflowGraphEditInput,
} from "../product/workflow-graph-edit.js";
import { syncProductControlPlane } from "../product/supabase-control-plane.js";
import type { CloudSyncResult } from "../cloud/contracts.js";
import {
  createRuntimeCloudSession,
  type RuntimeCloudSession,
} from "../cloud/runtime-session.js";
import { createHostedComposioProviderAdapter } from "../product/composio-hosted.js";
import type {
  ProductAccountSetupResponse,
  ProductApplyWorkflowMergeResponse,
  ProductApproveChannelPairingResponse,
  ProductAssignDeviceResponse,
  ProductCapabilityProviderCheckResponse,
  ProductChannelBindingResponse,
  ProductChannelPeersResponse,
  ProductChannelSetupResponse,
  ProductComposioAuthorizeResponse,
  ProductComposioConnectionResponse,
  ProductComposioDisconnectResponse,
  ProductComposioOverviewResponse,
  ProductCommandResponse,
  ProductCreateWorkflowResponse,
  ProductCreateWorkerResponse,
  ProductDeleteInstalledWorkflowResponse,
  ProductDeleteWorkerResponse,
  ProductDeleteWorkflowResponse,
  ProductDisconnectChannelResponse,
  ProductInstallWorkflowResponse,
  ProductPendingWorkflowMergesResponse,
  ProductCreateNewWorkflowDecisionResponse,
  ProductRestoreWorkflowVersionResponse,
  ProductRunWorkflowResponse,
  ProductStartWorkerResponse,
  ProductStateResponse,
  ProductWorkerChannelConfigureResponse,
  ProductWorkerChannelTestResponse,
  ProductWorkerConfigResponse,
  ProductWorkflowGraphResponse,
  ProductWorkflowGraphEditResponse,
  ProductWorkflowVersionsResponse,
  ProductCapabilityProviderId,
  ProductClawHubAuthState,
  ProductClawHubLoginStartResponse,
  ProductClawHubLoginStatusResponse,
  ProductClawHubPublishResponse,
} from "../product/contracts.js";
import {
  parseRuntimeCliArgs,
  RUNTIME_API_SECRET_HEADER,
  resolveRuntimeConfig,
  type ResolveRuntimeConfigInput,
  type RuntimeConfig,
} from "./config.js";

const ocrLanguagePrioritySchema = z
  .array(z.enum(LAB_SCREENPIPE_LANGUAGES))
  .min(1)
  .max(RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT)
  .refine(
    (value) => new Set(value).size === value.length,
    "ocrLanguagePriority must not contain duplicate languages.",
  );
const timedStopBodySchema = z.object({
  autoStopMinutes: z.coerce.number().positive(),
});
const productInstallWorkflowBodySchema = z.object({
  workerId: z.string().min(1),
  workflowId: z.string().min(1),
  workflowTitle: z.string().min(1),
  description: z.string(),
  apps: z.array(z.string()).default([]),
  deployTargetDeviceId: z.string().min(1).nullable().optional(),
  skillPath: z.string().min(1).nullable().optional(),
});
const productWorkflowGraphQuerySchema = z.object({
  graphPath: z.string().min(1).optional(),
  candidatePath: z.string().min(1).optional(),
  mergeProposalPath: z.string().min(1).optional(),
});
const productWorkflowMergeApplyBodySchema = z.object({
  targetWorkflowId: z.string().min(1).optional(),
});
const productWorkflowRestoreBodySchema = z.object({
  revisionId: z.string().min(1),
});
const codexWorkflowSearchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const prepareCodexWorkflowRunBodySchema = z.object({
  workflowId: z.string().min(1),
  expectedRevisionId: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
});
const codexWorkflowEvidenceSchema = z.object({
  kind: z.enum(["observation", "url", "artifact", "receipt"]),
  value: z.string().min(1),
  label: z.string().min(1).optional(),
});
const advanceCodexWorkflowRunBodySchema = z.object({
  currentNodeId: z.string().min(1),
  transitionId: z.string().min(1).optional(),
  summary: z.string().min(1),
  evidence: z.array(codexWorkflowEvidenceSchema).max(100).optional(),
});
const productAssignDeviceBodySchema = z.object({
  workerId: z.string().min(1),
  deviceId: z.string().min(1),
});
const productWorkerChannelPlatformSchema = z.enum([
  "none",
  "telegram",
  "slack",
  "weixin",
  "whatsapp",
  "wecom",
]);
const productWorkerChannelAccessModeSchema = z.enum([
  "disabled",
  "allow_all",
  "allowlist",
]);
const productWorkerChannelInputSchema = z.object({
  platform: productWorkerChannelPlatformSchema,
  accessMode: productWorkerChannelAccessModeSchema.optional(),
  homeChannel: z.string().nullable().optional(),
  allowedUsers: z.array(z.string()).optional(),
  credentials: z.record(z.string(), z.string()).optional(),
  mode: z.enum(["bot", "self-chat"]).optional(),
  testAfterCreate: z.boolean().optional(),
});
const productBeginChannelSetupBodySchema = z.object({
  platform: z.enum(["weixin", "whatsapp"]),
  mode: z.enum(["bot", "self-chat"]).optional(),
  allowedUsers: z.array(z.string()).optional(),
});
const productBindChannelBodySchema = z.object({
  connectionId: z.string().min(1),
  conversationId: z.string().min(1),
  threadId: z.string().nullable().optional(),
  conversationType: z.string().nullable().optional(),
  conversationLabel: z.string().nullable().optional(),
  hermesSessionId: z.string().nullable().optional(),
  deliveryConfirmed: z.literal(true),
});
const productApproveChannelPairingBodySchema = z.object({
  connectionId: z.string().min(1),
  code: z
    .string()
    .trim()
    .regex(/^[A-HJ-NP-Za-hj-np-z2-9]{8}$/u),
});
const productWorkerChannelConfigSchema = z.object({
  platform: productWorkerChannelPlatformSchema,
  label: z.string().min(1),
  accessMode: productWorkerChannelAccessModeSchema,
  homeChannel: z.string().nullable(),
  allowedUsers: z.array(z.string()),
  configuredFields: z.array(z.string()),
  missingFields: z.array(z.string()),
  status: z.enum([
    "not_configured",
    "configured",
    "testing",
    "connected",
    "failed",
  ]),
  lastTestedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
const productCreateWorkerBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  channel: productWorkerChannelInputSchema.optional(),
  commandChannel: z.string().min(1).optional(),
  sourceText: z.string().optional(),
  mode: z.literal("new"),
});
const productCreateWorkflowBodySchema = z.object({
  mode: z.enum(["new", "import"]),
  title: z.string().min(1),
  description: z.string().min(1),
  apps: z.array(z.string()).default([]),
  sourceText: z.string().optional(),
});
const productCommandBodySchema = z.object({
  command: z.string().min(1),
});
const productInstalledWorkflowStatusBodySchema = z.object({
  status: z.enum(["Enabled", "Paused"]),
});
const productDeleteWorkflowBodySchema = z.object({
  workflowTitle: z.string().min(1),
});
const productCloudSyncBodySchema = z.object({
  mode: z.enum(["pull", "push"]).default("pull"),
  authenticatedUser: z.object({
    id: z.string().min(1),
    email: z.string(),
    displayName: z.string().nullable(),
  }),
});
const productClawHubPublishBodySchema = z.object({
  acceptMit0: z.literal(true),
});
const productAccountSetupBodySchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  workspaceName: z.string().min(1),
});
const productWorkerConfigBodySchema = z.object({
  identityScope: z.string().min(1),
  runtimeProfile: z.string().min(1),
  toolAccess: z.array(z.string().min(1)),
  memoryContext: z.string().min(1),
  approvalPolicy: z.literal("allow_all"),
  heartbeatPolicy: z.string().min(1),
  hermesAgentReference: z.string().min(1),
  channel: productWorkerChannelConfigSchema.optional(),
});
const productCapabilityProviderIdSchema = z.enum(["chrome", "composio"]);
const productComposioOverviewQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  search: z.string().max(200).optional(),
  filter: z.enum(["all", "connected", "not_connected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const productComposioAuthorizeBodySchema = z.object({
  alias: z.string().max(120).nullable().optional(),
  toolkitName: z.string().min(1).max(120).optional(),
  language: z.enum(["en", "zh"]).optional(),
});

const productConflictErrorMessages = new Set([
  "Cannot remove installed workflow while a run is active.",
  "Enable this workflow before running it.",
  "Choose a deploy target before running this workflow.",
  "Choose a valid deploy target before running this workflow.",
  "Deploy target is not available right now.",
  "Deploy target is assigned to another worker.",
  "Assign an available device before starting this worker.",
  "Assign a valid device before starting this worker.",
  "Assigned device is not available right now.",
  "Assigned device is linked to another worker.",
  "This worker is already running a workflow.",
  "Run an installed workflow before sending worker commands.",
  "AI worker is still initializing. Wait for the Agent panel readiness message before sending commands.",
]);

const productBadRequestErrorMessages = new Set([
  "Worker name and identity scope are required.",
  "Workflow id and title are required.",
]);
const startBodySchema = z.object({
  autoStopMinutes: z.coerce.number().positive().optional(),
  ocrLanguagePriority: ocrLanguagePrioritySchema.optional(),
  enableAudio: z.boolean().optional(),
});
const skillExtractionBodySchema = z.object({
  workflowPath: z.string().min(1),
  workflowId: z.string().min(1),
  generationGuidance: z.string().min(1).optional(),
});
const workflowCandidateBodySchema = z.object({
  workflowId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  goal: z.string().min(1),
  priority: z.coerce.number().int().positive(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  startEventId: z.string().min(1),
  endEventId: z.string().min(1),
  startTs: z.string().min(1),
  endTs: z.string().min(1),
  eventCount: z.coerce.number().int().nonnegative(),
  whyThisWorkflow: z.string().min(1).optional(),
});
const workflowArtifactBodySchema = z.object({
  workflowCandidates: z.array(workflowCandidateBodySchema).min(1),
  selectedWorkflowId: z.string().min(1).nullable().optional(),
});
const generalizationBodySchema = z.object({
  skillPath: z.string().min(1),
});
const openClawSkillFieldSchema = z.object({
  name: z.string().min(1),
  // Generated skills may legitimately leave input/output descriptions blank.
  // The editor saves the whole artifact, so the API must accept those existing fields.
  description: z.string(),
  required: z.boolean().optional(),
});
const openClawSkillStepSchema = z.object({
  step: z.coerce.number().int().positive(),
  instruction: z.string().min(1),
  intent: z.string().min(1),
  operationApp: z.string().min(1),
  hints: z.array(z.string()),
  referenceRefs: z.array(z.string().min(1)).optional(),
});
const openClawSkillAssetValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.record(z.string(), z.string()),
]);
const openClawSkillAssetSchema = z.object({
  name: z.string().min(1),
  value: openClawSkillAssetValueSchema,
  notes: z.string().optional(),
});
const openClawSkillReferenceSchema = openClawSkillAssetSchema.extend({
  id: z.string().min(1),
});
const openClawSkillSchema = z.object({
  schemaVersion: z.literal("openclaw-skill-v1"),
  promptSet: z.string().nullable(),
  skillId: z.string().min(1),
  skillName: z.string().min(1),
  generatedAt: z.string().min(1),
  source: z.object({
    runId: z.string().min(1),
    runDir: z.string().min(1),
    episodeId: z.string().min(1),
    startTs: z.string().min(1),
    endTs: z.string().min(1),
  }),
  executionMode: z.enum(["autonomous"]).optional(),
  shortDescription: z.string().optional(),
  description: z.string(),
  goal: z.string(),
  whenToUse: z.array(z.string().min(1)),
  whenNotToUse: z.array(z.string()),
  inputs: z.array(openClawSkillFieldSchema),
  outputs: z.array(openClawSkillFieldSchema),
  prerequisites: z.array(z.string().min(1)),
  steps: z.array(openClawSkillStepSchema),
  successCriteria: z.array(z.string().min(1)),
  failureModes: z.array(z.string()),
  fallback: z.array(z.string()),
  examples: z.array(z.string()),
  tags: z.array(z.string()),
  assets: z.array(openClawSkillAssetSchema),
  references: z.array(openClawSkillReferenceSchema).optional(),
  evidence: z.object({
    totalEvents: z.coerce.number().int().nonnegative(),
    anchorEvents: z.coerce.number().int().nonnegative(),
    ocrEvents: z.coerce.number().int().nonnegative(),
    appsSeen: z.array(z.string()),
    windowsSeen: z.array(z.string()),
  }),
});
const plannerOptimizationBodySchema = z.object({
  sourceType: z.enum(["base", "generalized"]),
  skillPath: z.string().min(1),
});
const updateSkillArtifactBodySchema = z.object({
  sourceType: z.enum(["base", "generalized", "planner-optimized"]),
  skillPath: z.string().min(1),
  skill: openClawSkillSchema,
});
const openClawInstallBodySchema = z.object({
  sourceType: z.enum(["base", "generalized", "planner-optimized"]),
  skillPath: z.string().min(1),
});
const openClawUninstallBodySchema = z.object({
  confirmName: z.string().min(1).optional(),
});
const skillManagerConfigBodySchema = z.object({
  skillPath: z.string().min(1),
});
const skillManagerExportBodySchema = z.object({
  sourceType: z.enum(["base", "generalized", "planner-optimized"]),
  skillPath: z.string().min(1),
});
const skillManagerUninstallBodySchema = z.object({
  confirmName: z.string().min(1).optional(),
});
const llmConfigBodySchema = z.object({
  provider: z.string().optional().nullable(),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  wireApi: z.enum(["responses", "chat-completions"]),
  reasoningEffort: z.string().optional().nullable(),
  responseReadTimeoutMs: z.number().int().positive().optional().nullable(),
  responseTimeoutMode: z.enum(["fixed", "idle"]).optional().nullable(),
  callProfiles: z
    .object({
      "workflow-discovery": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
      "skill-extraction-step": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
      "skill-extraction-terminal": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
      "planner-optimization": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
      "scenario-prediction": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
      "scenario-generalization": z
        .object({
          reasoningEffort: z.string().optional().nullable(),
          responseReadTimeoutMs: z
            .number()
            .int()
            .positive()
            .optional()
            .nullable(),
        })
        .optional(),
    })
    .optional()
    .nullable(),
  clientProfile: z
    .enum(["default", "openai-js", "codex-desktop"])
    .optional()
    .nullable(),
  authMode: z.enum(["direct", "env", "none"]),
  apiKey: z.string().optional().nullable(),
  apiKeyEnv: z.string().optional().nullable(),
});
const llmModelsBodySchema = z.object({
  baseUrl: z.string().url(),
  authMode: z.enum(["direct", "env", "none"]),
  apiKey: z.string().optional().nullable(),
  apiKeyEnv: z.string().optional().nullable(),
});
const artifactKindSchema = z.enum([
  "ingest-summary",
  "workflow",
  "skill",
  "skill-summary",
  "generalization-summary",
  "planner-skill",
  "planner-summary",
]);
const RUNTIME_STARTUP_LOG_PATH = resolve(
  resolveRuntimeLogRoot(),
  "runtime-startup.log",
);

export interface RuntimeServerHandle {
  app: express.Express;
  config: RuntimeConfig;
  service: LabService;
  productStore: ProductStore;
  close: () => Promise<void>;
}

const RUNTIME_HTTP_FORCE_CLOSE_DELAY_MS = 1_000;

/**
 * EN: Stops accepting Runtime HTTP traffic and bounds how long persistent renderer connections may delay shutdown.
 * 中文: 停止接收 Runtime HTTP 流量，并限制渲染进程持久连接拖延退出的最长时间。
 * @param server active local Runtime HTTP server.
 * @param forceCloseDelayMs grace period before active connections are force-closed.
 * @returns when the HTTP listener and all remaining connections are closed.
 */
export async function closeRuntimeHttpServer(
  server: ReturnType<express.Express["listen"]>,
  forceCloseDelayMs = RUNTIME_HTTP_FORCE_CLOSE_DELAY_MS,
): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(forceCloseTimer);
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    };
    const forceCloseTimer = setTimeout(() => {
      logRuntimeStartup("force closing remaining runtime http connections", {
        forceCloseDelayMs,
      });
      server.closeAllConnections();
    }, forceCloseDelayMs);

    server.close((error) => finish(error ?? undefined));
    server.closeIdleConnections();
  });
}

/**
 * EN: Closes every Runtime-owned resource without allowing one failed cleanup to skip the others.
 * 中文: 关闭 Runtime 持有的全部资源，且任一清理失败都不会跳过其它清理项。
 * @param input active HTTP server, ProductStore, and LabService instances.
 * @returns when every close operation has settled; rejects with the collected cleanup error(s).
 */
export async function closeRuntimeServerResources(input: {
  server: ReturnType<express.Express["listen"]>;
  productStore: Pick<ProductStore, "shutdown">;
  service: Pick<LabService, "shutdown">;
}): Promise<void> {
  const closeOperations = [
    () => closeRuntimeHttpServer(input.server),
    () => input.productStore.shutdown(),
    () => input.service.shutdown(),
  ];
  const results = await Promise.allSettled(
    closeOperations.map((closeOperation) =>
      Promise.resolve().then(closeOperation),
    ),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Multiple Runtime resources failed to close.",
    );
  }
}

export type RuntimeErrorReporter = (
  error: unknown,
  context: RuntimeErrorContext,
) => string | null;

/**
 * EN: Creates the Runtime HTTP app that exposes the lab service through stable `/api/*` routes.
 * @param input service and runtime config.
 * @returns configured Express app.
 */
export function createRuntimeHttpApp(input: {
  service: LabService;
  productStore?: ProductStore;
  cloudSession?: RuntimeCloudSession;
  codexWorkflowService?: CodexWorkflowService;
  clawHubService?: ProductClawHubService;
  config: RuntimeConfig;
  errorReporter?: RuntimeErrorReporter;
}): express.Express {
  const app = express();
  const cloudSession = input.cloudSession ?? createRuntimeCloudSession();
  let productStoreInstance = input.productStore ?? null;
  let codexWorkflowServiceInstance = input.codexWorkflowService ?? null;
  let clawHubServiceInstance = input.clawHubService ?? null;

  function getProductStore(): ProductStore {
    productStoreInstance ??= createProductStore({
      runtimeConfig: input.config,
      composioAdapter: createHostedComposioProviderAdapter({ cloudSession }),
    });
    return productStoreInstance;
  }

  function getClawHubService(): ProductClawHubService {
    clawHubServiceInstance ??= createProductClawHubService();
    return clawHubServiceInstance;
  }

  async function readProductState() {
    const productStore = getProductStore();
    if (typeof input.service.listSessions !== "function") {
      return productStore.getState();
    }
    return productStore.syncLabSessions(await input.service.listSessions());
  }

  function getCodexWorkflowService(): CodexWorkflowService {
    codexWorkflowServiceInstance ??= createCodexWorkflowService({
      runsRoot: input.config.runsRoot,
      readProductState,
    });
    return codexWorkflowServiceInstance;
  }

  app.use((req, res, next) => {
    const requestOrigin = req.headers.origin;
    const allowedOrigin =
      typeof requestOrigin === "string"
        ? resolveAllowedRuntimeCorsOrigin(requestOrigin)
        : null;

    if (typeof requestOrigin === "string" && allowedOrigin === null) {
      res.status(403).json({
        error: {
          message: `Origin not allowed: ${requestOrigin}`,
        },
      });
      return;
    }

    if (allowedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.append("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, X-OysterWorkflow-Runtime-Secret",
      );
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  });

  app.use((req, res, next) => {
    if (
      input.config.apiSecret &&
      !isPublicRuntimeRoute(req) &&
      !matchesRuntimeApiSecret(
        req.headers[RUNTIME_API_SECRET_HEADER],
        input.config.apiSecret,
      )
    ) {
      res.status(401).json({
        error: {
          message:
            "Local Runtime authentication failed. / 本地 Runtime 鉴权失败。",
        },
      });
      return;
    }
    next();
  });

  app.use((req, _res, next) => {
    const accessToken = req.headers.authorization
      ?.match(/^Bearer\s+(.+)$/iu)?.[1]
      ?.trim();
    cloudSession.runWithAccessToken(accessToken ?? null, next);
  });

  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      envPath: input.config.codexEnvPath,
      mode: input.config.mode,
      apiPort: input.config.apiPort,
      screenpipeBaseUrl: input.config.screenpipeBaseUrl,
    });
  });

  app.get("/api/product/state", async (_req, res) => {
    res.json({
      state: await readProductState(),
    } satisfies ProductStateResponse);
  });

  app.get("/api/product/workflows/pending-merges", async (_req, res) => {
    res.json({
      items: await getProductStore().listPendingWorkflowMerges(),
    } satisfies ProductPendingWorkflowMergesResponse);
  });

  app.get("/api/product/workflows/:workflowId/graph", async (req, res) => {
    const query = productWorkflowGraphQuerySchema.parse(req.query);
    const state = await readProductState();
    const workflow = state.workflows.find(
      (item) => item.id === req.params.workflowId,
    );
    res.json(
      (await readProductWorkflowGraph({
        workflowId: req.params.workflowId,
        artifactPath: workflow?.artifactPath,
        graphPath: query.graphPath,
        candidatePath: query.candidatePath,
        mergeProposalPath: query.mergeProposalPath,
        workflows: state.workflows,
      })) satisfies ProductWorkflowGraphResponse,
    );
  });

  app.patch("/api/product/workflows/:workflowId/graph", async (req, res) => {
    const edit = parseProductWorkflowGraphEditInput(req.body);
    res.json(
      (await getProductStore().editWorkflowGraph(
        req.params.workflowId,
        edit,
      )) satisfies ProductWorkflowGraphEditResponse,
    );
  });

  app.post(
    "/api/product/workflows/:workflowId/merge-proposal/apply",
    async (req, res) => {
      const body = productWorkflowMergeApplyBodySchema.parse(req.body ?? {});
      res.json(
        (await getProductStore().applyWorkflowMergeProposal(
          req.params.workflowId,
          body.targetWorkflowId,
        )) satisfies ProductApplyWorkflowMergeResponse,
      );
    },
  );

  app.post(
    "/api/product/workflows/:workflowId/merge-proposal/keep-new",
    async (req, res) => {
      res.json({
        state: await getProductStore().keepWorkflowAsNew(req.params.workflowId),
        sourceWorkflowId: req.params.workflowId,
        decision: "create_new",
      } satisfies ProductCreateNewWorkflowDecisionResponse);
    },
  );

  app.get("/api/product/workflows/:workflowId/versions", async (req, res) => {
    res.json(
      (await getProductStore().listWorkflowVersions(
        req.params.workflowId,
      )) satisfies ProductWorkflowVersionsResponse,
    );
  });

  app.post(
    "/api/product/workflows/:workflowId/versions/restore",
    async (req, res) => {
      const body = productWorkflowRestoreBodySchema.parse(req.body);
      res.json(
        (await getProductStore().restoreWorkflowVersion(
          req.params.workflowId,
          body.revisionId,
        )) satisfies ProductRestoreWorkflowVersionResponse,
      );
    },
  );

  app.get("/api/codex/workflows/search", async (req, res) => {
    const query = codexWorkflowSearchQuerySchema.parse(req.query);
    res.json(
      await getCodexWorkflowService().searchWorkflows({
        query: query.q,
        limit: query.limit,
      }),
    );
  });

  app.post(["/api/mcp", "/api/codex/mcp"], async (req, res) => {
    const response = await handleOysterWorkflowMcpMessage(
      req.body,
      getCodexWorkflowService(),
    );
    if (response === null) {
      res.status(202).end();
      return;
    }
    res.json(response);
  });

  app.get(["/api/mcp", "/api/codex/mcp"], (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      error: {
        message:
          "This stateless MCP endpoint accepts JSON-RPC over POST / 此无状态 MCP 端点只接受 POST JSON-RPC。",
      },
    });
  });

  app.get("/api/codex/workflows/:workflowId/readiness", async (req, res) => {
    res.json(
      await getCodexWorkflowService().getWorkflowReadiness(
        req.params.workflowId,
      ),
    );
  });

  app.get("/api/codex/workflows/:workflowId", async (req, res) => {
    res.json(
      await getCodexWorkflowService().fetchWorkflow(req.params.workflowId),
    );
  });

  app.post("/api/codex/workflow-runs", async (req, res) => {
    const body = prepareCodexWorkflowRunBodySchema.parse(req.body ?? {});
    res.status(201).json(await getCodexWorkflowService().prepareRun(body));
  });

  app.get("/api/codex/workflow-runs/:runId", async (req, res) => {
    res.json(await getCodexWorkflowService().getRun(req.params.runId));
  });

  app.post("/api/codex/workflow-runs/:runId/advance", async (req, res) => {
    const body = advanceCodexWorkflowRunBodySchema.parse(req.body ?? {});
    res.json(
      await getCodexWorkflowService().advanceRun(req.params.runId, body),
    );
  });

  app.post("/api/codex/workflow-runs/:runId/cancel", async (req, res) => {
    res.json(await getCodexWorkflowService().cancelRun(req.params.runId));
  });

  app.post("/api/product/cloud/sync", async (req, res) => {
    const authorization = req.headers.authorization;
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
    if (!accessToken) {
      res.status(401).json({ error: "Sign in before syncing this device." });
      return;
    }
    const body = productCloudSyncBodySchema.parse(req.body ?? {});
    res.json(
      (await syncProductControlPlane({
        accessToken,
        authenticatedUser: body.authenticatedUser,
        productStore: getProductStore(),
        runtimeConfig: input.config,
        mode: body.mode,
      })) satisfies CloudSyncResult,
    );
  });

  app.delete("/api/product/cloud/session", (_req, res) => {
    // EN/CN: Credentials are request-scoped; there is no cross-request token to clear.
    res.status(204).end();
  });

  app.post("/api/product/hermes/probe", async (_req, res) => {
    const productStore = getProductStore();
    await productStore.refreshHermes();
    res.json({
      state: await readProductState(),
    } satisfies ProductStateResponse);
  });

  app.post("/api/product/capabilities/:providerId/check", async (req, res) => {
    const providerId = productCapabilityProviderIdSchema.parse(
      req.params.providerId,
    ) as ProductCapabilityProviderId;
    const productStore = getProductStore();
    res.json(
      (await productStore.checkCapabilityProvider(
        providerId,
      )) satisfies ProductCapabilityProviderCheckResponse,
    );
  });

  app.post(
    "/api/product/capabilities/:providerId/prepare",
    async (req, res) => {
      const providerId = productCapabilityProviderIdSchema.parse(
        req.params.providerId,
      ) as ProductCapabilityProviderId;
      const productStore = getProductStore();
      res.json(
        (await productStore.prepareCapabilityProvider(
          providerId,
        )) satisfies ProductCapabilityProviderCheckResponse,
      );
    },
  );

  app.get("/api/product/integrations/composio", async (req, res) => {
    const query = productComposioOverviewQuerySchema.parse(req.query);
    res.json(
      (await getProductStore().getComposioOverview(
        query,
      )) satisfies ProductComposioOverviewResponse,
    );
  });

  app.post(
    "/api/product/integrations/composio/toolkits/:toolkitSlug/authorize",
    async (req, res) => {
      const body = productComposioAuthorizeBodySchema.parse(req.body ?? {});
      const callbackUrl = new URL(
        "/api/product/integrations/composio/callback",
        `http://127.0.0.1:${input.config.apiPort}`,
      );
      callbackUrl.searchParams.set(
        "toolkitName",
        body.toolkitName ?? req.params.toolkitSlug,
      );
      callbackUrl.searchParams.set("language", body.language ?? "en");
      res.json(
        (await getProductStore().authorizeComposioToolkit({
          toolkitSlug: req.params.toolkitSlug,
          alias: body.alias,
          callbackUrl: callbackUrl.toString(),
        })) satisfies ProductComposioAuthorizeResponse,
      );
    },
  );

  app.get("/api/product/integrations/composio/callback", (req, res) => {
    const language = queryText(req.query.language) === "zh" ? "zh" : "en";
    const toolkitName =
      queryText(req.query.toolkitName)?.slice(0, 120) ??
      (language === "zh" ? "应用" : "application");
    const successful = queryText(req.query.status)?.toLowerCase() === "success";
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("Cache-Control", "no-store");
    res.type("html").send(
      renderProductConnectionCallbackPage({
        language,
        successful,
        toolkitName,
      }),
    );
  });

  app.get(
    "/api/product/integrations/composio/connections/:connectionId",
    async (req, res) => {
      res.json({
        connection: await getProductStore().getComposioConnection(
          req.params.connectionId,
        ),
      } satisfies ProductComposioConnectionResponse);
    },
  );

  app.delete(
    "/api/product/integrations/composio/connections/:connectionId",
    async (req, res) => {
      await getProductStore().disconnectComposioConnection(
        req.params.connectionId,
      );
      res.json({
        disconnected: true,
        connectionId: req.params.connectionId,
      } satisfies ProductComposioDisconnectResponse);
    },
  );

  app.post("/api/product/account/setup", async (req, res) => {
    const body = productAccountSetupBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.setupAccount(
        body,
      )) satisfies ProductAccountSetupResponse,
    );
  });

  app.post("/api/product/devices/assign", async (req, res) => {
    const body = productAssignDeviceBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.assignDevice(
        body,
      )) satisfies ProductAssignDeviceResponse,
    );
  });

  app.post("/api/product/workers", async (req, res) => {
    const body = productCreateWorkerBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.createWorker(
        body,
      )) satisfies ProductCreateWorkerResponse,
    );
  });

  app.delete("/api/product/workers/:workerId", async (req, res) => {
    res.json(
      (await getProductStore().deleteWorker(
        req.params.workerId,
      )) satisfies ProductDeleteWorkerResponse,
    );
  });

  app.post("/api/product/workflows", async (req, res) => {
    const body = productCreateWorkflowBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.createWorkflow(
        body,
      )) satisfies ProductCreateWorkflowResponse,
    );
  });

  app.get("/api/product/clawhub/auth", async (_req, res) => {
    res.json(
      (await getClawHubService().getAuthState()) satisfies ProductClawHubAuthState,
    );
  });

  app.post("/api/product/clawhub/login", async (_req, res) => {
    res.json(
      (await getClawHubService().beginLogin()) satisfies ProductClawHubLoginStartResponse,
    );
  });

  app.get("/api/product/clawhub/login/:loginId", async (req, res) => {
    res.json(
      (await getClawHubService().getLoginStatus(
        req.params.loginId,
      )) satisfies ProductClawHubLoginStatusResponse,
    );
  });

  app.post(
    "/api/product/workflows/:workflowId/clawhub-publish",
    async (req, res) => {
      productClawHubPublishBodySchema.parse(req.body ?? {});
      const state = await readProductState();
      const workflow = state.workflows.find(
        (item) => item.id === req.params.workflowId,
      );
      if (!workflow) {
        throw new Error(`Unknown workflow: ${req.params.workflowId}`);
      }
      if (!workflow.artifactPath || workflow.status === "Captured") {
        throw new Error(
          "Generate this workflow before publishing it to ClawHub.",
        );
      }
      res.json(
        (await getClawHubService().publishWorkflow({
          workflowId: workflow.id,
          title: workflow.title,
          skillPath: workflow.artifactPath,
        })) satisfies ProductClawHubPublishResponse,
      );
    },
  );

  app.post("/api/product/workers/:workerId/config", async (req, res) => {
    const body = productWorkerConfigBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.updateWorkerConfig(
        req.params.workerId,
        body,
      )) satisfies ProductWorkerConfigResponse,
    );
  });

  app.post(
    "/api/product/workers/:workerId/channel/config",
    async (req, res) => {
      const body = productWorkerChannelInputSchema.parse(req.body ?? {});
      const productStore = getProductStore();
      res.json(
        (await productStore.configureWorkerChannel(
          req.params.workerId,
          body,
        )) satisfies ProductWorkerChannelConfigureResponse,
      );
    },
  );

  app.post("/api/product/workers/:workerId/channel/test", async (req, res) => {
    const productStore = getProductStore();
    res.json(
      (await productStore.testWorkerChannel(
        req.params.workerId,
      )) satisfies ProductWorkerChannelTestResponse,
    );
  });

  app.post(
    "/api/product/workers/:workerId/channel/setups",
    async (req, res) => {
      const body = productBeginChannelSetupBodySchema.parse(req.body ?? {});
      res.json(
        (await getProductStore().beginWorkerChannelSetup(
          req.params.workerId,
          body,
        )) satisfies ProductChannelSetupResponse,
      );
    },
  );

  app.get(
    "/api/product/workers/:workerId/channel/setups/:setupId",
    async (req, res) => {
      res.json(
        (await getProductStore().readWorkerChannelSetup(
          req.params.workerId,
          req.params.setupId,
        )) satisfies ProductChannelSetupResponse,
      );
    },
  );

  app.delete(
    "/api/product/workers/:workerId/channel/setups/:setupId",
    async (req, res) => {
      res.json(
        (await getProductStore().cancelWorkerChannelSetup(
          req.params.workerId,
          req.params.setupId,
        )) satisfies ProductChannelSetupResponse,
      );
    },
  );

  app.post(
    "/api/product/workers/:workerId/channel/pairing/approve",
    async (req, res) => {
      const body = productApproveChannelPairingBodySchema.parse(req.body ?? {});
      res.json(
        (await getProductStore().approveWorkerChannelPairing(
          req.params.workerId,
          body,
        )) satisfies ProductApproveChannelPairingResponse,
      );
    },
  );

  app.post(
    "/api/product/workers/:workerId/channel/bindings",
    async (req, res) => {
      const body = productBindChannelBodySchema.parse(req.body ?? {});
      res.json(
        (await getProductStore().bindWorkerChannel(
          req.params.workerId,
          body,
        )) satisfies ProductChannelBindingResponse,
      );
    },
  );

  app.get(
    "/api/product/workers/:workerId/channel/connections/:connectionId/peers",
    async (req, res) => {
      res.json(
        (await getProductStore().listWorkerChannelPeers(
          req.params.workerId,
          req.params.connectionId,
        )) satisfies ProductChannelPeersResponse,
      );
    },
  );

  app.delete(
    "/api/product/workers/:workerId/channel/connections/:connectionId",
    async (req, res) => {
      res.json(
        (await getProductStore().disconnectWorkerChannel(req.params.workerId, {
          connectionId: req.params.connectionId,
        })) satisfies ProductDisconnectChannelResponse,
      );
    },
  );

  app.post("/api/product/workflows/install", async (req, res) => {
    const body = productInstallWorkflowBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.installWorkflow(
        body,
      )) satisfies ProductInstallWorkflowResponse,
    );
  });

  app.delete("/api/product/workflows/:workflowId", async (req, res) => {
    const body = productDeleteWorkflowBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.deleteWorkflow({
        workflowId: req.params.workflowId,
        workflowTitle: body.workflowTitle,
      })) satisfies ProductDeleteWorkflowResponse,
    );
  });

  app.post("/api/product/workers/:workerId/start", async (req, res) => {
    const productStore = getProductStore();
    res.json(
      (await productStore.startWorker(
        req.params.workerId,
      )) satisfies ProductStartWorkerResponse,
    );
  });

  app.post(
    "/api/product/installed-workflows/:installedWorkflowId/run",
    async (req, res) => {
      const productStore = getProductStore();
      res.json(
        (await productStore.runInstalledWorkflow(
          req.params.installedWorkflowId,
        )) satisfies ProductRunWorkflowResponse,
      );
    },
  );

  app.post("/api/product/workers/:workerId/stop", async (req, res) => {
    const productStore = getProductStore();
    res.json({
      state: await productStore.stopWorker(req.params.workerId),
    } satisfies ProductStateResponse);
  });

  app.post("/api/product/workers/:workerId/commands", async (req, res) => {
    const body = productCommandBodySchema.parse(req.body ?? {});
    const productStore = getProductStore();
    res.json(
      (await productStore.sendCommand(
        req.params.workerId,
        body.command,
      )) satisfies ProductCommandResponse,
    );
  });

  app.post(
    "/api/product/installed-workflows/:installedWorkflowId/status",
    async (req, res) => {
      const body = productInstalledWorkflowStatusBodySchema.parse(
        req.body ?? {},
      );
      const productStore = getProductStore();
      res.json({
        state: await productStore.toggleInstalledWorkflow(
          req.params.installedWorkflowId,
          body.status,
        ),
      } satisfies ProductStateResponse);
    },
  );

  app.delete(
    "/api/product/installed-workflows/:installedWorkflowId",
    async (req, res) => {
      const productStore = getProductStore();
      res.json(
        (await productStore.deleteInstalledWorkflow(
          req.params.installedWorkflowId,
        )) satisfies ProductDeleteInstalledWorkflowResponse,
      );
    },
  );

  app.get("/api/recorder/state", async (_req, res) => {
    res.json(await input.service.getRecorderState());
  });

  app.get("/api/recorder/permissions/check", async (req, res) => {
    const forceRefresh = req.query.force === "1" || req.query.force === "true";
    const permissions = await input.service.checkRecorderPermissions({
      forceRefresh,
    });
    await getProductStore().recordPermissionSnapshot(permissions);
    res.json(permissions);
  });

  app.post("/api/recorder/bootstrap", async (req, res) => {
    const body = startBodySchema.parse(req.body ?? {});
    res.json(await input.service.bootstrapRecorder(body));
  });

  app.get("/api/llm/config", async (_req, res) => {
    res.json(await input.service.getLlmConfig());
  });

  app.post("/api/llm/config", async (req, res) => {
    const body = llmConfigBodySchema.parse(req.body ?? {});
    res.json(
      (await input.service.updateLlmConfig(body)) satisfies LlmConfigResponse,
    );
  });

  app.post("/api/llm/models", async (req, res) => {
    const body = llmModelsBodySchema.parse(req.body ?? {});
    res.json(
      (await input.service.listLlmModels(body)) satisfies LlmModelsResponse,
    );
  });

  app.post("/api/recorder/start", async (req, res) => {
    const body = startBodySchema.parse(req.body ?? {});
    const session = await input.service.startRecording(body);
    res.json({ session } satisfies SessionResponse);
  });

  app.post("/api/recorder/stop", async (_req, res) => {
    const session = await input.service.stopRecording();
    res.json({ session } satisfies SessionResponse);
  });

  app.post("/api/recorder/timed-stop", async (req, res) => {
    const body = timedStopBodySchema.parse(req.body ?? {});
    const session = await input.service.scheduleTimedStop(body.autoStopMinutes);
    res.json({ session } satisfies SessionResponse);
  });

  app.get("/api/sessions", async (_req, res) => {
    res.json({
      sessions: await input.service.listSessions(),
    });
  });

  app.get("/api/sessions/:sessionId", async (req, res) => {
    res.json({
      session: await input.service.getSession(req.params.sessionId),
    } satisfies SessionResponse);
  });

  app.delete("/api/sessions/:sessionId", async (req, res) => {
    await input.service.deleteSession(req.params.sessionId);
    res.status(204).end();
  });

  app.get("/api/openclaw/skills", async (_req, res) => {
    res.json({
      skills: await input.service.listOpenClawSkills(),
    } satisfies OpenClawSkillsResponse);
  });

  app.get("/api/skill-manager/config", async (_req, res) => {
    res.json(
      (await input.service.getSkillManagerConfig()) satisfies SkillManagerConfigResponse,
    );
  });

  app.post("/api/skill-manager/config", async (req, res) => {
    const body = skillManagerConfigBodySchema.parse(req.body ?? {});
    res.json(
      (await input.service.updateSkillManagerConfig(
        body,
      )) satisfies SkillManagerConfigResponse,
    );
  });

  app.get("/api/skill-manager/path-candidates", async (_req, res) => {
    res.json({
      candidates: await input.service.listSkillManagerPathCandidates(),
    } satisfies SkillManagerPathCandidatesResponse);
  });

  app.get("/api/skill-manager/skills", async (_req, res) => {
    res.json({
      skills: await input.service.listInstalledSkills(),
    } satisfies SkillManagerSkillsResponse);
  });

  app.post("/api/sessions/:sessionId/retry-ingest", async (req, res) => {
    res.json({
      session: await input.service.retryIngest(req.params.sessionId),
    } satisfies SessionResponse);
  });

  app.post("/api/sessions/:sessionId/workflow-discovery", async (req, res) => {
    res.json({
      session: await input.service.runWorkflowDiscovery(req.params.sessionId),
    } satisfies SessionResponse);
  });

  app.post("/api/sessions/:sessionId/workflow-artifact", async (req, res) => {
    const body = workflowArtifactBodySchema.parse(req.body ?? {});
    res.json({
      session: await input.service.saveWorkflowArtifact(
        req.params.sessionId,
        body,
      ),
    } satisfies SessionResponse);
  });

  app.post("/api/sessions/:sessionId/skill-extraction", async (req, res) => {
    const body = skillExtractionBodySchema.parse(req.body ?? {});
    res.json({
      session: await input.service.runSkillExtraction(
        req.params.sessionId,
        body,
      ),
    } satisfies SessionResponse);
  });

  app.post("/api/sessions/:sessionId/generalization", async (req, res) => {
    const body = generalizationBodySchema.parse(req.body ?? {});
    res.json({
      session: await input.service.runGeneralization(
        req.params.sessionId,
        body,
      ),
    } satisfies SessionResponse);
  });

  app.post(
    "/api/sessions/:sessionId/planner-optimization",
    async (req, res) => {
      const body = plannerOptimizationBodySchema.parse(req.body ?? {});
      res.json({
        session: await input.service.runPlannerOptimization(
          req.params.sessionId,
          body,
        ),
      } satisfies SessionResponse);
    },
  );

  app.post("/api/sessions/:sessionId/skill-artifact", async (req, res) => {
    const body = updateSkillArtifactBodySchema.parse(req.body ?? {});
    res.json({
      session: await input.service.updateSkillArtifact(
        req.params.sessionId,
        body,
      ),
    } satisfies SessionResponse);
  });

  app.post("/api/sessions/:sessionId/openclaw-install", async (req, res) => {
    const body = openClawInstallBodySchema.parse(req.body ?? {});
    res.json({
      result: await input.service.installOpenClawSkill(
        req.params.sessionId,
        body,
      ),
    } satisfies OpenClawInstallResponse);
  });

  app.post("/api/openclaw/skills/:installName/uninstall", async (req, res) => {
    const body = openClawUninstallBodySchema.parse(req.body ?? {});
    res.json({
      result: await input.service.uninstallOpenClawSkill(
        req.params.installName,
        body,
      ),
    } satisfies OpenClawUninstallResponse);
  });

  app.post(
    "/api/sessions/:sessionId/skill-manager/export",
    async (req, res) => {
      const body = skillManagerExportBodySchema.parse(req.body ?? {});
      res.json({
        result: await input.service.exportSkillToManager(
          req.params.sessionId,
          body,
        ),
      } satisfies SkillManagerExportResponse);
    },
  );

  app.post(
    "/api/skill-manager/skills/:installName/uninstall",
    async (req, res) => {
      const body = skillManagerUninstallBodySchema.parse(req.body ?? {});
      res.json({
        result: await input.service.uninstallInstalledSkill(
          req.params.installName,
          body,
        ),
      } satisfies SkillManagerUninstallResponse);
    },
  );

  app.get("/api/sessions/:sessionId/artifacts/:kind", async (req, res) => {
    const kind = artifactKindSchema.parse(req.params.kind) as LabArtifactKind;
    res.json(await input.service.getArtifact(req.params.sessionId, kind));
  });

  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      void _next;
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: {
            message: error.issues
              .map((issue) => {
                const path =
                  issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
                return `${path}${issue.message}`;
              })
              .join("; "),
          },
        });
        return;
      }

      if (error instanceof CodexWorkflowServiceError) {
        res.status(error.status).json({
          error: {
            code: error.code,
            message: error.message,
          },
        });
        return;
      }

      const clientStatus = productClientErrorStatus(error);
      if (clientStatus) {
        res.status(clientStatus).json({
          error: {
            message: errorMessage(error),
          },
        });
        return;
      }

      const eventId = reportRuntimeError(input.errorReporter, error, {
        method: req.method,
        route: runtimeRouteLabel(req),
        status: 500,
      });
      if (eventId) {
        res.setHeader("X-OysterWorkflow-Event-ID", eventId);
      }
      res.status(500).json({
        error: {
          message:
            "An internal Runtime error occurred. Try again or share the event ID with support. / Runtime 内部发生错误，请重试或向支持人员提供事件 ID。",
          ...(eventId ? { eventId } : {}),
        },
      });
    },
  );

  return app;
}

function productClientErrorStatus(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  if (
    /^Unknown (device|installed workflow|run|worker|workflow|Composio connection): /u.test(
      error.message,
    )
  ) {
    return 404;
  }
  if (isWorkflowGraphEditConflict(error)) {
    return 409;
  }
  if (error.message.startsWith("Composio is not configured")) {
    return 409;
  }
  if (
    error.message === "Connect ClawHub before publishing this workflow." ||
    error.message === "Generate this workflow before publishing it to ClawHub."
  ) {
    return 409;
  }
  if (productBadRequestErrorMessages.has(error.message)) {
    return 400;
  }
  if (productConflictErrorMessages.has(error.message)) {
    return 409;
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportRuntimeError(
  reporter: RuntimeErrorReporter | undefined,
  error: unknown,
  context: RuntimeErrorContext,
): string | null {
  try {
    return reporter?.(error, context) ?? null;
  } catch {
    return null;
  }
}

function runtimeRouteLabel(req: express.Request): string {
  const route = req.route as { path?: unknown } | undefined;
  return typeof route?.path === "string"
    ? route.path
    : "unmatched-runtime-route";
}

/**
 * EN: Starts the Runtime HTTP server for Electron or local dev scripts.
 * @param input CLI args or overrides.
 * @returns running Runtime server handle.
 */
export async function startRuntimeHttpServer(
  input: {
    argv?: string[];
    configOverrides?: ResolveRuntimeConfigInput;
    errorReporter?: RuntimeErrorReporter;
  } = {},
): Promise<RuntimeServerHandle> {
  logRuntimeStartup("startRuntimeHttpServer called", {
    pid: process.pid,
    argv: redactRuntimeArgv(input.argv ?? process.argv.slice(2)),
  });
  const cliConfig = parseRuntimeCliArgs(input.argv ?? process.argv.slice(2));
  logRuntimeStartup("parsed runtime cli args", redactRuntimeConfig(cliConfig));
  const config = resolveRuntimeConfig({
    ...cliConfig,
    ...input.configOverrides,
  });
  if (config.mode === "desktop" && !config.apiSecret) {
    throw new Error(
      "Desktop Runtime requires a per-launch capability secret. / 桌面 Runtime 必须提供每次启动生成的能力密钥。",
    );
  }
  logRuntimeStartup("resolved runtime config", redactRuntimeConfig(config));

  loadCodexEnv(config.codexEnvPath);
  logRuntimeStartup("loaded codex env", config.codexEnvPath);
  logRuntimeStartup("creating lab service");
  let productStoreForWorkflowFamilies: ProductStore | null = null;
  const service = await createLabService({
    runtimeConfig: config,
    listWorkflowFamilyArtifactSourcesFn: async () => {
      if (!productStoreForWorkflowFamilies) {
        return [];
      }
      const state = await productStoreForWorkflowFamilies.getState();
      return state.workflows.flatMap(
        (workflow): WorkflowFamilyArtifactSource[] =>
          workflow.artifactPath &&
          (workflow.status === "Generated" || workflow.status === "Installable")
            ? [
                {
                  artifactPath: workflow.artifactPath,
                  updatedAt: workflow.updatedAt,
                },
              ]
            : [],
      );
    },
  });
  logRuntimeStartup("created lab service");
  const cloudSession = createRuntimeCloudSession();
  const productStore = createProductStore({
    runtimeConfig: config,
    composioAdapter: createHostedComposioProviderAdapter({ cloudSession }),
  });
  productStoreForWorkflowFamilies = productStore;
  logRuntimeStartup("created product store");
  const app = createRuntimeHttpApp({
    service,
    productStore,
    cloudSession,
    config,
    errorReporter: input.errorReporter,
  });
  logRuntimeStartup("created runtime http app");

  logRuntimeStartup("starting express listen", config.apiPort);
  const server = await new Promise<ReturnType<express.Express["listen"]>>(
    (resolveListen, rejectListen) => {
      const listeningServer = app.listen(config.apiPort, "127.0.0.1");
      listeningServer.once("error", rejectListen);
      listeningServer.once("listening", () => {
        process.stdout.write(
          `runtime listening on http://127.0.0.1:${config.apiPort} (mode=${config.mode}, env=${config.codexEnvPath})\n`,
        );
        logRuntimeStartup("runtime listen resolved", config.apiPort);
        resolveListen(listeningServer);
      });
    },
  );

  return {
    app,
    config,
    service,
    productStore,
    close: () =>
      closeRuntimeServerResources({
        server,
        productStore,
        service,
      }),
  };
}

/**
 * EN: Renders the local, product-branded destination shown after a cloud app authorization.
 * 中文: 渲染云端应用授权完成后显示的本地产品品牌页面。
 * @param input localized result state and provider-supplied toolkit label.
 * @returns standalone HTML response with no external resources.
 */
function renderProductConnectionCallbackPage(input: {
  language: "en" | "zh";
  successful: boolean;
  toolkitName: string;
}): string {
  const toolkitName = escapeHtml(input.toolkitName);
  const appInitial = escapeHtml(input.toolkitName.trim().slice(0, 1) || "A");
  const copy =
    input.language === "zh"
      ? input.successful
        ? {
            title: "连接成功",
            relation: `OysterWorkflow 已连接 ${toolkitName}`,
            note: "现在可以关闭此窗口。",
          }
        : {
            title: "连接未完成",
            relation: `OysterWorkflow 未能连接 ${toolkitName}`,
            note: "请返回应用后重试。",
          }
      : input.successful
        ? {
            title: "Successfully connected",
            relation: `OysterWorkflow to ${toolkitName}`,
            note: "You can close this window now.",
          }
        : {
            title: "Connection incomplete",
            relation: `OysterWorkflow could not connect to ${toolkitName}`,
            note: "Return to the app and try again.",
          };
  const statusClass = input.successful ? "success" : "failed";
  const statusSymbol = input.successful ? "✓" : "!";

  return `<!doctype html>
<html lang="${input.language}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${copy.title} | OysterWorkflow</title>
    <style>
      :root { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #102a2e; background: #f5f8f8; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 24px; background: radial-gradient(circle at 50% 22%, #e3f3f1, transparent 34%), #f5f8f8; }
      main { width: min(420px, 100%); border: 1px solid #d9e5e4; border-radius: 16px; padding: 42px 32px 34px; background: #fbfdfd; box-shadow: 0 24px 70px rgba(21, 62, 66, .12); text-align: center; }
      .marks { display: flex; align-items: center; justify-content: center; gap: 12px; }
      .mark { width: 48px; height: 48px; display: grid; place-items: center; border: 1px solid #d9e5e4; border-radius: 14px; background: #f8fbfb; color: #0b6f6c; font-size: 18px; font-weight: 800; }
      .status { width: 26px; height: 26px; display: grid; place-items: center; border-radius: 999px; color: #fff; font-size: 15px; font-weight: 900; }
      .status.success { background: #16835c; }
      .status.failed { background: #b84a45; }
      h1 { margin: 28px 0 0; font-size: 24px; line-height: 1.2; letter-spacing: -.02em; }
      h2 { margin: 7px 0 0; font-size: 19px; line-height: 1.35; }
      p { margin: 42px 0 0; padding-top: 24px; border-top: 1px solid #e7eeee; color: #6a7f82; font-size: 14px; }
    </style>
  </head>
  <body>
    <main>
      <div class="marks" aria-hidden="true">
        <span class="mark">O</span>
        <span class="status ${statusClass}">${statusSymbol}</span>
        <span class="mark">${appInitial.toUpperCase()}</span>
      </div>
      <h1>${copy.title}</h1>
      <h2>${copy.relation}</h2>
      <p>${copy.note}</p>
    </main>
  </body>
</html>`;
}

/**
 * EN: Reads one scalar Express query value without accepting arrays or objects.
 * 中文: 读取单个 Express 查询参数，并拒绝数组或对象值。
 * @param value unknown query value.
 * @returns trimmed text or `null`.
 */
function queryText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * EN: Escapes untrusted provider labels before embedding them into standalone HTML.
 * 中文: 在将不可信 provider 标签写入独立 HTML 前进行转义。
 * @param value raw text.
 * @returns HTML-safe text.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * EN: Restricts browser Runtime CORS access to local development origins.
 * Packaged renderers use the trusted Electron main-process proxy instead.
 * 中文：浏览器 CORS 仅允许本地开发源；打包后的渲染进程通过可信主进程代理访问。
 * @param origin raw request Origin header.
 * @returns allowed response origin or `null` when blocked.
 */
function resolveAllowedRuntimeCorsOrigin(origin: string): string | null {
  try {
    const parsedOrigin = new URL(origin);
    if (
      (parsedOrigin.protocol === "http:" ||
        parsedOrigin.protocol === "https:") &&
      isLoopbackOriginHost(parsedOrigin.hostname)
    ) {
      return parsedOrigin.origin;
    }
  } catch {
    return null;
  }

  return null;
}

function isPublicRuntimeRoute(req: express.Request): boolean {
  if (req.headers.origin !== undefined) {
    return false;
  }
  return (
    (req.method === "GET" && req.path === "/api/health") ||
    (req.method === "GET" &&
      req.path === "/api/product/integrations/composio/callback")
  );
}

function matchesRuntimeApiSecret(
  headerValue: string | string[] | undefined,
  expectedSecret: string,
): boolean {
  if (typeof headerValue !== "string") {
    return false;
  }
  const actual = Buffer.from(headerValue);
  const expected = Buffer.from(expectedSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function redactRuntimeArgv(argv: string[]): string[] {
  let redactNext = false;
  return argv.map((value) => {
    if (redactNext) {
      redactNext = false;
      return "[redacted]";
    }
    if (value === "--api-secret") {
      redactNext = true;
      return value;
    }
    return value.startsWith("--api-secret=")
      ? "--api-secret=[redacted]"
      : value;
  });
}

function redactRuntimeConfig(
  input: ResolveRuntimeConfigInput | RuntimeConfig,
): Record<string, unknown> {
  return {
    ...input,
    ...(typeof input.apiSecret === "string" ? { apiSecret: "[redacted]" } : {}),
  };
}

/**
 * EN: Limits browser-accessible Runtime origins to local loopback hosts used during dev.
 * @param hostname parsed origin hostname.
 * @returns whether the hostname is a loopback alias.
 */
function isLoopbackOriginHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

const runtimeEntryUrl = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;

logRuntimeStartup("runtime module loaded", {
  pid: process.pid,
  runtimeEntryUrl,
  importMetaUrl: import.meta.url,
});

if (runtimeEntryUrl === import.meta.url) {
  void runRuntimeEntrypoint();
}

async function runRuntimeEntrypoint(): Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  const handlePromise = startRuntimeHttpServer();
  const requestShutdown = (signal: NodeJS.Signals) => {
    shutdownPromise ??= (async () => {
      logRuntimeStartup("runtime shutdown signal received", signal);
      const hardExitTimer = setTimeout(() => {
        logRuntimeStartup("runtime graceful shutdown deadline reached", signal);
        process.exit(1);
      }, 10_000);
      try {
        const handle = await handlePromise;
        await handle.close();
        process.exitCode = 0;
      } catch (error) {
        const message =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        logRuntimeStartup("runtime graceful shutdown failed", message);
        process.stderr.write(`[runtime] failed to shut down: ${message}\n`);
        process.exitCode = 1;
      } finally {
        clearTimeout(hardExitTimer);
      }
    })();
  };
  const handleSigint = () => requestShutdown("SIGINT");
  const handleSigterm = () => requestShutdown("SIGTERM");
  process.once("SIGINT", handleSigint);
  process.once("SIGTERM", handleSigterm);

  try {
    await handlePromise;
  } catch (error) {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    logRuntimeStartup("runtime entrypoint failed", message);
    process.stderr.write(`[runtime] failed to start: ${message}\n`);
    process.exitCode = 1;
  }
}

function logRuntimeStartup(message: string, details?: unknown): void {
  try {
    mkdirSync(dirname(RUNTIME_STARTUP_LOG_PATH), { recursive: true });
    const suffix =
      details === undefined
        ? ""
        : ` ${typeof details === "string" ? details : JSON.stringify(details)}`;
    appendFileSync(
      RUNTIME_STARTUP_LOG_PATH,
      `[${new Date().toISOString()} pid=${process.pid}] ${message}${suffix}\n`,
      "utf8",
    );
  } catch {
    // EN: Runtime startup logging must never interfere with the startup path.
  }
}

function resolveRuntimeLogRoot(): string {
  if (process.platform === "darwin") {
    return resolve(homedir(), "Library", "Logs", "OysterWorkflow");
  }
  if (process.platform === "win32") {
    return resolve(
      process.env.LOCALAPPDATA ??
        process.env.APPDATA ??
        resolve(homedir(), "AppData", "Local"),
      "OysterWorkflow",
      "Logs",
    );
  }
  return resolve(
    process.env.XDG_STATE_HOME ?? resolve(homedir(), ".local", "state"),
    "oysterworkflow",
    "logs",
  );
}

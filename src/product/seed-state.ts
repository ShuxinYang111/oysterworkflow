import type { ProductSeedMode } from "../runtime/config.js";
import type {
  ProductApprovalPolicy,
  ProductDevice,
  ProductInstalledWorkflow,
  ProductInstalledWorkflowStatus,
  ProductRun,
  ProductState,
  ProductWorker,
  ProductWorkflow,
} from "./contracts.js";
import {
  defaultHermesSkillName,
  defaultHermesSkillPath,
  managedHermesProfileReference,
} from "./hermes-references.js";
import { defaultHermesProviderHealth } from "./hermes-provider-status.js";
import { defaultProductWorkerChannelConfig } from "./channels.js";
import { defaultCapabilityProviders } from "./capabilities.js";
import { START_WORKER_PREPARATION_MESSAGE } from "./worker-presentation.js";

export const SALES_LIBRARY_ENTRIES = [
  {
    name: "Prepare renewal risk note",
    description:
      "Collect risk evidence from email, CRM, and notes before the next account review",
    apps: ["Microsoft Outlook", "Salesforce", "Slack"],
  },
  {
    name: "Create stakeholder map from thread",
    description:
      "Turn scattered customer context into a short internal operating note",
    apps: ["Chrome", "LinkedIn", "Google Docs"],
  },
  {
    name: "Summarize procurement blockers",
    description:
      "Identify unanswered blockers and prepare a clean owner handoff",
    apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word"],
  },
  {
    name: "Refresh champion briefing",
    description:
      "Keep the opportunity record current without inventing missing facts",
    apps: ["HubSpot", "Slack", "Google Sheets"],
  },
  {
    name: "Draft pilot success recap",
    description:
      "Gather pilot evidence and prepare a concise recap for the account team",
    apps: ["Microsoft Outlook", "Salesforce", "Google Docs"],
  },
  {
    name: "Log competitor mention",
    description:
      "Capture competitor signals from customer messages and update CRM context",
    apps: ["Chrome", "LinkedIn", "Salesforce"],
  },
  {
    name: "Route security questionnaire",
    description:
      "Collect security questionnaire context and send the right owner handoff",
    apps: ["Microsoft Outlook", "Google Drive", "Slack"],
  },
  {
    name: "Prepare pricing context",
    description:
      "Compile account size, use case, and buying signals before pricing review",
    apps: ["HubSpot", "Google Sheets", "Slack"],
  },
  {
    name: "Collect legal redlines",
    description:
      "Find contract redlines, summarize asks, and prepare a legal handoff",
    apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word"],
  },
  {
    name: "Update mutual action plan",
    description:
      "Convert recent customer replies into owners, dates, and next milestones",
    apps: ["Google Sheets", "Salesforce", "Slack"],
  },
  {
    name: "Research new buying committee member",
    description:
      "Verify a new stakeholder and summarize role, influence, and likely concerns",
    apps: ["Chrome", "LinkedIn", "Google Docs"],
  },
  {
    name: "Prepare technical discovery agenda",
    description:
      "Turn customer requirements into a focused agenda for engineering discovery",
    apps: ["Microsoft Outlook", "Google Docs", "Slack"],
  },
  {
    name: "Extract executive sponsor update",
    description:
      "Summarize deal progress and risks into a short executive update",
    apps: ["Salesforce", "Google Docs", "Slack"],
  },
  {
    name: "Draft post-demo recap",
    description:
      "Collect demo notes, open questions, and next steps into a customer-ready draft",
    apps: ["Microsoft Outlook", "Google Docs", "Salesforce"],
  },
  {
    name: "Check implementation capacity",
    description:
      "Review requested timeline and route capacity questions before promising dates",
    apps: ["Slack", "Google Sheets", "Salesforce"],
  },
  {
    name: "Prepare renewal expansion notes",
    description:
      "Find expansion signals and package them for the renewal conversation",
    apps: ["Salesforce", "Microsoft Outlook", "Google Docs"],
  },
  {
    name: "Summarize lost-deal feedback",
    description:
      "Extract loss reasons from email and CRM notes for pipeline learning",
    apps: ["Salesforce", "Microsoft Outlook", "Google Sheets"],
  },
  {
    name: "Create partner referral brief",
    description:
      "Package account context and referral rationale for a partner handoff",
    apps: ["Microsoft Outlook", "Google Docs", "Slack"],
  },
  {
    name: "Check customer hiring signals",
    description:
      "Review company hiring pages and LinkedIn signals before outreach",
    apps: ["Chrome", "LinkedIn", "Google Docs"],
  },
  {
    name: "Prepare board-slide account snapshot",
    description:
      "Turn CRM and email evidence into a concise account snapshot for leadership",
    apps: ["Salesforce", "Google Slides", "Google Docs"],
  },
  {
    name: "Route integration request",
    description:
      "Collect integration details and route feasibility questions to engineering",
    apps: ["Microsoft Outlook", "Slack", "Google Drive"],
  },
  {
    name: "Draft procurement timeline reply",
    description:
      "Prepare a careful customer reply around procurement timing and owners",
    apps: ["Microsoft Outlook", "Salesforce", "Google Docs"],
  },
  {
    name: "Build account research packet",
    description:
      "Collect company, funding, hiring, and stakeholder context before first call",
    apps: ["Chrome", "LinkedIn", "Google Docs"],
  },
  {
    name: "Prepare champion enablement email",
    description:
      "Draft a concise internal-forwardable note for the customer champion",
    apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word"],
  },
  {
    name: "Audit stale next steps",
    description:
      "Find opportunities with stale next steps and prepare owner follow-up",
    apps: ["Salesforce", "Microsoft Outlook", "Slack"],
  },
  {
    name: "Summarize customer success risks",
    description:
      "Package early implementation risks and success criteria for CS review",
    apps: ["Salesforce", "Google Docs", "Slack"],
  },
] satisfies Array<{
  name: string;
  description: string;
  apps: string[];
}>;

/**
 * EN: Builds the initial product state used when no persisted state exists.
 * 中文: 生产模式保持用户数据为空；演示数据仅供显式 demo/fixture 使用。
 * @param mode whether to create an empty production state or demo fixtures.
 * @returns seeded product state.
 */
export function seedProductState(
  mode: ProductSeedMode = "empty",
): ProductState {
  const now = new Date().toISOString();
  const demo = mode === "demo";
  const state: ProductState = {
    schemaVersion: 1,
    account: {
      id: demo ? "acct-alex" : "acct-local",
      name: demo ? "Alex Yang" : "Local User",
      email: demo ? "alexyang@oysterworkflow.com" : "",
      workspaceId: demo ? "workspace-oyster-demo" : "workspace-local",
      signedInLabel: "OysterWorkflow",
      cloudProvider: "supabase",
      cloudUserId: null,
      cloudSyncRevision: -1,
      setupCompleted: true,
      updatedAt: now,
    },
    workspace: {
      id: demo ? "workspace-oyster-demo" : "workspace-local",
      name: "OysterWorkflow",
      mode: "local",
    },
    permissionSnapshot: null,
    devices: demo ? seedDevices() : [],
    workers: demo ? seedWorkers() : [],
    channelConnections: [],
    channelSetups: [],
    channelBindings: [],
    workflows: demo ? seedProductWorkflows(now) : [],
    captureSessions: [],
    artifacts: [],
    installedWorkflows: demo ? seedInstalledWorkflows(now) : [],
    runs: demo ? seedRuns(now) : [],
    runEvents: [],
    commands: [],
    approvalPolicies: [],
    workflowTombstones: [],
    pendingCloudUpserts: [],
    pendingCloudDeletes: [],
    hermes: {
      command: "hermes",
      available: false,
      model: null,
      provider: null,
      providerHealth: defaultHermesProviderHealth(),
      enabledToolsets: [],
      missingComputerUseToolsets: [],
      computerUseReady: false,
      computerUseSummary: null,
      configSource: null,
      configPath: null,
      runtimeHome: null,
      lastCheckedAt: null,
      lastProbeSessionId: null,
      lastError: null,
    },
    capabilityProviders: defaultCapabilityProviders(),
    updatedAt: now,
  };
  return {
    ...state,
    approvalPolicies: demo ? normalizeSeedApprovalPolicies(state, []) : [],
  };
}

/**
 * EN: Builds seeded desktop devices.
 * @returns product device list.
 */
export function seedDevices(): ProductDevice[] {
  return [
    {
      id: "alex-mbp",
      name: "Alex's MacBook Pro",
      status: "Available now",
      owner: "Alex Yang",
      assignedWorkerId: "sales",
      heartbeat: "Last check 9 sec ago",
      location: "Local desktop runtime",
      runtimeVersion: "AI worker runtime v0.11.0",
      queue: ["Inbound inquiry queue", "Draft logging review"],
    },
    {
      id: "studio-mini",
      name: "Studio Mac mini",
      status: "Idle today",
      owner: "Product workspace",
      assignedWorkerId: "product",
      heartbeat: "Last check 18 sec ago",
      location: "Office lab",
      runtimeVersion: "AI worker runtime v0.11.0",
      queue: ["Product feedback digest"],
    },
  ];
}

/**
 * EN: Builds seeded product workers.
 * @returns product worker list.
 */
export function seedWorkers(): ProductWorker[] {
  return [
    productWorker({
      id: "marketing",
      name: "Marketing Worker",
      initials: "MK",
      avatarKey: "marketing",
      status: "Needs device",
      tone: "warning",
      deviceId: null,
      heartbeat: "No computer assigned",
      activities: [
        "Device assignment needed",
        "Training materials prepared",
        "No active task",
      ],
    }),
    productWorker({
      id: "product",
      name: "Product Worker",
      initials: "PD",
      avatarKey: "product",
      status: "No active task",
      tone: "idle",
      deviceId: "studio-mini",
      heartbeat: START_WORKER_PREPARATION_MESSAGE,
      activities: [
        "Device capability check passed",
        "No active task",
        "Training can start",
      ],
    }),
    productWorker({
      id: "finance",
      name: "Finance Worker",
      initials: "FN",
      avatarKey: "finance",
      status: "Setup needed",
      tone: "warning",
      deviceId: null,
      heartbeat: "Permissions missing",
      activities: [
        "Permissions missing",
        "Device assignment needed",
        "Approval policy ready",
      ],
    }),
    productWorker({
      id: "sales",
      name: "Sales AI Worker",
      initials: "SA",
      avatarKey: "sales",
      status: "No active task",
      tone: "idle",
      deviceId: "alex-mbp",
      heartbeat: START_WORKER_PREPARATION_MESSAGE,
      activities: [
        "AI worker configured",
        "MacBook assigned",
        "Message channel can be connected when needed",
        "No active workflow running",
      ],
    }),
  ];
}

/**
 * EN: Builds seeded demo workflows.
 * @param now timestamp used for created/updated fields.
 * @returns product workflow list.
 */
export function seedProductWorkflows(now: string): ProductWorkflow[] {
  return [
    productWorkflow({
      id: "inbound",
      title: "Handle inbound opportunity",
      description:
        "Qualify customer emails, check feasibility, and prepare follow-up",
      status: "Installable",
      confidence: 94,
      apps: ["Microsoft Outlook", "Gmail", "Slack", "Salesforce"],
      uiEvents: 162,
      ocrObservations: 418,
      voiceNotes: 5,
      duration: "45:18",
      decisionPoints: 12,
      detectedAt: "Detected on May 21, 2025 at 10:42 AM",
      now,
    }),
    productWorkflow({
      id: "outlook-product-inquiry",
      title: "Qualify Outlook product inquiry and draft sales reply",
      description:
        "Verify the company, check fit, consult cases, and save an Outlook draft",
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
      ocrObservations: 70,
      voiceNotes: 12,
      duration: "6:36",
      decisionPoints: 5,
      detectedAt: "Generated on Jun 18, 2026 at 9:21 PM",
      now,
    }),
    productWorkflow({
      id: "tracker",
      title: "Prepare follow-up tracker",
      description: "Create tracker, priority, and reminder",
      status: "Needs review",
      confidence: 82,
      apps: ["Salesforce", "Google Sheets"],
      uiEvents: 86,
      ocrObservations: 214,
      voiceNotes: 2,
      duration: "18:09",
      decisionPoints: 5,
      detectedAt: "Detected on May 21, 2025 at 10:44 AM",
      now,
    }),
    productWorkflow({
      id: "feasibility",
      title: "Route feasibility request",
      description: "Ask engineering before commitment",
      status: "Installable",
      confidence: 89,
      apps: ["Slack", "Google Drive"],
      uiEvents: 104,
      ocrObservations: 268,
      voiceNotes: 3,
      duration: "24:37",
      decisionPoints: 7,
      detectedAt: "Detected on May 21, 2025 at 10:38 AM",
      now,
    }),
    productWorkflow({
      id: "reply",
      title: "Draft client reply safely",
      description: "Needs more examples",
      status: "Needs context",
      confidence: 68,
      apps: ["Gmail", "Microsoft Outlook"],
      uiEvents: 58,
      ocrObservations: 133,
      voiceNotes: 1,
      duration: "12:45",
      decisionPoints: 4,
      detectedAt: "Detected on May 21, 2025 at 10:46 AM",
      now,
    }),
  ];
}

function productWorker(input: {
  id: ProductWorker["id"];
  name: string;
  initials: string;
  avatarKey: ProductWorker["avatarKey"];
  status: ProductWorker["status"];
  tone: ProductWorker["tone"];
  deviceId: string | null;
  heartbeat: string;
  activities: string[];
}): ProductWorker {
  const channel = defaultProductWorkerChannelConfig("none");
  return {
    ...input,
    description: "General purpose desktop worker",
    selectedInstalledWorkflowId: null,
    config: {
      identityScope: `${input.name} follows Alex's operating style and only acts inside the assigned workspace.`,
      runtimeProfile: "Local AI worker runtime",
      toolAccess: [
        "browser control",
        "desktop automation",
        "mail",
        "chat",
        "crm",
      ],
      memoryContext: "Local workspace memory and installed workflow context",
      approvalPolicy: "allow_all",
      heartbeatPolicy:
        "Check runtime health while idle and recover failed steps with a logged diagnosis.",
      hermesAgentReference: managedHermesProfileReference(input.id, input.name),
      channel,
    },
  };
}

function productWorkflow(input: {
  id: string;
  title: string;
  description: string;
  status: ProductWorkflow["status"];
  confidence: number | null;
  apps: string[];
  uiEvents: number;
  ocrObservations: number;
  voiceNotes: number;
  duration: string;
  decisionPoints: number;
  detectedAt: string;
  now: string;
}): ProductWorkflow {
  return {
    id: input.id,
    title: input.title,
    description: input.description,
    status: input.status,
    sourceType: "demo",
    confidence: input.confidence,
    apps: input.apps,
    stats: {
      uiEvents: input.uiEvents,
      ocrObservations: input.ocrObservations,
      voiceNotes: input.voiceNotes,
      duration: input.duration,
      decisionPoints: input.decisionPoints,
    },
    detectedAt: input.detectedAt,
    artifactPath: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function seedInstalledWorkflows(now: string): ProductInstalledWorkflow[] {
  const primary = [
    installed({
      id: "installed-meeting-actions",
      name: "Extract action items from customer meeting",
      description:
        "Turn call notes into owners, deadlines, CRM tasks, and follow-up reminders",
      apps: ["Google Docs", "Slack", "Salesforce", "Microsoft Outlook"],
      runs: 34,
      successes: 33,
    }),
    installed({
      id: "installed-unanswered-questions",
      name: "Track unanswered customer questions",
      description:
        "Find open customer questions across email and chat, then prepare owner follow-up",
      apps: ["Microsoft Outlook", "Slack", "Google Sheets", "Salesforce"],
      runs: 27,
      successes: 24,
      updateAvailable: true,
    }),
    installed({
      id: "installed-nda-handoff",
      name: "Prepare NDA handoff",
      description:
        "Collect account context, contact details, scope, and legal notes before NDA routing",
      apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word", "Slack"],
      runs: 19,
      successes: 18,
    }),
    installed({
      id: "installed-funding-news",
      name: "Check funding and company news",
      description:
        "Research recent funding, hiring, product launches, and executive signals before outreach",
      apps: ["Chrome", "LinkedIn", "Google Docs"],
      runs: 22,
      successes: 20,
    }),
    installed({
      id: "installed-deal-stage-email",
      name: "Update deal stage from email thread",
      description:
        "Read customer replies, infer stage changes, and update CRM next steps",
      apps: ["Microsoft Outlook", "Salesforce", "HubSpot"],
      runs: 31,
      successes: 29,
    }),
    installed({
      id: "installed-onboarding-handoff",
      name: "Create onboarding handoff",
      description:
        "Package closed-won context, implementation notes, risks, and success criteria for CS",
      status: "Paused",
      apps: ["Salesforce", "Google Docs", "Slack", "Google Drive"],
      runs: 14,
      successes: 13,
    }),
  ];

  const extra = SALES_LIBRARY_ENTRIES.map((entry, index) =>
    installed({
      id: `installed-sales-library-${index + 1}`,
      name: entry.name,
      description: entry.description,
      apps: entry.apps,
      runs: 0,
      successes: 0,
    }),
  );

  return [...primary, ...extra].map((workflow, index) => ({
    ...workflow,
    installedAt: new Date(Date.parse(now) - index * 86_400_000).toISOString(),
  }));
}

function installed(input: {
  id: string;
  name: string;
  description: string;
  apps: string[];
  runs: number;
  successes: number;
  status?: ProductInstalledWorkflowStatus;
  updateAvailable?: boolean;
}): ProductInstalledWorkflow {
  return {
    id: input.id,
    workerId: "sales",
    workflowId: input.id.replace("installed-", "workflow-"),
    workflowTitle: input.name,
    description: input.description,
    status: input.status ?? "Enabled",
    apps: input.apps,
    installedAt: new Date().toISOString(),
    deployTargetDeviceId: "alex-mbp",
    approvalPolicy: "allow_all",
    hermesSkillReference: `hermes-skill:${defaultHermesSkillName(input.name)}`,
    hermesInstallReference: `hermes-install:${managedHermesProfileReference(
      "sales",
      "Sales AI Worker",
    )}:${defaultHermesSkillName(input.name)}`,
    hermesSkillName: defaultHermesSkillName(input.name),
    hermesSkillPath: defaultHermesSkillPath(input.name),
    sourceSkillPath: null,
    sourceWorkflowRevisionId: null,
    baselineRuns: input.runs,
    baselineSuccesses: input.successes,
    baselineLastRun: input.runs > 0 ? baselineLastRun(input.id) : "Not run yet",
    updateAvailable: input.updateAvailable,
  };
}

function baselineLastRun(id: string): string {
  const labels: Record<string, string> = {
    "installed-meeting-actions": "18 min ago",
    "installed-unanswered-questions": "43 min ago",
    "installed-nda-handoff": "Yesterday",
    "installed-funding-news": "Yesterday",
    "installed-deal-stage-email": "Jun 20",
    "installed-onboarding-handoff": "Jun 17",
  };
  return labels[id] ?? "Earlier this week";
}

function seedRuns(now: string): ProductRun[] {
  return [
    historicalRun(
      "installed-meeting-actions",
      "Extract action items from customer meeting",
      18,
      "succeeded",
      now,
    ),
    historicalRun(
      "installed-unanswered-questions",
      "Track unanswered customer questions",
      43,
      "succeeded",
      now,
    ),
    historicalRun(
      "installed-onboarding-handoff",
      "Create onboarding handoff",
      240,
      "paused",
      now,
    ),
  ];
}

function historicalRun(
  installedWorkflowId: string,
  workflowTitle: string,
  minutesAgo: number,
  status: ProductRun["status"],
  now: string,
): ProductRun {
  const endedAt = new Date(Date.parse(now) - minutesAgo * 60_000).toISOString();
  return {
    id: `run-${installedWorkflowId}-${minutesAgo}`,
    workerId: "sales",
    installedWorkflowId,
    workflowTitle,
    status,
    command: null,
    startedAt: new Date(Date.parse(endedAt) - 90_000).toISOString(),
    endedAt,
    hermesSessionId: null,
    errorMessage: null,
  };
}

function normalizeSeedApprovalPolicies(
  state: ProductState,
  existingPolicies: ProductApprovalPolicy[],
): ProductApprovalPolicy[] {
  const now = new Date().toISOString();
  const policies = new Map<string, ProductApprovalPolicy>();
  existingPolicies.forEach((policy) => policies.set(policy.id, policy));
  state.workers.forEach((worker) => {
    const id = `approval-policy-worker-${worker.id}`;
    if (!policies.has(id)) {
      policies.set(id, {
        id,
        scopeType: "worker",
        scopeId: worker.id,
        mode: "allow_all",
        description:
          "AI worker can proceed under allow_all; progress appears in run events.",
        updatedAt: now,
      });
    }
  });
  state.installedWorkflows.forEach((workflow) => {
    const id = `approval-policy-installed-${workflow.id}`;
    if (!policies.has(id)) {
      policies.set(id, {
        id,
        scopeType: "installed_workflow",
        scopeId: workflow.id,
        mode: "allow_all",
        description:
          "Installed workflow can proceed under allow_all; progress appears in run events.",
        updatedAt: now,
      });
    }
  });
  return Array.from(policies.values());
}

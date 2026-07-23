import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import alexAvatarUrl from "./assets/alex-avatar.png";
import financeWorkerAvatarUrl from "./assets/worker-avatars/finance-worker.png";
import marketingWorkerAvatarUrl from "./assets/worker-avatars/marketing-worker.png";
import productWorkerAvatarUrl from "./assets/worker-avatars/product-worker.png";
import salesWorkerAvatarUrl from "./assets/worker-avatars/sales-worker.png";
import oysterIconUrl from "../../desktop/assets/app-icon.png";
import { resolveWorkflowApp, type AppIdentity } from "./app-icon-registry";
import {
  DEFAULT_APP_LANGUAGE,
  normalizeAppLanguage,
  type AppLanguage,
} from "./app-language";
import {
  formatChromeCapabilityDetail,
  isChromeWindowBindingFailure,
} from "./chrome-capability-presentation";
import { renderChannelQrDataUrl } from "./channel-qr";
import { WorkflowGraphModal, WorkflowGraphPanel } from "./workflow-graph-view";
import { WorkflowMergeDecisionDialog } from "./workflow-merge-decision-dialog";
import { WorkflowVersionHistoryDialog } from "./workflow-version-history-dialog";
import {
  discoverRuntimeWorkflow,
  extractRuntimeWorkflowLogic,
  fetchActiveRecorderSession,
  fetchRuntimeSession,
  fetchRuntimeSessions,
  selectWorkflowCandidate,
  startRuntimeTraining,
  stopRuntimeTraining,
  workflowFromGeneratedSession,
  workflowsFromRuntimeSessions,
  type DemoWorkflowAsset as WorkflowAsset,
  type DemoWorkflowStats as WorkflowStats,
  type DemoWorkflowStep as WorkflowStep,
  type DemoWorkflowSummary as WorkflowSummary,
  type GenerateWorkflowProgress,
} from "./demo-runtime";
import {
  detectLlmModelPreset,
  detectLlmProviderPreset,
  normalizeLlmClientProfileFormValue,
  normalizeLlmReasoningEffort,
  parseResponseReadTimeoutMs,
  resolveLlmClientProfileValue,
  resolveLlmModelValue,
  resolveLlmProviderValue,
  type LlmCallProfileFormState,
  type LlmFormState,
} from "./llm-settings";
import {
  activeProductRunForWorker,
  approveProductWorkerChannelPairing,
  assignProductDevice,
  beginProductWorkerChannelSetup,
  bindProductWorkerChannel,
  cancelProductWorkerChannelSetup,
  checkProductCapabilityProvider,
  configureProductWorkerChannel,
  createProductWorker,
  deleteProductInstalledWorkflow,
  deleteProductWorker,
  deleteProductWorkflow,
  disconnectProductWorkerChannel,
  applyProductWorkflowMergeProposal,
  fetchPendingProductWorkflowMerges,
  fetchProductState,
  installProductWorkflow,
  keepProductWorkflowAsNew,
  installedProductWorkflowsForWorker,
  listProductWorkerChannelPeers,
  productAgentConversationEventsForWorker,
  productWorkerAvatarUrl as productWorkerAvatarAsset,
  productWorkerDeviceLabel,
  refreshProductHermes,
  readProductWorkerChannelSetup,
  runProductInstalledWorkflow,
  sendProductWorkerCommand,
  setupProductAccount,
  startProductWorker,
  stopProductWorker,
  testProductWorkerChannel,
  updateProductInstalledWorkflowStatus,
  updateProductWorkerConfig,
  type ProductStateSnapshot,
} from "./product-runtime";
import {
  checkRuntimeRecorderPermissions,
  fetchRuntimeLlmConfig,
  fetchRuntimeLlmModels,
  updateRuntimeLlmConfig,
} from "./settings-runtime";
import {
  SettingsModal,
  StartupLlmSetupModal,
  StartupPermissionGate,
  formatRecorderLanguageSummary,
  type RecorderLanguageSlotValue,
  type SettingsSection,
} from "./settings-ui";
import { handleScrollableRegionKeyDown } from "./scroll-region";
import { applyUiLocalization } from "./ui-localization";
import {
  buildProductSlackAppManifest,
  PRODUCT_SLACK_APP_CREATOR_URL,
  validateProductWorkerChannelCredentials,
} from "../../src/product/channels.js";
import { useCloudAuth } from "./cloud-auth";
import { useProductStateController } from "./product-state-controller";
import { useRecorderPermissionsController } from "./recorder-permissions-controller";
import { startSettledPolling, useSettledPolling } from "./settled-polling";
import { useStartupRuntimePreparationController } from "./startup-runtime-controller";
import { useDesktopUpdateController } from "./desktop-update-controller";
import { ClawHubPublishPanel } from "./clawhub-publish";
import {
  resolveAccountDisplayIdentity,
  type AccountDisplayIdentity,
} from "./account-identity";
import {
  getRuntimeBridgeInfo,
  hasDesktopMicrophoneRequestBridge,
  hasDesktopPermissionRequestBridge,
  hasDesktopQuitAndReopenBridge,
  openExternalUrl,
  quitAndReopenDesktopApp,
  requestDesktopMicrophoneAccess,
  requestDesktopRecorderPermission,
} from "./runtime-env";
import {
  DEFAULT_RECORDING_ENABLE_AUDIO,
  DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY,
  LAB_SCREENPIPE_LANGUAGES,
  LAB_LLM_CALL_PROFILE_KEYS,
  LAB_WORKFLOW_GENERATION_STAGES,
  type LabLlmCallProfileKey,
  type LabLlmConfig,
  type LabLlmConfigUpdateInput,
  type LabLlmModelsInput,
  type LabScreenpipeLanguage,
  type LabSession,
  type LabWorkflowGenerationProgress,
  type LabWorkflowGenerationStage,
  type RecorderPermissionKind,
  type WorkflowCandidate,
} from "../../src/lab-api/api-contracts.js";
import {
  compareWorkflowCandidatePriority,
  selectPreferredWorkflowCandidate,
} from "../../src/lab-api/workflow-selection.js";
import type {
  ProductCapabilityProvider,
  ProductCapabilityProviderId,
  ProductCapabilityProviderStatus,
  ProductChannelConnection,
  ProductChannelPeer,
  ProductChannelSetup,
  ProductDevice,
  ProductAccount,
  ProductHermesStatus,
  ProductInstalledWorkflow,
  ProductPendingWorkflowMerge,
  ProductRun,
  ProductRunEvent,
  ProductWorker,
  ProductWorkerChannelAccessMode,
  ProductWorkerChannelConfig,
  ProductWorkerChannelInput,
  ProductWorkerChannelPlatform,
  ProductWorkerConfigInput,
  ProductWorkflow,
} from "../../src/product/contracts.js";
import {
  isProductSystemAgentEvent,
  selectProductAgentConversationEvents,
} from "../../src/product/agent-conversation.js";
import {
  productizeWorkerFacingText,
  START_WORKER_PREPARATION_MESSAGE,
} from "../../src/product/worker-presentation.js";

type PageId = "workers" | "workflows" | "devices";
type WorkerDetailTab = "agent" | "installed" | "config" | "activity";
type AccountUtilityPanel = "notifications" | "help";
type WorkerStatus =
  | "Available"
  | "Needs device"
  | "Setup needed"
  | "No active task"
  | "Waiting for user"
  | "Blocked"
  | "Working"
  | "Training";
type Tone = "ready" | "warning" | "idle" | "working" | "danger";
type IconName =
  | "activity"
  | "archive"
  | "arrowRight"
  | "bell"
  | "briefcase"
  | "chat"
  | "check"
  | "chevron"
  | "clock"
  | "close"
  | "cube"
  | "device"
  | "download"
  | "expand"
  | "filter"
  | "gear"
  | "help"
  | "heartbeat"
  | "home"
  | "mail"
  | "megaphone"
  | "more"
  | "network"
  | "pause"
  | "play"
  | "power"
  | "plus"
  | "shield"
  | "stop"
  | "target"
  | "trash"
  | "upload"
  | "user"
  | "voice";

interface Worker {
  id: string;
  name: string;
  initials: string;
  description: string;
  status: WorkerStatus;
  tone: Tone;
  icon: IconName;
  avatarUrl: string;
  device: string;
  selectedInstalledWorkflowId: string | null;
  heartbeat: string;
  activities: string[];
}

interface AccountNotification {
  id: string;
  title: string;
  body: string;
  tone: Tone;
  meta: string;
}

type InstalledWorkflowStatus = "Enabled" | "Paused";
type InstalledWorkflowStatusFilter = "All" | InstalledWorkflowStatus;
type WorkflowStatusFilter = "All" | string;

interface InstalledWorkflow {
  id: string;
  workerId: string;
  name: string;
  description: string;
  status: InstalledWorkflowStatus;
  apps: string[];
  runs: number;
  successes: number;
  lastRun: string;
  device: string;
  updateAvailable?: boolean;
}

interface DeployedWorkflow {
  workerId: string;
  workflowId: string;
  workflowTitle: string;
  description: string;
  apps: string[];
}

interface WorkerDraftInput {
  name: string;
  description: string;
  channel: ProductWorkerChannelInput;
  sourceText: string;
}

interface WorkerChannelOption {
  platform: ProductWorkerChannelPlatform;
  label: string;
  summary: string;
  iconUrl: string | null;
  setupMethod: "none" | "token" | "qr";
}

interface WorkerChannelCredentialField {
  key: string;
  label: string;
  secret: boolean;
}

interface WorkflowRunEvent {
  id: string;
  workflowName: string;
  status:
    | "Completed"
    | "Paused"
    | "Running"
    | "Waiting for user"
    | "Blocked"
    | "Failed";
  detail: string;
  tone: Tone;
}

interface ActivityTimelineItem {
  id: string;
  label: string;
  detail: string;
  tone: Tone;
  timestamp: string | null;
}

interface AgentWorkflowStage {
  status: string;
  body: string;
  delayMs: number;
}

interface Device {
  id: string;
  name: string;
  status: "Available now" | "Idle today" | "Needs attention";
  owner: string;
  assignedWorker: string;
  heartbeat: string;
  location: string;
}

const workers: Worker[] = [
  {
    id: "marketing",
    name: "Marketing Worker",
    initials: "MK",
    description: "General purpose desktop worker",
    status: "Needs device",
    tone: "warning",
    icon: "megaphone",
    avatarUrl: marketingWorkerAvatarUrl,
    device: "Unassigned",
    selectedInstalledWorkflowId: null,
    heartbeat: "No computer assigned",
    activities: [
      "Device assignment needed",
      "Training materials prepared",
      "No active task",
    ],
  },
  {
    id: "product",
    name: "Product Worker",
    initials: "PD",
    description: "General purpose desktop worker",
    status: "No active task",
    tone: "idle",
    icon: "cube",
    avatarUrl: productWorkerAvatarUrl,
    device: "Studio Mac mini",
    selectedInstalledWorkflowId: null,
    heartbeat: START_WORKER_PREPARATION_MESSAGE,
    activities: [
      "Device capability check passed",
      "No active task",
      "Training can start",
    ],
  },
  {
    id: "finance",
    name: "Finance Worker",
    initials: "FN",
    description: "General purpose desktop worker",
    status: "Setup needed",
    tone: "warning",
    icon: "archive",
    avatarUrl: financeWorkerAvatarUrl,
    device: "Unassigned",
    selectedInstalledWorkflowId: null,
    heartbeat: "Permissions missing",
    activities: [
      "Permissions missing",
      "Device assignment needed",
      "Approval policy ready",
    ],
  },
  {
    id: "sales",
    name: "Sales AI Worker",
    initials: "SA",
    description: "General purpose desktop worker",
    status: "No active task",
    tone: "idle",
    icon: "briefcase",
    avatarUrl: salesWorkerAvatarUrl,
    device: "Alex's MacBook Pro",
    selectedInstalledWorkflowId: null,
    heartbeat: START_WORKER_PREPARATION_MESSAGE,
    activities: [
      "Training check complete",
      "MacBook assigned",
      "WeChat channel configured",
      "No active workflow running",
    ],
  },
];

const INSTALLED_WORKFLOW_PAGE_SIZE = 6;
const WORKFLOW_LIST_PAGE_SIZE = 6;

const salesLibraryCatalogEntries = [
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
] satisfies Array<{ name: string; description: string; apps: string[] }>;

const installedWorkflowCatalog: InstalledWorkflow[] = [
  {
    id: "installed-meeting-actions",
    workerId: "sales",
    name: "Extract action items from customer meeting",
    description:
      "Turn call notes into owners, deadlines, CRM tasks, and follow-up reminders",
    status: "Enabled",
    apps: ["Google Docs", "Slack", "Salesforce", "Microsoft Outlook"],
    runs: 34,
    successes: 33,
    lastRun: "18 min ago",
    device: "Alex's MacBook Pro",
  },
  {
    id: "installed-unanswered-questions",
    workerId: "sales",
    name: "Track unanswered customer questions",
    description:
      "Find open customer questions across email and chat, then prepare owner follow-up",
    status: "Enabled",
    apps: ["Microsoft Outlook", "Slack", "Google Sheets", "Salesforce"],
    runs: 27,
    successes: 24,
    lastRun: "43 min ago",
    device: "Alex's MacBook Pro",
    updateAvailable: true,
  },
  {
    id: "installed-nda-handoff",
    workerId: "sales",
    name: "Prepare NDA handoff",
    description:
      "Collect account context, contact details, scope, and legal notes before NDA routing",
    status: "Enabled",
    apps: ["Microsoft Outlook", "Google Drive", "Microsoft Word", "Slack"],
    runs: 19,
    successes: 18,
    lastRun: "Yesterday",
    device: "Alex's MacBook Pro",
  },
  {
    id: "installed-funding-news",
    workerId: "sales",
    name: "Check funding and company news",
    description:
      "Research recent funding, hiring, product launches, and executive signals before outreach",
    status: "Enabled",
    apps: ["Chrome", "LinkedIn", "Google Docs"],
    runs: 22,
    successes: 20,
    lastRun: "Yesterday",
    device: "Alex's MacBook Pro",
  },
  {
    id: "installed-deal-stage-email",
    workerId: "sales",
    name: "Update deal stage from email thread",
    description:
      "Read customer replies, infer stage changes, and update CRM next steps",
    status: "Enabled",
    apps: ["Microsoft Outlook", "Salesforce", "HubSpot"],
    runs: 31,
    successes: 29,
    lastRun: "Jun 20",
    device: "Alex's MacBook Pro",
  },
  {
    id: "installed-onboarding-handoff",
    workerId: "sales",
    name: "Create onboarding handoff",
    description:
      "Package closed-won context, implementation notes, risks, and success criteria for CS",
    status: "Paused",
    apps: ["Salesforce", "Google Docs", "Slack", "Google Drive"],
    runs: 14,
    successes: 13,
    lastRun: "Jun 17",
    device: "Alex's MacBook Pro",
  },
  ...salesLibraryCatalogEntries.map((entry, index) => ({
    id: `installed-sales-library-${index + 1}`,
    workerId: "sales",
    name: entry.name,
    description: entry.description,
    status: "Enabled" as const,
    apps: entry.apps,
    runs: 0,
    successes: 0,
    lastRun: "Not run yet",
    device: "Alex's MacBook Pro",
  })),
  {
    id: "installed-product-spec",
    workerId: "product",
    name: "Summarize product feedback",
    description: "Collect notes from docs and prepare the next product review",
    status: "Enabled",
    apps: ["Google Docs", "Slack", "Chrome"],
    runs: 17,
    successes: 16,
    lastRun: "2 hr ago",
    device: "Studio Mac mini",
  },
];

const recentWorkflowRuns: WorkflowRunEvent[] = [
  {
    id: "run-meeting-actions-18m",
    workflowName: "Extract action items from customer meeting",
    status: "Completed",
    detail: "Created four follow-up tasks and synced CRM notes",
    tone: "ready",
  },
  {
    id: "run-open-questions-43m",
    workflowName: "Track unanswered customer questions",
    status: "Completed",
    detail: "Flagged two engineering answers waiting on owners",
    tone: "ready",
  },
  {
    id: "run-onboarding-handoff",
    workflowName: "Create onboarding handoff",
    status: "Paused",
    detail: "Customer kickoff packet is paused",
    tone: "idle",
  },
];

const SALES_INSTALLED_WORKFLOW_BASE_TOTAL = 32;

const stepAsset = (label: string, value: string): WorkflowAsset => ({
  label,
  value,
});

const workflowSteps: WorkflowStep[] = [
  {
    id: "outlook-inquiry",
    title: "Open the inbound inquiry email in Outlook and extract lead facts",
    type: "Decision",
    app: "Microsoft Outlook",
    body: "Start from the original Outlook thread and decide whether the message is a real work inquiry, not spam, before spending time on research or a reply.",
    hints:
      "Check sender name, role, company, visible email domain, contact details, requested workflows, pain point, and requested next step. Prefer work domains and concrete business context; treat generic messages, suspicious links, and vague outreach as low-confidence. The captured example came from Rachel Lin, Director of Operations, asking whether OysterWorkflow could capture Maria's undocumented workflow.",
    assets: [
      stepAsset("Outlook work mailbox", "alexyang@oysterworkflow.com"),
      stepAsset(
        "Inbox location",
        "Outlook Mail > Inbox / inbound inquiry thread",
      ),
      stepAsset(
        "Inquiry filter",
        "Recent unread or active product/collaboration inquiry emails",
      ),
    ],
    approval: "Human review when sender identity or request intent is unclear",
  },
  {
    id: "request-specificity",
    title: "Judge whether the inquiry has detailed requirements or is vague",
    type: "Decision",
    app: "Microsoft Outlook",
    body: "Read the email carefully enough to separate concrete workflow requirements from a broad collaboration ask.",
    hints:
      "A strong inquiry explains the workflow, who performs it, why it hurts, which tools are involved, and what outcome the prospect wants. In the captured example, the request was detailed: internal tools, insurance portals, spreadsheets, Outlook inboxes, Maria's expert judgment, and a 30-minute call request.",
    assets: [
      stepAsset(
        "Qualification checklist",
        "Work email/domain, not spam, concrete workflow, tools involved, pain point, requested next step",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "google-search",
    title: "Search the prospect company in Google Chrome",
    type: "Decision",
    app: "Chrome",
    body: "Verify the company's public footprint before treating the inquiry as a serious opportunity.",
    hints:
      "Search the company name from the email. Check official domain, services, locations, similar-name entities, and any mismatch with the email claims. In the captured example, the exact public identity did not cleanly match the claim of 7 clinics across California.",
    assets: [
      stepAsset("Search target", "{{companyName}} from the Outlook inquiry"),
      stepAsset("Search tool", "Google Search in Google Chrome"),
    ],
    approval: "No approval required",
  },
  {
    id: "linkedin-check",
    title: "Check LinkedIn for company legitimacy and scale",
    type: "Decision",
    app: "Chrome",
    body: "Use LinkedIn to cross-check whether the company has a credible professional presence and plausible size.",
    hints:
      "Search the exact company name and use the Companies vertical when needed. Review company page, industry, location, employee count, followers, and whether there is no exact company result. If LinkedIn has no exact match, record that as an identity-verification gap rather than assuming the company is invalid.",
    assets: [
      stepAsset("LinkedIn search target", "{{companyName}}"),
      stepAsset("LinkedIn area", "Companies vertical"),
    ],
    approval: "No approval required",
  },
  {
    id: "chatgpt-evaluation",
    title: "Ask ChatGPT to collect company info and evaluate doability",
    type: "Decision",
    app: "Chrome",
    body: "Use the captured asking pattern: paste the customer information and requirements, then ask ChatGPT to evaluate whether collaboration is doable.",
    hints:
      'Do not broaden the prompt into a generic consulting task. The demonstrated typed prompt was: "{{companyName}} wants to collaborate with us, could you collect their info and help me to evaluate if it is doable?" Ask for diligence checks, workflow feasibility, risks, pilot scope, success metrics, and questions only insofar as they support that doability decision.',
    assets: [
      stepAsset(
        "Prompt reference",
        "{{companyName}} wants to collaborate with us, could you collect their info and help me to evaluate if it is doable?",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "qualification-decision",
    title: "Combine sources and decide whether the lead is worth pursuing",
    type: "Decision",
    app: "Chrome",
    body: "Synthesize Outlook, Google, LinkedIn, and ChatGPT findings into a pursue, verify-first, pause, or reject decision.",
    hints:
      "The captured recommendation was to pursue if identity is verified. The fit is strong because the work is undocumented, tool-heavy, repetitive, and judgment-heavy; the risk is that the exact public identity needs confirmation before investing engineering time.",
    assets: [
      stepAsset(
        "Decision inputs",
        "Outlook facts, Google findings, LinkedIn legitimacy/scale check, ChatGPT evaluation",
      ),
      stepAsset("Decision states", "Pursue, verify-first, pause, or reject"),
    ],
    approval: "Human review before external commitment",
  },
  {
    id: "risk-and-pilot-scope",
    title: "Capture risk boundaries and define a controlled pilot scope",
    type: "Decision",
    app: "Chrome",
    body: "Convert the qualification into a practical first pilot that can be discussed without overpromising autonomy or regulated-data readiness.",
    hints:
      "In regulated operations, assume sensitive customer data may be involved. The captured recommendation was a 2-3 week supervised copilot: email/PDF intake to extracted fields, required-field checks, system/spreadsheet update prep, follow-up draft, and edge-case flags. The human operator reviews logged actions during rollout.",
    assets: [
      stepAsset(
        "Risk boundaries",
        "Sensitive-data handling, audit logs, human review, no customer-data training, credential/MFA policy",
      ),
      stepAsset(
        "Pilot template",
        "2-3 week supervised copilot; synthetic or redacted examples first; human reviews logged actions",
      ),
      stepAsset(
        "Success metrics",
        "Time saved, extraction accuracy, useful draft rate, zero unauthorized sends or record updates",
      ),
    ],
    approval: "Human review before regulated-data workflow",
  },
  {
    id: "slack-tech-team",
    title: "Ask the Slack tech team to confirm feasibility",
    type: "Approval",
    app: "Slack",
    body: "Send the copied customer requirement to the internal engineering channel and ask whether the team can do it before replying externally.",
    hints:
      'Use the captured style instead of a polished enterprise escalation. The demonstrated Slack message started: "hi team, Harbor Wellness Group wants to collaborate with us, here is their requirement:" and ended with "Do you think we can do it? Any ideas?"',
    assets: [
      stepAsset("Slack channel", "#tech-team"),
      stepAsset(
        "Question template",
        "hi team, {{companyName}} wants to collaborate with us, here is their requirement: {{copied inquiry}} Do you think we can do it? Any ideas?",
      ),
    ],
    approval: "Internal feasibility check before external reply",
  },
  {
    id: "engineering-confirmation",
    title: "Wait for engineering confirmation and capture the answer",
    type: "Decision",
    app: "Slack",
    body: "Use the engineer's reply as the internal feasibility signal before drafting a positive response.",
    hints:
      'In the captured run, John He (Demo Engineer) was visible in the Slack channel and replied: "@here Yes, I think we can do this!" Capture the answer rather than inferring feasibility from ChatGPT alone.',
    assets: [
      stepAsset(
        "Expected response",
        "Feasibility confirmation, constraints, follow-up questions, or implementation owner",
      ),
      stepAsset(
        "Approval dependency",
        "Wait for engineering reply before drafting a positive external response",
      ),
    ],
    approval: "Human review if engineering response is missing or ambiguous",
  },
  {
    id: "clients-document",
    title: "Open the Microsoft Word document named Clients",
    type: "Action",
    app: "Microsoft Word",
    body: "Find an analogous prior customer case that supports the prospect reply with credible proof.",
    hints:
      "The captured internal document window was named Clients. Use it as internal evidence, not as raw customer-facing copy. The analogous case was NorthBridge Logistics, an active pilot for dispatch exception handling.",
    assets: [
      stepAsset(
        "Clients document path",
        "/Users/appleuser/Library/CloudStorage/OneDrive-Oysterworkflow/Clients",
      ),
      stepAsset(
        "Lookup target",
        "Prior customer story analogous to {{companyName}} and {{requestedWorkflow}}",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "case-proof",
    title: "Summarize the similar case details for the reply",
    type: "Action",
    app: "Microsoft Word",
    body: "Extract only the proof points that map to the current prospect's workflow-capture problem.",
    hints:
      "Prefer details that mirror the inbound inquiry: email triage, spreadsheet records, portal checks, judgment-heavy exceptions, draft generation, logs, escalation, and human review. Avoid disclosing confidential details beyond what the user is comfortable sharing.",
    assets: [
      stepAsset(
        "Case criteria",
        "Email triage, spreadsheet or portal lookup, exception handling, draft generation, human review",
      ),
      stepAsset(
        "Proof-point format",
        "Short customer-safe bullets to include in the reply draft",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "outlook-draft-saved",
    title: "Draft the Outlook reply in the user's tone and leave it saved",
    type: "Approval",
    app: "Microsoft Outlook",
    body: "Create a reply that sounds like the user, references the similar case, proposes a meeting, and remains saved as a draft.",
    hints:
      'The captured draft began: "Hi Rachel, I am glad to receive your inquiry and I believe we can collaborate on this!" It then referenced a similar case, pasted the captured workflow bullets, proposed a meeting next Monday, signed off as Alex Yang, and left the reply saved as a draft. Preserve the user\'s direct, positive tone while correcting obvious grammar in real use.',
    assets: [
      stepAsset(
        "Tone reference",
        "I am glad to receive your inquiry and I believe we can collaborate on this!",
      ),
      stepAsset(
        "Credibility pattern",
        "Reference the selected similar case from Clients without exposing confidential details",
      ),
      stepAsset("Saved output", "Outlook draft, not sent automatically"),
    ],
    approval: "Send only when the user explicitly asks",
  },
  {
    id: "hubspot-create-company",
    title: "Open HubSpot Companies and create a company record",
    type: "Action",
    app: "HubSpot",
    body: "Log the qualified inbound inquiry in CRM so the opportunity can be tracked after the draft reply is prepared.",
    hints:
      "Open HubSpot in Google Chrome, go to Companies, and use Create company / Add company. Do not mention the captured workspace name in the demo content.",
    assets: [
      stepAsset("CRM area", "HubSpot > Companies"),
      stepAsset("Action", "Create company / Add company"),
    ],
    approval: "No approval required",
  },
  {
    id: "hubspot-confirm-company",
    title: "Fill verified HubSpot fields and confirm the company record",
    type: "Decision",
    app: "HubSpot",
    body: "Create a clean company record and verify that the new record opens successfully with the expected metadata.",
    hints:
      "In the captured run, the company name was Harbor Wellness Group, owner was Shuxin Yang, lifecycle stage was Lead, and industry was set to Medical Devices. Leave uncertain fields such as domain, city, state, number of employees, or revenue blank when not verified. The final screen opened the created company record with a successful create timestamp.",
    assets: [
      stepAsset(
        "CRM field mapping",
        "Company name {{companyName}}, owner Shuxin Yang, lifecycle stage Lead, industry {{industry}} if verified",
      ),
      stepAsset("Default CRM owner", "Shuxin Yang"),
      stepAsset(
        "Data hygiene rule",
        "Leave uncertain fields blank rather than inventing them",
      ),
      stepAsset(
        "Verification",
        "Record page opens with saved owner, lifecycle stage, and create timestamp",
      ),
    ],
    approval: "No approval required",
  },
];

const graphiteInquirySteps: WorkflowStep[] = [
  {
    id: "outlook-inbox",
    title: "Open Outlook in the browser and identify inbound product inquiries",
    type: "Action",
    app: "Google Chrome",
    body: "Enter the email workflow and select a potential sales lead to qualify.",
    hints:
      "The demonstrated workflow starts from Outlook web mail. Prioritize unread or recent emails that appear to come from clients or website inquiry systems rather than login codes, newsletters, or social notifications.",
    assets: [
      stepAsset(
        "Outlook web mail URL",
        "https://outlook.cloud.microsoft/mail/",
      ),
      stepAsset("Sales mailbox", "Shuxin Yang / shuxinyang@graphitematrix.com"),
    ],
    approval: "No approval required",
  },
  {
    id: "extract-inquiry",
    title: "Open the selected inquiry email and extract the key lead details",
    type: "Action",
    app: "Microsoft Outlook",
    body: "Understand what the prospect is asking for before researching or replying.",
    hints:
      "In the trace, the email was a website message for a Product Inquiry from ENGEL CZ, s.r.o., contact Petr Vaclav, asking for product catalogs, pricing, minimum order quantities, and delivery terms. If the email is not from a client or does not contain a business inquiry, skip it and move to the next relevant unread email.",
    assets: [
      stepAsset(
        "Inquiry source",
        "Outlook email titled 国际站后台询盘提醒【中企跨境】 / 网站留言",
      ),
      stepAsset(
        "Inquiry details",
        "Company: ENGEL CZ, s.r.o.; Contact: Petr Vaclav; Email: engelczsro@gmail.com; asks for catalogs, pricing, MOQ, and delivery terms",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "google-verify",
    title: "Search the prospect company in Google and verify public signals",
    type: "Decision",
    app: "Google Chrome",
    body: "Confirm the lead is a real company before spending time on a response.",
    hints:
      "Use the company name exactly as written in the inquiry, then normalize obvious OCR or spelling variants if needed. In the demonstrated case, Google results showed ENGEL CZ, s.r.o. in Prague, Czechia, with an official engelglobal.com result and a Google business profile.",
    assets: [
      stepAsset("Company search", "ENGEL CZ, s.r.o."),
      stepAsset(
        "Public signals",
        "Location, official website, business category, address, phone, and profile snippets",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "website-fit",
    title: "Open the company website and evaluate industry fit",
    type: "Decision",
    app: "Google Chrome",
    body: "Qualify the lead based on industry fit.",
    hints:
      "The user explained that the company website should be checked first and that industry fit matters because unrelated industries do not need a response. Look for manufacturing processes, high-temperature systems, graphite-related applications, semiconductor, SiC, thermal storage, industrial equipment needs, or other signs of product fit.",
    assets: [
      stepAsset("Company website", "https://www.engelglobal.com/cs/cz/home"),
      stepAsset(
        "Observed fit signals",
        "Injection molding machines, automation, plastic processing, service, and digital solutions",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "linkedin-check",
    title: "Search LinkedIn and review the company profile",
    type: "Decision",
    app: "LinkedIn",
    body: "Cross-check the company identity and gather additional qualification context.",
    hints:
      "After evaluating the website, go to LinkedIn. In the demonstrated case, LinkedIn showed ENGEL CZ as a machinery manufacturing company in Praha 4 with 51-200 employees and about 980 followers, representing a leading injection molding machine manufacturer.",
    assets: [
      stepAsset(
        "LinkedIn company page",
        "https://www.linkedin.com/company/engel-cz/",
      ),
      stepAsset(
        "LinkedIn findings",
        "Machinery Manufacturing; Praha 4, Prague; 51-200 employees; about 980 followers",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "wechat-engineering",
    title: "Ask the engineering team when technical fit is unclear",
    type: "Approval",
    app: "WeChat",
    body: "Use internal expertise to avoid replying incorrectly to technically uncertain leads.",
    hints:
      "When evaluation is needed, summarize the prospect company, country, industry, stated needs, and ask directly: 'Do you think we can do this?' Do not expose unnecessary private information beyond what is needed for internal qualification.",
    assets: [
      stepAsset("Engineering channel", "WeChat engineering group"),
      stepAsset(
        "Question template",
        "Prospect summary plus: Do you think we can do this?",
      ),
    ],
    approval: "Human review recommended",
  },
  {
    id: "onedrive-cases",
    title: "Consult OneDrive case materials for similar experience",
    type: "Action",
    app: "OneDrive",
    body: "Prepare a credible response grounded in company experience rather than a generic sales message.",
    hints:
      "The trace used a Word document named Clients.docx from OneDrive. Look for case studies that match the prospect's industry or use case. If there is no exact match, use a broader but honest similar-industry reference.",
    assets: [
      stepAsset("Internal case-study document", "OneDrive / Clients.docx"),
      stepAsset(
        "Relevant case examples",
        "U.S. Semiconductor Equipment Supplier; Silicon Carbide Crystal Growth Manufacturer; Advanced Energy Storage Company",
      ),
    ],
    approval: "No approval required",
  },
  {
    id: "reply-thread",
    title: "Return to the Outlook inquiry and choose Reply",
    type: "Action",
    app: "Microsoft Outlook",
    body: "Start the follow-up response in the original email thread.",
    hints:
      "Use Reply so the prospect's original inquiry remains threaded. Confirm the recipient field is the prospect email from the inquiry before drafting.",
    assets: [
      stepAsset("Original Outlook thread", "ENGEL CZ Product Inquiry"),
      stepAsset("Recipient", "engelczsro@gmail.com"),
    ],
    approval: "No approval required",
  },
  {
    id: "draft-reply",
    title: "Draft a qualified sales reply asking for detailed requirements",
    type: "Approval",
    app: "Microsoft Outlook",
    body: "Produce a suitable sales follow-up draft that advances qualification.",
    hints:
      "Ask for product type, drawings/specifications, dimensions, quantity, application, target material grade, required purity/tolerance, delivery destination, and expected timeline. Reference similar experience without disclosing confidential customer names unless the user chooses to share them. Keep the tone professional and avoid overpromising before technical confirmation.",
    assets: [
      stepAsset(
        "Draft reply structure",
        "Greeting, possible collaboration, request detailed requirements, similar-industry experience, signature",
      ),
      stepAsset(
        "Company signature",
        "Shuxin Yang, Chief Executive Officer, Graphite Matrix, www.graphitematrix.com",
      ),
    ],
    approval: "Send only when the user explicitly asks",
  },
  {
    id: "review-draft",
    title: "Review the Outlook draft and leave it saved",
    type: "Approval",
    app: "Microsoft Outlook",
    body: "Close the workflow with a verified, reusable sales reply draft.",
    hints:
      "The demonstrated workflow ended with Outlook showing the message as draft saved. Review recipient, subject, spelling, grammar, tone, and whether it asks for detailed requirements. Correct obvious typos before finalizing.",
    assets: [
      stepAsset("Saved output", "Outlook draft, not sent automatically"),
      stepAsset("Send boundary", "Do not send unless the user explicitly asks"),
    ],
    approval: "Send only when the user explicitly asks",
  },
];

const workflows: WorkflowSummary[] = [
  {
    id: "inbound",
    title: "Qualify Outlook inbound inquiry and draft follow-up",
    code: "WF-1042",
    status: "Installable",
    tone: "ready",
    confidence: 94,
    description:
      "Screen an Outlook inquiry, verify the company, ask tech team, reference Clients, draft a reply, and log the company",
    icon: "target",
    detectedAt: "Detected on May 21, 2025 at 10:42 AM",
    connectedApps: [
      "Microsoft Outlook",
      "Google Chrome",
      "LinkedIn",
      "ChatGPT",
      "Slack",
      "Microsoft Word",
      "HubSpot",
    ],
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    stats: {
      uiEvents: 1147,
      ocrObservations: 70,
      voiceNotes: 12,
      duration: "6:36",
      decisionPoints: 5,
    },
    steps: workflowSteps,
  },
  {
    id: "outlook-product-inquiry",
    title: "Qualify Outlook product inquiry and draft sales reply",
    code: "WF-2121",
    status: "Generated",
    tone: "ready",
    confidence: 91,
    description:
      "Verify ENGEL CZ, check fit, consult cases, and save an Outlook draft",
    icon: "mail",
    detectedAt: "Generated on Jun 18, 2026 at 9:21 PM",
    connectedApps: [
      "Microsoft Outlook",
      "Google Chrome",
      "LinkedIn",
      "WeChat",
      "OneDrive",
    ],
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    stats: {
      uiEvents: 1147,
      ocrObservations: 70,
      voiceNotes: 12,
      duration: "6:36",
      decisionPoints: 5,
    },
    steps: graphiteInquirySteps,
  },
  {
    id: "tracker",
    title: "Prepare follow-up tracker",
    code: "WF-1044",
    status: "Review needed",
    tone: "warning",
    confidence: 82,
    description: "Create tracker, priority, and reminder",
    icon: "archive",
    detectedAt: "Detected on May 21, 2025 at 10:44 AM",
    connectedApps: ["Salesforce", "Gmail"],
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    stats: {
      uiEvents: 86,
      ocrObservations: 214,
      voiceNotes: 2,
      duration: "18:09",
      decisionPoints: 5,
    },
    steps: workflowSteps.slice(3),
  },
  {
    id: "feasibility",
    title: "Route feasibility request",
    code: "WF-1038",
    status: "Installable",
    tone: "ready",
    confidence: 89,
    description: "Ask engineering before commitment",
    icon: "network",
    detectedAt: "Detected on May 21, 2025 at 10:38 AM",
    connectedApps: ["Slack", "Google Drive"],
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    stats: {
      uiEvents: 104,
      ocrObservations: 268,
      voiceNotes: 3,
      duration: "24:37",
      decisionPoints: 7,
    },
    steps: workflowSteps.slice(1, 5),
  },
  {
    id: "reply",
    title: "Draft client reply safely",
    code: "WF-1046",
    status: "Needs context",
    tone: "danger",
    confidence: 68,
    description: "Needs more examples",
    icon: "chat",
    detectedAt: "Detected on May 21, 2025 at 10:46 AM",
    connectedApps: ["Gmail", "Microsoft Outlook"],
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    stats: {
      uiEvents: 58,
      ocrObservations: 133,
      voiceNotes: 1,
      duration: "12:45",
      decisionPoints: 4,
    },
    steps: workflowSteps.slice(0, 5),
  },
];

const DEMO_TRAINING_CAPTURE_ONLY =
  import.meta.env.VITE_OYSTERWORKFLOW_DEMO_CAPTURE_ONLY === "true";
const DEMO_CAPTURED_WORKFLOW_ID = "demo-captured-inbound";
const DEMO_CAPTURED_SESSION_ID = "demo-inbound-outlook-capture";
const DEMO_WORKFLOW_TEMPLATE_ID = "inbound";
const DEMO_DEFAULT_WORKFLOW_IDS = new Set([
  "inbound",
  "outlook-product-inquiry",
]);
const DEMO_WORKFLOW_TITLE =
  "Qualify Outlook inbound inquiry and draft follow-up";

function demoWorkflowTemplate(): WorkflowSummary {
  return (
    workflows.find((workflow) => workflow.id === DEMO_WORKFLOW_TEMPLATE_ID) ??
    workflows[0]
  );
}

function createDemoCapturedWorkflow(): WorkflowSummary {
  const template = demoWorkflowTemplate();
  return {
    ...template,
    id: DEMO_CAPTURED_WORKFLOW_ID,
    title: DEMO_WORKFLOW_TITLE,
    status: "Captured",
    tone: "idle",
    confidence: null,
    description: "Capture is ready. Generate it to build an editable workflow.",
    detectedAt: "Captured on Jun 21, 2026 at 6:36 PM",
    connectedApps: [],
    phase: "captured",
    sessionId: DEMO_CAPTURED_SESSION_ID,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "runtime",
    skill: null,
    candidate: null,
    steps: [],
    errorMessage: null,
  };
}

function createDemoGeneratedWorkflow(workflowId: string): WorkflowSummary {
  const template = demoWorkflowTemplate();
  return {
    ...template,
    id: workflowId,
    title: DEMO_WORKFLOW_TITLE,
    status: "Installable",
    tone: "ready",
    detectedAt: "Generated on Jun 21, 2026 at 6:36 PM",
    phase: "demo",
    sessionId: null,
    workflowId: null,
    workflowPath: null,
    skillPath: null,
    sourceType: "demo",
    skill: null,
    candidate: null,
    errorMessage: null,
  };
}

function demoDelay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const devices: Device[] = [
  {
    id: "alex-mbp",
    name: "Alex's MacBook Pro",
    status: "Available now",
    owner: "Alex Yang",
    assignedWorker: "Sales AI Worker",
    heartbeat: "Recently active",
    location: "Founder desk",
  },
  {
    id: "studio-mini",
    name: "Studio Mac mini",
    status: "Idle today",
    owner: "Demo workspace",
    assignedWorker: "Product Worker",
    heartbeat: "Idle today",
    location: "Office lab",
  },
  {
    id: "finance-laptop",
    name: "Finance Laptop",
    status: "Needs attention",
    owner: "Finance team",
    assignedWorker: "Finance Worker",
    heartbeat: "Not reachable",
    location: "Accounting desk",
  },
];

const slackIconUrl = resolveWorkflowApp("Slack").icon;
const wechatIconUrl = resolveWorkflowApp("WeChat").icon;
const whatsappIconUrl = resolveWorkflowApp("WhatsApp").icon;
const telegramIconUrl = resolveWorkflowApp("Telegram").icon;
const webAppIconUrl = resolveWorkflowApp("Web app").icon;
const WORKER_CHANNEL_OPTIONS: WorkerChannelOption[] = [
  {
    platform: "none",
    label: "Set up later",
    summary: "Skip for now. You can connect one later.",
    iconUrl: null,
    setupMethod: "none",
  },
  {
    platform: "whatsapp",
    label: "WhatsApp",
    summary: "Scan from WhatsApp Linked Devices.",
    iconUrl: whatsappIconUrl,
    setupMethod: "qr",
  },
  {
    platform: "weixin",
    label: "WeChat",
    summary: "Connect a WeChat iLink bot.",
    iconUrl: wechatIconUrl,
    setupMethod: "qr",
  },
  {
    platform: "slack",
    label: "Slack",
    summary: "Use your workspace's Socket Mode app.",
    iconUrl: slackIconUrl,
    setupMethod: "token",
  },
  {
    platform: "telegram",
    label: "Telegram",
    summary: "Use a BotFather bot token.",
    iconUrl: telegramIconUrl,
    setupMethod: "token",
  },
];
const WORKER_CHANNEL_CREDENTIAL_FIELDS: Record<
  ProductWorkerChannelPlatform,
  WorkerChannelCredentialField[]
> = {
  none: [],
  telegram: [{ key: "TELEGRAM_BOT_TOKEN", label: "Bot token", secret: true }],
  slack: [
    { key: "SLACK_BOT_TOKEN", label: "Bot token", secret: true },
    { key: "SLACK_APP_TOKEN", label: "App token", secret: true },
  ],
  weixin: [],
  whatsapp: [],
  wecom: [
    { key: "WECOM_BOT_ID", label: "Bot ID", secret: false },
    { key: "WECOM_SECRET", label: "Secret", secret: true },
  ],
};
const APP_LANGUAGE_STORAGE_KEY = "oysterworkflow.app-language";
const RECORDER_SETTINGS_STORAGE_KEY = "oysterworkflow.recorder-settings";
const STARTUP_LLM_SETUP_COMPLETED_STORAGE_KEY =
  "oysterworkflow.startup-llm-setup-completed";

interface RecorderSettingsSnapshot {
  ocrLanguagePriority: LabScreenpipeLanguage[];
  enableAudio: boolean;
}

function loadStoredAppLanguage(): AppLanguage {
  if (typeof window === "undefined") {
    return DEFAULT_APP_LANGUAGE;
  }

  try {
    return normalizeAppLanguage(
      window.localStorage.getItem(APP_LANGUAGE_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_APP_LANGUAGE;
  }
}

function persistAppLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
  } catch {
    // EN/CN: Storage failure should not block the app shell.
  }
}

function loadStoredRecorderSettings(): RecorderSettingsSnapshot {
  if (typeof window === "undefined") {
    return {
      ocrLanguagePriority: [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY],
      enableAudio: DEFAULT_RECORDING_ENABLE_AUDIO,
    };
  }

  try {
    const raw = window.localStorage.getItem(RECORDER_SETTINGS_STORAGE_KEY);
    if (!raw) {
      return {
        ocrLanguagePriority: [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY],
        enableAudio: DEFAULT_RECORDING_ENABLE_AUDIO,
      };
    }
    const parsed = JSON.parse(raw) as Partial<RecorderSettingsSnapshot>;
    return {
      ocrLanguagePriority: parsed.ocrLanguagePriority?.filter(
        isLabScreenpipeLanguage,
      ) ?? [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY],
      enableAudio:
        typeof parsed.enableAudio === "boolean"
          ? parsed.enableAudio
          : DEFAULT_RECORDING_ENABLE_AUDIO,
    };
  } catch {
    return {
      ocrLanguagePriority: [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY],
      enableAudio: DEFAULT_RECORDING_ENABLE_AUDIO,
    };
  }
}

function persistRecorderSettings(input: RecorderSettingsSnapshot): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      RECORDER_SETTINGS_STORAGE_KEY,
      JSON.stringify(input),
    );
  } catch {
    // EN/CN: Recorder config remains active in memory for this session.
  }
}

function buildRecorderLanguageDraft(
  priority: readonly LabScreenpipeLanguage[],
): RecorderLanguageSlotValue[] {
  return Array.from({ length: 3 }, (_, index) => priority[index] ?? "");
}

function normalizeRecorderLanguageDraft(
  draft: readonly RecorderLanguageSlotValue[],
): LabScreenpipeLanguage[] {
  const seen = new Set<LabScreenpipeLanguage>();
  const normalized: LabScreenpipeLanguage[] = [];
  for (const value of draft) {
    if (value && isLabScreenpipeLanguage(value) && !seen.has(value)) {
      normalized.push(value);
      seen.add(value);
    }
  }
  return normalized.length > 0
    ? normalized
    : [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY];
}

function isLabScreenpipeLanguage(
  value: unknown,
): value is LabScreenpipeLanguage {
  return (
    typeof value === "string" &&
    (LAB_SCREENPIPE_LANGUAGES as readonly string[]).includes(value)
  );
}

function buildLlmForm(config: LabLlmConfig): LlmFormState {
  const providerValue = config.provider ?? "";
  const providerPreset = detectLlmProviderPreset(providerValue);
  const modelPreset = detectLlmModelPreset(config.model);
  const callProfiles = Object.fromEntries(
    LAB_LLM_CALL_PROFILE_KEYS.map((key) => [
      key,
      {
        reasoningEffort: config.callProfiles[key]?.reasoningEffort ?? "",
        responseReadTimeoutMs:
          config.callProfiles[key]?.responseReadTimeoutMs === null
            ? ""
            : String(config.callProfiles[key]?.responseReadTimeoutMs ?? ""),
      } satisfies LlmCallProfileFormState,
    ]),
  ) as Record<LabLlmCallProfileKey, LlmCallProfileFormState>;

  return {
    providerPreset,
    customProvider: providerPreset === "custom" ? providerValue : "",
    baseUrl: config.baseUrl,
    modelPreset,
    customModel: modelPreset === "custom" ? config.model : "",
    wireApi: config.wireApi,
    reasoningEffort: normalizeLlmReasoningEffort(config.reasoningEffort),
    responseReadTimeoutMs: String(config.responseReadTimeoutMs),
    responseTimeoutMode: config.responseTimeoutMode,
    advancedTimeoutConfigEnabled: LAB_LLM_CALL_PROFILE_KEYS.some(
      (key) => config.callProfiles[key]?.responseReadTimeoutMs !== null,
    ),
    advancedReasoningConfigEnabled: LAB_LLM_CALL_PROFILE_KEYS.some((key) =>
      Boolean(config.callProfiles[key]?.reasoningEffort),
    ),
    callProfiles,
    clientProfile: normalizeLlmClientProfileFormValue(config.clientProfile),
    authMode: config.authMode,
    apiKey: "",
    apiKeyEnv: config.apiKeyEnv ?? "OPENAI_API_KEY",
    hasStoredApiKey: config.hasStoredApiKey,
    hasResolvedApiKey: config.hasResolvedApiKey,
  };
}

/**
 * EN: Detects the bundled development placeholder or unresolved credentials that need first-run setup.
 * 中文: 检测需要首次配置的内置开发占位地址或未解析凭据。
 * @param config normalized LLM configuration returned by Runtime.
 * @returns whether desktop startup should open model setup.
 */
function requiresStartupLlmSetup(config: LabLlmConfig): boolean {
  const usesBundledLocalPlaceholder =
    config.provider?.trim() === "codex-local" &&
    /^http:\/\/(?:127\.0\.0\.1|localhost):18080(?:\/|$)/iu.test(
      config.baseUrl.trim(),
    );
  const hasUnresolvedAuthentication =
    config.authMode !== "none" && !config.hasResolvedApiKey;
  return usesBundledLocalPlaceholder || hasUnresolvedAuthentication;
}

/**
 * EN: Detects local model endpoints that commonly run without API-key authentication.
 * 中文: 检测通常无需 API Key 的本地模型服务地址。
 * @param baseUrl configured model service URL.
 * @returns true for localhost IPv4 or IPv6 endpoints.
 */
function isLoopbackLlmBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function hasCompletedStartupLlmSetup(): boolean {
  try {
    return (
      window.localStorage.getItem(STARTUP_LLM_SETUP_COMPLETED_STORAGE_KEY) ===
      "1"
    );
  } catch {
    return false;
  }
}

function persistStartupLlmSetupCompleted(): void {
  try {
    window.localStorage.setItem(STARTUP_LLM_SETUP_COMPLETED_STORAGE_KEY, "1");
  } catch {
    // Local storage can be unavailable in hardened or ephemeral browser modes.
  }
}

function buildLlmUpdateInput(form: LlmFormState): LabLlmConfigUpdateInput {
  const responseReadTimeoutMs =
    parseResponseReadTimeoutMs(form.responseReadTimeoutMs) ?? 180_000;
  const callProfiles = Object.fromEntries(
    LAB_LLM_CALL_PROFILE_KEYS.map((key) => {
      const profile = form.callProfiles[key];
      return [
        key,
        {
          reasoningEffort: form.advancedReasoningConfigEnabled
            ? profile.reasoningEffort.trim() || null
            : null,
          responseReadTimeoutMs: form.advancedTimeoutConfigEnabled
            ? parseResponseReadTimeoutMs(profile.responseReadTimeoutMs)
            : null,
        },
      ];
    }),
  );

  return {
    provider: resolveLlmProviderValue(form).trim() || null,
    baseUrl: form.baseUrl.trim(),
    model: resolveLlmModelValue(form).trim(),
    wireApi: form.wireApi,
    reasoningEffort: form.advancedReasoningConfigEnabled
      ? null
      : form.reasoningEffort.trim() || null,
    responseReadTimeoutMs,
    responseTimeoutMode: form.responseTimeoutMode,
    callProfiles,
    clientProfile: resolveLlmClientProfileValue(form.clientProfile),
    authMode: form.authMode,
    apiKey: form.authMode === "direct" ? form.apiKey.trim() || null : null,
    apiKeyEnv: form.authMode === "env" ? form.apiKeyEnv.trim() || null : null,
  };
}

/**
 * EN: Builds the read-only model discovery request from current form fields.
 * 中文: 根据当前表单字段构建只读的模型发现请求。
 * @param form current LLM settings form.
 * @returns Runtime model discovery input.
 */
function buildLlmModelsInput(form: LlmFormState): LabLlmModelsInput {
  return {
    baseUrl: form.baseUrl.trim(),
    authMode: form.authMode,
    apiKey: form.authMode === "direct" ? form.apiKey.trim() || null : null,
    apiKeyEnv: form.authMode === "env" ? form.apiKeyEnv.trim() || null : null,
  };
}

function mergeRuntimeWorkflows(
  runtimeWorkflows: WorkflowSummary[],
): WorkflowSummary[] {
  const runtimeWorkflowIds = new Set(
    runtimeWorkflows.map((workflow) => workflow.id),
  );
  const runtimeSessionIds = new Set(
    runtimeWorkflows
      .map((workflow) => workflow.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  return [
    ...runtimeWorkflows,
    ...workflows.filter(
      (workflow) =>
        !runtimeWorkflowIds.has(workflow.id) &&
        (!workflow.sessionId || !runtimeSessionIds.has(workflow.sessionId)),
    ),
  ];
}

function isRuntimeWorkflow(workflow: WorkflowSummary): boolean {
  return workflow.sourceType === "runtime";
}

function mergeWorkflowItem(
  previous: WorkflowSummary[],
  nextWorkflow: WorkflowSummary,
): WorkflowSummary[] {
  return [
    nextWorkflow,
    ...previous.filter(
      (workflow) =>
        workflow.id !== nextWorkflow.id &&
        (!nextWorkflow.sessionId ||
          workflow.sessionId !== nextWorkflow.sessionId),
    ),
  ];
}

function formatStatValue(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "--";
}

function workflowCodeFromProductWorkflow(
  productWorkflow: ProductWorkflow,
): string {
  const source = [
    productWorkflow.id,
    productWorkflow.title,
    productWorkflow.createdAt,
  ].join("|");
  let hash = 0;
  for (const character of source) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `WF-${String(1000 + (hash % 9000)).padStart(4, "0")}`;
}

function channelTestToast(channel: ProductWorkerChannelConfig): string {
  if (channel.status === "connected") {
    return `${channel.label} connected.`;
  }
  if (channel.status === "configured" && !channel.lastError) {
    return `${channel.label} runtime is ready. Send a message to verify delivery.`;
  }
  return channel.lastError
    ? `${channel.label} connection test failed: ${channel.lastError}`
    : `${channel.label} connection test did not reach connected.`;
}

function parseChannelList(value: string): string[] {
  return value
    .split(/[\n,]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function channelPeerKey(peer: ProductChannelPeer): string {
  return `${peer.conversationId}\u0000${peer.threadId ?? ""}`;
}

function isTerminalChannelSetupStatus(status: string | undefined): boolean {
  return (
    status === "connected" || status === "failed" || status === "cancelled"
  );
}

function formatRelativeTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "recently";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function selectedChannelCredentials(
  fields: WorkerChannelCredentialField[],
  values: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    fields
      .map((field) => [field.key, values[field.key]?.trim() ?? ""] as const)
      .filter(([, value]) => value.length > 0),
  );
}

function workerChannelStatusTone(
  channel: ProductWorkerChannelConfig | null,
): Tone {
  if (!channel || channel.platform === "none") {
    return "idle";
  }
  if (channel.status === "connected") {
    return "ready";
  }
  if (channel.status === "failed") {
    return "danger";
  }
  return "warning";
}

function workerChannelStatusLabel(
  channel: ProductWorkerChannelConfig | null,
): string {
  if (!channel || channel.platform === "none") {
    return "Not configured";
  }
  if (channel.status === "connected") {
    return "Connected";
  }
  if (channel.status === "failed") {
    return "Test failed";
  }
  if (channel.status === "testing") {
    return "Testing";
  }
  return "Configured";
}

function workerChannelIconUrl(platform: ProductWorkerChannelPlatform): string {
  if (platform === "telegram") {
    return telegramIconUrl;
  }
  if (platform === "slack") {
    return slackIconUrl;
  }
  if (platform === "whatsapp") {
    return whatsappIconUrl;
  }
  if (platform === "weixin" || platform === "wecom") {
    return wechatIconUrl;
  }
  return webAppIconUrl;
}

function defaultUiWorkerChannelConfig(): ProductWorkerChannelConfig {
  return {
    platform: "none",
    label: "No channel",
    accessMode: "disabled",
    homeChannel: null,
    allowedUsers: [],
    configuredFields: [],
    missingFields: [],
    status: "not_configured",
    lastTestedAt: null,
    lastError: null,
  };
}

function buildDeviceReport(input: {
  devices: Device[];
  workers: Worker[];
}): string {
  const lines = [
    "OysterWorkflow Device Report",
    `Generated at: ${new Date().toISOString()}`,
    "",
    "Trusted computers",
    ...input.devices.flatMap((device) => [
      `- ${device.name}`,
      `  Status: ${device.status}`,
      `  Owner: ${device.owner}`,
      `  Assigned worker: ${device.assignedWorker}`,
      `  Availability: ${device.heartbeat}`,
    ]),
    "",
    "AI workers",
    ...input.workers.map(
      (worker) =>
        `- ${worker.name}: ${worker.status}, device ${worker.device}, heartbeat ${worker.heartbeat}`,
    ),
    "",
  ];
  return lines.join("\n");
}

function buildAccountNotifications(input: {
  productState: ProductStateSnapshot | null;
  workers: Worker[];
  devices: Device[];
}): AccountNotification[] {
  const notifications: AccountNotification[] = [];
  const needsDevice = input.workers.filter(
    (worker) =>
      worker.device === "Unassigned" || worker.status === "Needs device",
  );
  if (needsDevice.length > 0) {
    notifications.push({
      id: "workers-need-device",
      title: `${needsDevice.length} worker${needsDevice.length > 1 ? "s" : ""} need a device`,
      body: needsDevice.map((worker) => worker.name).join(", "),
      tone: "warning",
      meta: "Setup",
    });
  }

  const activeRun = input.productState?.runs.find(
    (run) =>
      run.status === "running" ||
      run.status === "waiting_for_user" ||
      run.status === "blocked",
  );
  if (activeRun) {
    const statusLabel = productRunStatusLabel(activeRun.status);
    notifications.push({
      id: `run-${activeRun.id}`,
      title:
        activeRun.status === "running"
          ? "Worker is running"
          : `Workflow ${statusLabel.toLowerCase()}`,
      body: activeRun.workflowTitle,
      tone: productRunTone(activeRun.status),
      meta: "Live run",
    });
  }

  const latestRun = input.productState?.runs.find(
    (run) => run.status === "succeeded" || run.status === "paused",
  );
  if (latestRun) {
    notifications.push({
      id: `latest-${latestRun.id}`,
      title:
        latestRun.status === "succeeded"
          ? "Latest run completed"
          : "Latest run paused",
      body: latestRun.workflowTitle,
      tone: latestRun.status === "succeeded" ? "ready" : "idle",
      meta: formatProductRunTimestamp(latestRun),
    });
  }

  if (input.productState?.hermes.available === false) {
    notifications.push({
      id: "hermes-unavailable",
      title: "AI worker runtime not connected",
      body:
        (input.productState.hermes.lastError
          ? productizeWorkerFacingText(input.productState.hermes.lastError)
          : null) ??
        "Start the local AI worker runtime before running installed workflows.",
      tone: "warning",
      meta: "Runtime",
    });
  }

  const providerHealth = input.productState?.hermes.providerHealth;
  if (
    input.productState?.hermes.available !== false &&
    providerHealth?.status === "degraded"
  ) {
    notifications.push({
      id: "llm-provider-degraded",
      title: "LLM provider degraded",
      body:
        (providerHealth.message
          ? productizeWorkerFacingText(providerHealth.message)
          : null) ??
        "The AI worker model provider reported an issue. Running workflows may retry or pause.",
      tone: "warning",
      meta: providerHealth.provider ?? "Provider",
    });
  }

  if (notifications.length === 0) {
    notifications.push({
      id: "workspace-ready",
      title: "Workspace is ready",
      body: `${input.devices.length} trusted computers and ${input.workers.length} workers are visible.`,
      tone: "ready",
      meta: "Status",
    });
  }

  return notifications.slice(0, 5);
}

function installedWorkflowsForWorker(workerId: string): InstalledWorkflow[] {
  return installedWorkflowCatalog.filter(
    (workflow) => workflow.workerId === workerId,
  );
}

function installedWorkflowFromDeployment(
  deployedWorkflow: DeployedWorkflow,
  worker: Worker,
): InstalledWorkflow {
  return {
    id: `deployed-${deployedWorkflow.workflowId}`,
    workerId: deployedWorkflow.workerId,
    name: deployedWorkflow.workflowTitle,
    description: deployedWorkflow.description,
    status: "Enabled",
    apps: deployedWorkflow.apps,
    runs: 0,
    successes: 0,
    lastRun: "Not run yet",
    device: worker.device,
  };
}

function summarizeInstalledWorkflows(workflowsForWorker: InstalledWorkflow[]) {
  const runs = workflowsForWorker.reduce(
    (total, workflow) => total + workflow.runs,
    0,
  );
  const successes = workflowsForWorker.reduce(
    (total, workflow) => total + workflow.successes,
    0,
  );
  return {
    count: workflowsForWorker.length,
    runs,
    successes,
    successRate: runs > 0 ? `${((successes / runs) * 100).toFixed(1)}%` : "--",
  };
}

function installedWorkflowTone(status: InstalledWorkflowStatus): Tone {
  if (status === "Enabled") {
    return "ready";
  }
  return "idle";
}

function installedWorkflowActions(workflow: InstalledWorkflow): string[] {
  if (workflow.status === "Paused") {
    return ["View runs", "Enable", "Remove"];
  }
  if (workflow.updateAvailable) {
    return ["View runs", "Remove"];
  }
  return ["View runs", "Disable", "Remove"];
}

function matchesInstalledWorkflowFilter(
  workflow: InstalledWorkflow,
  searchQuery: string,
  statusFilter: InstalledWorkflowStatusFilter,
): boolean {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesStatus =
    statusFilter === "All" || workflow.status === statusFilter;
  if (!matchesStatus) {
    return false;
  }

  if (normalizedQuery.length === 0) {
    return true;
  }

  const searchableText = [
    workflow.name,
    workflow.description,
    workflow.status,
    workflow.device,
    ...workflow.apps,
  ]
    .join(" ")
    .toLowerCase();
  return searchableText.includes(normalizedQuery);
}

function matchesWorkflowFilter(
  workflow: WorkflowSummary,
  searchQuery: string,
  statusFilter: WorkflowStatusFilter,
): boolean {
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchesStatus =
    statusFilter === "All" || workflow.status === statusFilter;
  if (!matchesStatus) {
    return false;
  }

  if (normalizedQuery.length === 0) {
    return true;
  }

  const searchableText = [
    workflow.code,
    workflow.title,
    workflow.description,
    workflow.status,
    workflow.detectedAt,
    workflow.phase,
    ...workflow.connectedApps,
  ]
    .join(" ")
    .toLowerCase();
  return searchableText.includes(normalizedQuery);
}

function installedWorkflowActionIcon(action: string): IconName {
  const icons: Record<string, IconName> = {
    Review: "expand",
    "View runs": "activity",
    Enable: "play",
    Disable: "power",
    Update: "download",
    Remove: "trash",
  };
  return icons[action] ?? "more";
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectedAppForName(name: string): AppIdentity {
  return resolveWorkflowApp(name);
}

function productWorkerIcon(workerId: string): IconName {
  const icons: Record<string, IconName> = {
    marketing: "megaphone",
    product: "cube",
    finance: "archive",
    sales: "briefcase",
  };
  return icons[workerId] ?? "user";
}

function workerFromProductState(
  productState: ProductStateSnapshot,
  worker: ProductWorker,
): Worker {
  const activeRun = activeProductRunForWorker(productState, worker.id);
  const idleWithoutHermesSession =
    !activeRun && worker.deviceId !== null && worker.status === "Available";
  return {
    id: worker.id,
    name: worker.name,
    initials: worker.initials,
    description: worker.description,
    status: (idleWithoutHermesSession
      ? "No active task"
      : worker.status) as WorkerStatus,
    tone: (idleWithoutHermesSession ? "idle" : worker.tone) as Tone,
    icon: productWorkerIcon(worker.id),
    avatarUrl: productWorkerAvatarAsset(worker),
    device: productWorkerDeviceLabel(productState, worker),
    selectedInstalledWorkflowId: worker.selectedInstalledWorkflowId,
    heartbeat: productizeWorkerFacingText(
      displayWorkerHeartbeat(worker, idleWithoutHermesSession),
    ),
    activities: worker.activities.map(productizeWorkerFacingText),
  };
}

/**
 * EN: Converts low-level runtime recovery wording into operator-ready UI copy.
 * 中文: 将底层运行时恢复文案转换成主控制台里更适合操作者理解的状态。
 * @param worker product worker from the local product store.
 * @param idleWithoutHermesSession true when a legacy worker status says available without an open run.
 * @returns display heartbeat for prominent worker surfaces.
 */
function displayWorkerHeartbeat(
  worker: ProductWorker,
  idleWithoutHermesSession: boolean,
): string {
  if (
    idleWithoutHermesSession &&
    /^(AI worker ready|Recently active)$/iu.test(worker.heartbeat)
  ) {
    return START_WORKER_PREPARATION_MESSAGE;
  }
  if (/recovered after restart/i.test(worker.heartbeat)) {
    return START_WORKER_PREPARATION_MESSAGE;
  }
  return worker.heartbeat;
}

function deviceFromProductDevice(
  productState: ProductStateSnapshot,
  device: ProductDevice,
): Device {
  const assignedWorker =
    productState.workers.find((worker) => worker.id === device.assignedWorkerId)
      ?.name ?? "Unassigned";
  return {
    id: device.id,
    name: device.name,
    status: device.status,
    owner: device.owner,
    assignedWorker,
    heartbeat: formatDeviceAvailability(device.heartbeat),
    location: device.location,
  };
}

/**
 * EN: Formats machine timestamps for display while preserving human-readable runtime labels.
 * 中文: 将机器时间戳转换为本地可读时间，同时保留已有的人类可读状态。
 * @param value device heartbeat or availability text from ProductState.
 * @returns localized date-time for ISO values, otherwise the original text.
 */
function formatDeviceAvailability(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    return value;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString()
    : value;
}

function installedWorkflowFromProductState(
  productState: ProductStateSnapshot,
  workflow: ProductInstalledWorkflow,
): InstalledWorkflow {
  const workflowRuns = productState.runs.filter(
    (run) => run.installedWorkflowId === workflow.id,
  );
  const liveRuns = workflowRuns.filter(
    (run) => !run.id.startsWith("run-installed-") && !isRuntimeRecoveryRun(run),
  );
  const completedRuns = liveRuns.filter((run) => run.status === "succeeded");
  const lastRuntimeRun =
    workflowRuns.find((run) => !isRuntimeRecoveryRun(run)) ?? null;
  const deviceName =
    productState.devices.find(
      (device) => device.id === workflow.deployTargetDeviceId,
    )?.name ?? "Unassigned";

  return {
    id: workflow.id,
    workerId: workflow.workerId,
    name: workflow.workflowTitle,
    description: workflow.description,
    status: workflow.status,
    apps: workflow.apps,
    runs: workflow.baselineRuns + liveRuns.length,
    successes: workflow.baselineSuccesses + completedRuns.length,
    lastRun: lastRuntimeRun
      ? formatProductRunTimestamp(lastRuntimeRun)
      : workflow.baselineLastRun,
    device: deviceName,
    updateAvailable: workflow.updateAvailable,
  };
}

/**
 * EN: Detects technical recovery failures that should stay in diagnostics but not lead business summaries.
 * 中文: 识别技术恢复类失败, 它们应保留在诊断记录里, 但不应污染业务摘要。
 * @param run product run returned from the local product store.
 * @returns true when the run only records runtime restart recovery.
 */
function isRuntimeRecoveryRun(run: ProductRun): boolean {
  return (
    run.status === "failed" &&
    /runtime restarted before this run finished/i.test(run.errorMessage ?? "")
  );
}

function formatProductRunTimestamp(run: ProductRun): string {
  if (run.status === "running") {
    return "Running now";
  }
  if (run.status === "failed") {
    return "Failed just now";
  }
  if (run.status === "paused") {
    return "Paused";
  }
  const timestamp = run.endedAt ?? run.startedAt;
  const elapsedMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(elapsedMs)) {
    return "Recently";
  }
  const minutes = Math.max(0, Math.round(elapsedMs / 60_000));
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function workflowRunEventFromProductRun(run: ProductRun): WorkflowRunEvent {
  const statusMap: Record<ProductRun["status"], WorkflowRunEvent["status"]> = {
    queued: "Paused",
    running: "Running",
    waiting_for_user: "Waiting for user",
    blocked: "Blocked",
    succeeded: "Completed",
    failed: "Failed",
    cancelled: "Paused",
    paused: "Paused",
  };
  const toneMap: Record<ProductRun["status"], Tone> = {
    queued: "idle",
    running: "working",
    waiting_for_user: "warning",
    blocked: "danger",
    succeeded: "ready",
    failed: "danger",
    cancelled: "idle",
    paused: "warning",
  };
  return {
    id: run.id,
    workflowName: run.workflowTitle,
    status: statusMap[run.status],
    detail: productizeWorkerFacingText(productRunDetail(run)),
    tone: toneMap[run.status],
  };
}

function productRunDetail(run: ProductRun): string {
  if (run.status === "queued") {
    return "Waiting for runtime (legacy)";
  }
  if (run.status === "running") {
    return "AI worker runtime is connected for this workflow";
  }
  if (run.status === "waiting_for_user") {
    return "Waiting for user action";
  }
  if (run.status === "blocked") {
    return run.errorMessage ?? "AI worker cannot continue this run";
  }
  if (run.status === "paused") {
    return "Stopped by Alex";
  }
  if (run.status === "cancelled") {
    return "Cancelled before completion";
  }
  if (run.status === "failed") {
    return "AI worker could not complete this run. Check Activity for details.";
  }
  return formatProductRunTimestamp(run);
}

function workflowSummaryFromProductWorkflow(
  productWorkflow: ProductWorkflow,
): WorkflowSummary {
  const template =
    workflows.find((workflow) => workflow.id === productWorkflow.id) ??
    workflowSummaryTemplateFromProductWorkflow(productWorkflow);
  return {
    ...template,
    id: productWorkflow.id,
    code: workflowCodeFromProductWorkflow(productWorkflow),
    title: productWorkflow.title,
    status:
      productWorkflow.status === "Needs review"
        ? "Review needed"
        : productWorkflow.status,
    tone: workflowToneForProductStatus(productWorkflow.status),
    confidence: productWorkflow.confidence,
    description: productWorkflow.description,
    detectedAt: productWorkflow.detectedAt,
    connectedApps: productWorkflow.apps,
    stats: productWorkflow.stats,
    sourceType: productWorkflow.sourceType === "demo" ? "demo" : "runtime",
    phase:
      productWorkflow.status === "Captured"
        ? "captured"
        : productWorkflow.status === "Generated"
          ? "generated"
          : template.phase,
    workflowPath: productWorkflow.artifactPath ?? template.workflowPath,
    skillPath:
      productWorkflow.status === "Generated"
        ? (productWorkflow.artifactPath ?? template.skillPath)
        : template.skillPath,
  };
}

function workflowSummaryTemplateFromProductWorkflow(
  workflow: ProductWorkflow,
): WorkflowSummary {
  const primaryApp = workflow.apps[0] ?? "Desktop app";
  return {
    id: workflow.id,
    title: workflow.title,
    code: workflowCodeFromProductWorkflow(workflow),
    status:
      workflow.status === "Needs review" ? "Review needed" : workflow.status,
    tone: workflowToneForProductStatus(workflow.status),
    confidence: workflow.confidence,
    description: workflow.description,
    icon: workflow.sourceType === "imported" ? "upload" : "target",
    detectedAt: workflow.detectedAt,
    connectedApps: workflow.apps,
    phase: workflow.status === "Captured" ? "captured" : "generated",
    sessionId: null,
    workflowId: workflow.id,
    workflowPath: workflow.artifactPath,
    skillPath: workflow.artifactPath,
    sourceType: "runtime",
    skill: null,
    candidate: null,
    stats: workflow.stats,
    steps: [
      {
        id: "review-objective",
        title: "Review workflow objective and source brief",
        type: "Action",
        app: "OysterWorkflow",
        body: workflow.sourceText?.trim() || workflow.description,
        hints:
          "Confirm the outcome, required apps, and operating boundaries before installation.",
        assets: [
          stepAsset("Source", "Saved workflow brief"),
          stepAsset("Primary app", primaryApp),
        ],
        approval: "Approval policy allow_all",
      },
    ],
  };
}

function workflowToneForProductStatus(
  status: ProductWorkflow["status"],
): WorkflowSummary["tone"] {
  if (status === "Captured") {
    return "idle";
  }
  if (status === "Needs review") {
    return "warning";
  }
  if (status === "Needs context") {
    return "danger";
  }
  return "ready";
}

function mergeProductWorkflowSummaries(
  productWorkflows: WorkflowSummary[],
  currentWorkflows: WorkflowSummary[],
): WorkflowSummary[] {
  const productWorkflowPositions = new Map(
    productWorkflows.map((workflow, index) => [workflow.id, index]),
  );
  const currentRuntimeWorkflows = currentWorkflows
    .filter(isRuntimeWorkflow)
    .sort((left, right) => {
      const leftIndex = productWorkflowPositions.get(left.id);
      const rightIndex = productWorkflowPositions.get(right.id);
      if (leftIndex === undefined && rightIndex === undefined) return 0;
      if (leftIndex === undefined) return 1;
      if (rightIndex === undefined) return -1;
      return leftIndex - rightIndex;
    });
  const currentRuntimeWorkflowIds = new Set(
    currentRuntimeWorkflows.map((workflow) => workflow.id),
  );
  const currentRuntimeSessionIds = new Set(
    currentRuntimeWorkflows
      .map((workflow) => workflow.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId)),
  );
  const withoutCurrentRuntimeDuplicates = (workflow: WorkflowSummary) =>
    !currentRuntimeWorkflowIds.has(workflow.id) &&
    (!workflow.sessionId || !currentRuntimeSessionIds.has(workflow.sessionId));
  return [
    ...currentRuntimeWorkflows,
    ...productWorkflows.filter(withoutCurrentRuntimeDuplicates),
  ];
}

function shouldSelectRuntimeWorkflow(
  currentWorkflowId: string,
  nextRuntimeWorkflow: WorkflowSummary | null,
): nextRuntimeWorkflow is WorkflowSummary {
  return (
    nextRuntimeWorkflow !== null &&
    (currentWorkflowId.length === 0 ||
      DEMO_DEFAULT_WORKFLOW_IDS.has(currentWorkflowId))
  );
}

function App() {
  const cloudAuth = useCloudAuth();
  const {
    state: productState,
    error: productStateError,
    applySnapshot: applyProductStateSnapshot,
    getGeneration: getProductStateGeneration,
    invalidate: invalidateProductState,
    runRefresh: runProductStateRefresh,
  } = useProductStateController<ProductStateSnapshot>();
  const [activePage, setActivePage] = useState<PageId>("workers");
  const [selectedWorkerId, setSelectedWorkerId] = useState("sales");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("inbound");
  const [selectedDeviceId, setSelectedDeviceId] = useState("alex-mbp");
  const [installTargetId, setInstallTargetId] = useState("sales");
  const [workerTabRequest, setWorkerTabRequest] = useState<{
    workerId: string;
    tab: WorkerDetailTab;
    requestId: number;
  } | null>(null);
  const [workflowItems, setWorkflowItems] =
    useState<WorkflowSummary[]>(workflows);
  const [activeTrainingSession, setActiveTrainingSession] =
    useState<LabSession | null>(null);
  const [localWorkerItems] = useState<Worker[]>(workers);
  const [demoTrainingActive, setDemoTrainingActive] = useState(false);
  const [trainingAction, setTrainingAction] = useState<
    "idle" | "starting" | "stopping"
  >("idle");
  const [generationProgress, setGenerationProgress] =
    useState<GenerateWorkflowProgress | null>(null);
  const [workflowSelectionRequest, setWorkflowSelectionRequest] = useState<{
    workflowItemId: string;
    sessionId: string;
    workflowPath: string;
    candidates: WorkflowCandidate[];
    recommendedWorkflowId: string;
  } | null>(null);
  const [pendingWorkflowMerges, setPendingWorkflowMerges] = useState<
    ProductPendingWorkflowMerge[]
  >([]);
  const [deferredWorkflowMergeHashes, setDeferredWorkflowMergeHashes] =
    useState<Set<string>>(() => new Set());
  const [isWorkflowMergeSubmitting, setIsWorkflowMergeSubmitting] =
    useState(false);
  const [workflowMergeError, setWorkflowMergeError] = useState<string | null>(
    null,
  );
  const [versionHistoryWorkflowId, setVersionHistoryWorkflowId] = useState<
    string | null
  >(null);
  const [fullMapWorkflowId, setFullMapWorkflowId] = useState<string | null>(
    null,
  );
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [accountUtilityPanel, setAccountUtilityPanel] =
    useState<AccountUtilityPanel | null>(null);
  const [isWorkerDraftOpen, setIsWorkerDraftOpen] = useState(false);
  const [isDeviceAssignDialogOpen, setIsDeviceAssignDialogOpen] =
    useState(false);
  const [channelSetupWorkerId, setChannelSetupWorkerId] = useState<
    string | null
  >(null);
  const [deleteWorkerId, setDeleteWorkerId] = useState<string | null>(null);
  const [deleteWorkflowId, setDeleteWorkflowId] = useState<string | null>(null);
  const [deployedWorkflow, setDeployedWorkflow] =
    useState<DeployedWorkflow | null>(null);
  const [runningWorkerIds, setRunningWorkerIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [toast, setToast] = useState<string | null>(null);
  const runtimeBridgeInfo = useMemo(() => getRuntimeBridgeInfo(), []);
  const isDesktopRuntime = runtimeBridgeInfo.mode === "desktop";
  const desktopUpdate = useDesktopUpdateController(isDesktopRuntime);
  const startupCheckStartedRef = useRef(false);
  const startupRuntimePreparationStartedRef = useRef(false);
  const llmModelsRequestIdRef = useRef(0);
  const capabilityCheckInFlightRef = useRef<ProductCapabilityProviderId | null>(
    null,
  );
  const runtimeStateRefreshGenerationRef = useRef(0);
  const runtimeStateRefreshRequestIdRef = useRef(0);
  const runtimeStateRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const runtimeRecorderMutationInFlightRef = useRef(false);
  const permissionRequestInFlightRef = useRef(false);

  const [appLanguage, setAppLanguage] = useState<AppLanguage>(
    loadStoredAppLanguage,
  );
  const [generalLanguageDraft, setGeneralLanguageDraft] =
    useState<AppLanguage>(appLanguage);
  const [generalSettingsFeedback, setGeneralSettingsFeedback] = useState<
    string | null
  >(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSettingsSection, setActiveSettingsSection] =
    useState<SettingsSection>("general");
  const initialRecorderSettings = useMemo(loadStoredRecorderSettings, []);
  const [recorderLanguageDraft, setRecorderLanguageDraft] = useState<
    RecorderLanguageSlotValue[]
  >(() =>
    buildRecorderLanguageDraft(initialRecorderSettings.ocrLanguagePriority),
  );
  const [recorderEnableAudio, setRecorderEnableAudio] = useState(
    initialRecorderSettings.enableAudio,
  );
  const [recorderSettingsError, setRecorderSettingsError] = useState<
    string | null
  >(null);
  const [recorderSettingsFeedback, setRecorderSettingsFeedback] = useState<
    string | null
  >(null);
  const {
    permissions,
    loading: permissionsLoading,
    error: permissionsError,
    mode: permissionMode,
    startupGateOpen: startupPermissionGateOpen,
    startupPhase: startupPermissionPhase,
    restartRequired: startupPermissionRestartRequired,
    invalidate: invalidateRecorderPermissions,
    refresh: refreshRecorderPermissions,
    setError: setPermissionsError,
    setMode: setPermissionMode,
    setRestartRequired: setStartupPermissionRestartRequired,
    setStartupGateOpen: setStartupPermissionGateOpen,
    setStartupPhase: setStartupPermissionPhase,
  } = useRecorderPermissionsController(
    checkRuntimeRecorderPermissions,
    toErrorMessage,
  );
  const [requestingPermissionKind, setRequestingPermissionKind] =
    useState<RecorderPermissionKind | null>(null);
  const [checkingCapabilityProviderId, setCheckingCapabilityProviderId] =
    useState<ProductCapabilityProviderId | null>(null);
  const [capabilityProviderError, setCapabilityProviderError] = useState<
    string | null
  >(null);
  const [isCheckingLlmProvider, setIsCheckingLlmProvider] = useState(false);
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null);
  const [llmForm, setLlmForm] = useState<LlmFormState | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmError, setLlmError] = useState<string | null>(null);
  const [llmFeedback, setLlmFeedback] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [llmModelsLoading, setLlmModelsLoading] = useState(false);
  const [llmModelsLoaded, setLlmModelsLoaded] = useState(false);
  const [llmModelsError, setLlmModelsError] = useState<string | null>(null);
  const [startupLlmSetupCompleted, setStartupLlmSetupCompleted] = useState(
    hasCompletedStartupLlmSetup,
  );
  const [startupLlmSetupRequired, setStartupLlmSetupRequired] = useState(false);
  const [startupLlmConnectionReady, setStartupLlmConnectionReady] =
    useState(false);
  const {
    status: startupRuntimePreparation,
    run: prepareStartupRuntime,
    updateDependency: updateStartupDependencyStatus,
  } = useStartupRuntimePreparationController();
  const startupWorkspaceGateOpen =
    isDesktopRuntime &&
    startupPermissionPhase === "ready" &&
    productState?.account.setupCompleted === true &&
    !startupLlmSetupCompleted &&
    (startupLlmSetupRequired ||
      !startupLlmConnectionReady ||
      startupRuntimePreparation.phase !== "ready");
  const startupBlockingSurfaceOpen =
    startupPermissionGateOpen || startupWorkspaceGateOpen;
  const accountSetupDialogOpen =
    !startupBlockingSurfaceOpen &&
    (isAccountModalOpen || productState?.account.setupCompleted === false);

  const workerItems = useMemo(() => {
    if (!productState) {
      return isDesktopRuntime ? [] : localWorkerItems;
    }
    const productWorkers = productState.workers.map((worker) =>
      workerFromProductState(productState, worker),
    );
    const productWorkerIds = new Set(productWorkers.map((worker) => worker.id));
    const localDraftWorkers = localWorkerItems.filter(
      (worker) => !workers.some((baseWorker) => baseWorker.id === worker.id),
    );
    return [
      ...productWorkers,
      ...localDraftWorkers.filter((worker) => !productWorkerIds.has(worker.id)),
    ];
  }, [isDesktopRuntime, localWorkerItems, productState]);
  const deviceItems = useMemo(
    () =>
      productState
        ? productState.devices.map((device) =>
            deviceFromProductDevice(productState, device),
          )
        : isDesktopRuntime
          ? []
          : devices,
    [isDesktopRuntime, productState],
  );
  const assignableWorkerItems = useMemo(() => {
    if (!productState) {
      return workerItems;
    }
    const productWorkerIds = new Set(
      productState.workers.map((worker) => worker.id),
    );
    return workerItems.filter((worker) => productWorkerIds.has(worker.id));
  }, [productState, workerItems]);
  const productRunningWorkerIds = useMemo(
    () =>
      new Set(
        productState?.runs
          .filter((run) => run.status === "running")
          .map((run) => run.workerId) ?? [],
      ),
    [productState],
  );
  const activeProductRunKey = useMemo(
    () =>
      productState?.runs
        .filter(
          (run) =>
            run.status === "running" ||
            run.status === "waiting_for_user" ||
            run.status === "blocked",
        )
        .map((run) => run.id)
        .sort()
        .join("|") ?? "",
    [productState],
  );
  const productWorkflowItems = useMemo(
    () =>
      productState
        ? productState.workflows.map((workflow) =>
            workflowSummaryFromProductWorkflow(workflow),
          )
        : null,
    [productState],
  );
  const workflowSourceItems = useMemo(
    () =>
      productWorkflowItems
        ? mergeProductWorkflowSummaries(productWorkflowItems, workflowItems)
        : isDesktopRuntime
          ? []
          : workflowItems,
    [isDesktopRuntime, productWorkflowItems, workflowItems],
  );
  const visibleWorkflowItems = useMemo(() => {
    const deletedIds = new Set(
      productState?.workflowTombstones.map(
        (tombstone) => tombstone.workflowId,
      ) ?? [],
    );
    return workflowSourceItems.filter(
      (workflow) => !deletedIds.has(workflow.id),
    );
  }, [productState, workflowSourceItems]);

  const selectedWorker = useMemo(
    () =>
      workerItems.find((worker) => worker.id === selectedWorkerId) ??
      workerItems[0] ??
      null,
    [selectedWorkerId, workerItems],
  );
  const selectedWorkflow = useMemo(
    () =>
      visibleWorkflowItems.find(
        (workflow) => workflow.id === selectedWorkflowId,
      ) ??
      visibleWorkflowItems[0] ??
      null,
    [selectedWorkflowId, visibleWorkflowItems],
  );
  const activeWorkflowMergeDecision = pendingWorkflowMerges[0] ?? null;
  const versionHistoryWorkflow = useMemo(
    () =>
      versionHistoryWorkflowId
        ? (visibleWorkflowItems.find(
            (workflow) => workflow.id === versionHistoryWorkflowId,
          ) ?? null)
        : null,
    [versionHistoryWorkflowId, visibleWorkflowItems],
  );
  const fullMapWorkflow = useMemo(
    () =>
      fullMapWorkflowId
        ? (visibleWorkflowItems.find(
            (workflow) => workflow.id === fullMapWorkflowId,
          ) ?? null)
        : null,
    [fullMapWorkflowId, visibleWorkflowItems],
  );
  const selectedDevice = useMemo(
    () =>
      deviceItems.find((device) => device.id === selectedDeviceId) ??
      deviceItems[0] ??
      null,
    [deviceItems, selectedDeviceId],
  );
  const workflowPendingDeletion = useMemo(
    () =>
      deleteWorkflowId
        ? (visibleWorkflowItems.find(
            (workflow) => workflow.id === deleteWorkflowId,
          ) ?? null)
        : null,
    [deleteWorkflowId, visibleWorkflowItems],
  );
  const workflowPendingDeletionImpact = useMemo(() => {
    if (!deleteWorkflowId || !productState) {
      return { installedWorkflowCount: 0, hasActiveSession: false };
    }
    const installedWorkflowIds = new Set(
      productState.installedWorkflows
        .filter((workflow) => workflow.workflowId === deleteWorkflowId)
        .map((workflow) => workflow.id),
    );
    return {
      installedWorkflowCount: installedWorkflowIds.size,
      hasActiveSession: productState.runs.some(
        (run) =>
          installedWorkflowIds.has(run.installedWorkflowId) &&
          (run.status === "queued" ||
            run.status === "running" ||
            run.status === "waiting_for_user" ||
            run.status === "blocked"),
      ),
    };
  }, [deleteWorkflowId, productState]);
  const workerPendingDeletion = useMemo(
    () =>
      deleteWorkerId
        ? (workerItems.find((worker) => worker.id === deleteWorkerId) ?? null)
        : null,
    [deleteWorkerId, workerItems],
  );
  const workerPendingDeletionInstalledCount = useMemo(
    () =>
      deleteWorkerId && productState
        ? productState.installedWorkflows.filter(
            (workflow) => workflow.workerId === deleteWorkerId,
          ).length
        : 0,
    [deleteWorkerId, productState],
  );
  const workerPendingDeletionHasActiveSession = useMemo(
    () =>
      Boolean(
        deleteWorkerId &&
        productState?.runs.some(
          (run) =>
            run.workerId === deleteWorkerId &&
            (run.status === "running" ||
              run.status === "waiting_for_user" ||
              run.status === "blocked"),
        ),
      ),
    [deleteWorkerId, productState],
  );
  const displayedWorkers = useMemo(
    () =>
      workerItems.map((worker) => {
        const workerIsRunning =
          runningWorkerIds.has(worker.id) ||
          productRunningWorkerIds.has(worker.id);
        const workerDeployedWorkflow =
          !productState && deployedWorkflow?.workerId === worker.id
            ? deployedWorkflow.workflowTitle
            : null;

        if (
          worker.id === "sales" &&
          (demoTrainingActive ||
            activeTrainingSession ||
            trainingAction !== "idle")
        ) {
          return {
            ...worker,
            heartbeat:
              trainingAction === "stopping"
                ? "Finalizing capture"
                : "Learning desktop activity",
            activities: [
              "Learning session active",
              "Screen context learning active",
              "Finish learning to review the workflow",
            ],
          };
        }

        if (workerIsRunning) {
          return {
            ...worker,
            heartbeat: "Running workflow now",
            activities: [
              `${workerDeployedWorkflow ?? "Installed workflow"} running`,
              "Checking current workflow context",
              "Run events are live",
            ],
          };
        }

        if (workerDeployedWorkflow) {
          return {
            ...worker,
            heartbeat: "Workflow ready to start",
            activities: [
              `${workerDeployedWorkflow} installed`,
              START_WORKER_PREPARATION_MESSAGE,
              "No active task",
            ],
          };
        }

        return worker;
      }),
    [
      activeTrainingSession,
      demoTrainingActive,
      deployedWorkflow,
      productState,
      productRunningWorkerIds,
      runningWorkerIds,
      trainingAction,
      workerItems,
    ],
  );
  const displayedSelectedWorker =
    displayedWorkers.find((worker) => worker.id === selectedWorkerId) ??
    selectedWorker;
  const accountNotifications = useMemo(
    () =>
      buildAccountNotifications({
        productState,
        workers: displayedWorkers,
        devices: deviceItems,
      }),
    [deviceItems, displayedWorkers, productState],
  );
  const accountIdentity = useMemo(
    () =>
      resolveAccountDisplayIdentity(
        cloudAuth.state.user,
        productState?.account ?? null,
      ),
    [cloudAuth.state.user, productState?.account],
  );

  useEffect(() => {
    if (
      !visibleWorkflowItems.some(
        (workflow) => workflow.id === selectedWorkflowId,
      )
    ) {
      setSelectedWorkflowId(visibleWorkflowItems[0]?.id ?? "");
      return;
    }
  }, [selectedWorkflowId, visibleWorkflowItems]);

  useEffect(() => {
    if (isDesktopRuntime && productState === null) {
      return;
    }
    const fallbackWorkerId = workerItems[0]?.id ?? "";
    if (!workerItems.some((worker) => worker.id === selectedWorkerId)) {
      setSelectedWorkerId(fallbackWorkerId);
    }
    if (!workerItems.some((worker) => worker.id === installTargetId)) {
      setInstallTargetId(fallbackWorkerId);
    }
  }, [
    installTargetId,
    isDesktopRuntime,
    productState,
    selectedWorkerId,
    workerItems,
  ]);

  useEffect(() => {
    persistAppLanguage(appLanguage);
    setGeneralLanguageDraft(appLanguage);
    return applyUiLocalization(document.body, appLanguage);
  }, [appLanguage]);

  useEffect(() => {
    if (!startupBlockingSurfaceOpen) {
      return;
    }
    setIsSettingsOpen(false);
    setIsAccountModalOpen(false);
    setAccountUtilityPanel(null);
    setIsWorkerDraftOpen(false);
    setIsDeviceAssignDialogOpen(false);
    setChannelSetupWorkerId(null);
    setVersionHistoryWorkflowId(null);
    setFullMapWorkflowId(null);
  }, [startupBlockingSurfaceOpen]);

  useEffect(() => {
    if (!isDesktopRuntime || startupCheckStartedRef.current) {
      return;
    }

    startupCheckStartedRef.current = true;
    void runStartupRecorderCheck();
  }, [isDesktopRuntime]);

  useEffect(() => {
    void refreshRuntimeState({ announceErrors: false });
    void refreshProductState({ announceErrors: false });
    void loadLlmSettings({ startup: true });
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime || !productState) {
      setPendingWorkflowMerges([]);
      return;
    }
    let active = true;
    void fetchPendingProductWorkflowMerges()
      .then((response) => {
        if (!active) return;
        setPendingWorkflowMerges(
          response.items.filter(
            (item) => !deferredWorkflowMergeHashes.has(item.proposalHash),
          ),
        );
      })
      .catch(() => {
        if (active) setPendingWorkflowMerges([]);
      });
    return () => {
      active = false;
    };
  }, [deferredWorkflowMergeHashes, isDesktopRuntime, productState?.updatedAt]);

  useEffect(() => {
    if (
      !isDesktopRuntime ||
      startupPermissionPhase !== "ready" ||
      productState?.account.setupCompleted !== true ||
      startupRuntimePreparationStartedRef.current ||
      startupRuntimePreparation.phase === "preparing"
    ) {
      return;
    }

    startupRuntimePreparationStartedRef.current = true;
    void runStartupRuntimePreparation();
  }, [
    isDesktopRuntime,
    productState?.account.setupCompleted,
    recorderEnableAudio,
    recorderLanguageDraft,
    startupPermissionPhase,
  ]);

  useSettledPolling({
    enabled: Boolean(activeTrainingSession),
    intervalMs: 5_000,
    restartKey: activeTrainingSession?.sessionId ?? "inactive",
    runImmediately: false,
    poll: async ({ isCurrent }) => {
      if (isCurrent()) {
        await refreshRuntimeState({ announceErrors: false });
      }
    },
  });

  useSettledPolling({
    enabled: Boolean(activeProductRunKey),
    intervalMs: 3_000,
    restartKey: activeProductRunKey ?? "inactive",
    runImmediately: false,
    poll: async ({ isCurrent }) => {
      if (isCurrent()) {
        await refreshProductState({ announceErrors: false });
      }
    },
  });

  useSettledPolling({
    enabled: isDesktopRuntime,
    intervalMs: 15_000,
    restartKey: isDesktopRuntime ? "desktop-visible" : "inactive",
    runImmediately: false,
    poll: async ({ isCurrent }) => {
      if (isCurrent() && document.visibilityState !== "hidden") {
        await refreshProductState({ announceErrors: false });
      }
    },
  });

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }

    const refreshVisibleProductState = () => {
      if (document.visibilityState !== "hidden") {
        void refreshProductState({ announceErrors: false });
      }
    };
    window.addEventListener("focus", refreshVisibleProductState);
    document.addEventListener("visibilitychange", refreshVisibleProductState);
    return () => {
      window.removeEventListener("focus", refreshVisibleProductState);
      document.removeEventListener(
        "visibilitychange",
        refreshVisibleProductState,
      );
    };
  }, [isDesktopRuntime]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useSettledPolling({
    enabled:
      startupPermissionGateOpen &&
      startupPermissionPhase === "blocked" &&
      !permissions?.canStartRecording &&
      requestingPermissionKind === null,
    intervalMs: 1_500,
    restartKey: `${startupPermissionGateOpen}:${startupPermissionPhase}:${String(
      permissions?.canStartRecording ?? false,
    )}:${requestingPermissionKind ?? "idle"}`,
    poll: async ({ isCurrent }) => {
      if (!isCurrent()) {
        return;
      }
      await refreshRecorderPermissions({
        force: true,
        priority: "passive",
        showLoading: false,
      });
    },
  });

  function showToast(message: string) {
    setToast(productizeWorkerFacingText(message));
  }

  function openSettings(section: SettingsSection = "general") {
    setActiveSettingsSection(section);
    setIsSettingsOpen(true);
    if (section === "permissions") {
      void refreshRecorderPermissions({ force: true });
    }
    if (section === "llm" && !llmForm && !llmLoading) {
      void loadLlmSettings();
    }
  }

  async function runStartupRecorderCheck() {
    setStartupPermissionPhase("checking");
    const nextPermissions = await refreshRecorderPermissions({ force: false });
    if (!nextPermissions) {
      setPermissionMode("blocking");
      setStartupPermissionGateOpen(true);
      setStartupPermissionPhase("blocked");
      return;
    }

    if (!nextPermissions.canStartRecording) {
      setPermissionMode("blocking");
      setStartupPermissionGateOpen(true);
      setStartupPermissionPhase("blocked");
      return;
    }

    setPermissionMode(null);
    setStartupPermissionGateOpen(false);
    setStartupPermissionPhase("ready");
  }

  async function handleRefreshStartupPermissions() {
    if (permissionRequestInFlightRef.current) {
      return;
    }
    const nextPermissions = await refreshRecorderPermissions({ force: true });
    if (
      !nextPermissions?.canStartRecording ||
      startupPermissionRestartRequired
    ) {
      setStartupPermissionPhase("blocked");
      return;
    }
    setPermissionMode(null);
    setStartupPermissionGateOpen(false);
    setStartupPermissionPhase("ready");
  }

  function continueAfterStartupPermissions() {
    if (startupPermissionRestartRequired) {
      return;
    }
    setPermissionMode(null);
    setStartupPermissionGateOpen(false);
    setStartupPermissionPhase("ready");
  }

  async function handleQuitAndReopen() {
    if (permissionRequestInFlightRef.current) {
      return;
    }
    setPermissionsError(null);
    try {
      await quitAndReopenDesktopApp();
    } catch (error) {
      setPermissionsError(toErrorMessage(error));
    }
  }

  async function runStartupRuntimePreparation(): Promise<void> {
    const productStateGenerationAtStart = getProductStateGeneration();
    const result = await prepareStartupRuntime({
      enableAudio: recorderEnableAudio,
      ocrLanguagePriority: normalizeRecorderLanguageDraft(
        recorderLanguageDraft,
      ),
    });
    if (
      result?.productState &&
      productStateGenerationAtStart === getProductStateGeneration()
    ) {
      applyProductStateSnapshot(result.productState);
    }
  }

  async function handleRequestRecorderPermission(kind: RecorderPermissionKind) {
    if (permissionRequestInFlightRef.current) {
      return;
    }
    permissionRequestInFlightRef.current = true;
    invalidateRecorderPermissions();
    setRequestingPermissionKind(kind);
    setPermissionsError(null);
    try {
      if (hasDesktopPermissionRequestBridge()) {
        await requestDesktopRecorderPermission(kind);
        setStartupPermissionRestartRequired(true);
      } else if (kind === "microphone" && hasDesktopMicrophoneRequestBridge()) {
        await requestDesktopMicrophoneAccess();
        setStartupPermissionRestartRequired(true);
      }
      await refreshRecorderPermissions({ force: true });
    } catch (error) {
      setPermissionsError(toErrorMessage(error));
    } finally {
      permissionRequestInFlightRef.current = false;
      setRequestingPermissionKind(null);
    }
  }

  function handleRecorderLanguageChange(
    index: number,
    value: RecorderLanguageSlotValue,
  ) {
    setRecorderSettingsFeedback(null);
    setRecorderSettingsError(null);
    setRecorderLanguageDraft((previous) =>
      previous.map((item, itemIndex) => (itemIndex === index ? value : item)),
    );
  }

  function handleResetRecorderSettings() {
    const nextPriority = [...DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY];
    setRecorderLanguageDraft(buildRecorderLanguageDraft(nextPriority));
    setRecorderEnableAudio(DEFAULT_RECORDING_ENABLE_AUDIO);
    setRecorderSettingsError(null);
    setRecorderSettingsFeedback(null);
  }

  function handleSaveRecorderSettings() {
    const priority = normalizeRecorderLanguageDraft(recorderLanguageDraft);
    if (priority.length === 0) {
      setRecorderSettingsError("Choose at least one OCR language.");
      return;
    }
    persistRecorderSettings({
      ocrLanguagePriority: priority,
      enableAudio: recorderEnableAudio,
    });
    setRecorderSettingsError(null);
    setRecorderSettingsFeedback(
      `Learning settings saved. OCR priority: ${formatRecorderLanguageSummary(
        priority,
        appLanguage,
      )}.`,
    );
  }

  function handleSaveGeneralSettings() {
    setAppLanguage(generalLanguageDraft);
    setGeneralSettingsFeedback("General settings saved.");
  }

  async function loadLlmSettings(options: { startup?: boolean } = {}) {
    setLlmLoading(true);
    setLlmError(null);
    llmModelsRequestIdRef.current += 1;
    setLlmModels([]);
    setLlmModelsLoading(false);
    setLlmModelsLoaded(false);
    setLlmModelsError(null);
    try {
      const response = await fetchRuntimeLlmConfig();
      const startupSetupRequired = requiresStartupLlmSetup(response.config);
      const nextForm = buildLlmForm(response.config);
      if (
        options.startup &&
        startupSetupRequired &&
        !response.config.hasStoredApiKey
      ) {
        nextForm.authMode = isLoopbackLlmBaseUrl(response.config.baseUrl)
          ? "none"
          : "direct";
      }
      setLlmForm(nextForm);
      if (options.startup) {
        setStartupLlmSetupRequired(
          startupSetupRequired && !startupLlmSetupCompleted,
        );
        setStartupLlmConnectionReady(
          !startupSetupRequired || startupLlmSetupCompleted,
        );
      }
      setLlmFeedback(null);
    } catch (error) {
      setLlmError(toErrorMessage(error));
    } finally {
      setLlmLoading(false);
    }
  }

  function updateLlmField<K extends keyof LlmFormState>(
    key: K,
    value: LlmFormState[K],
  ) {
    setLlmFeedback(null);
    setLlmError(null);
    setStartupLlmConnectionReady(false);
    if (
      key === "baseUrl" ||
      key === "authMode" ||
      key === "apiKey" ||
      key === "apiKeyEnv"
    ) {
      llmModelsRequestIdRef.current += 1;
      setLlmModels([]);
      setLlmModelsLoading(false);
      setLlmModelsLoaded(false);
      setLlmModelsError(null);
    }
    setLlmForm((current) =>
      current
        ? {
            ...current,
            [key]: value,
          }
        : current,
    );
  }

  function updateLlmCallProfileField<K extends keyof LlmCallProfileFormState>(
    key: LabLlmCallProfileKey,
    field: K,
    value: LlmCallProfileFormState[K],
  ) {
    setLlmFeedback(null);
    setLlmError(null);
    setStartupLlmConnectionReady(false);
    setLlmForm((current) =>
      current
        ? {
            ...current,
            callProfiles: {
              ...current.callProfiles,
              [key]: {
                ...current.callProfiles[key],
                [field]: value,
              },
            },
          }
        : current,
    );
  }

  async function handleSaveLlmSettings() {
    if (!llmForm) {
      return;
    }

    setLlmBusy(true);
    setLlmError(null);
    try {
      const response = await updateRuntimeLlmConfig(
        buildLlmUpdateInput(llmForm),
      );
      setLlmForm(buildLlmForm(response.config));
      setLlmFeedback("Model settings saved.");
    } catch (error) {
      setLlmError(toErrorMessage(error));
    } finally {
      setLlmBusy(false);
    }
  }

  async function handleLoadLlmModels(
    formOverride: LlmFormState | null = llmForm,
  ): Promise<void> {
    if (!formOverride) {
      return;
    }

    const requestId = llmModelsRequestIdRef.current + 1;
    llmModelsRequestIdRef.current = requestId;
    setLlmModelsLoading(true);
    setLlmModelsError(null);
    try {
      const response = await fetchRuntimeLlmModels(
        buildLlmModelsInput(formOverride),
      );
      if (llmModelsRequestIdRef.current !== requestId) {
        return;
      }
      setLlmModels(response.models);
      setLlmModelsLoaded(true);
    } catch (error) {
      if (llmModelsRequestIdRef.current !== requestId) {
        return;
      }
      setLlmModels([]);
      setLlmModelsLoaded(false);
      setLlmModelsError(toErrorMessage(error));
    } finally {
      if (llmModelsRequestIdRef.current === requestId) {
        setLlmModelsLoading(false);
      }
    }
  }

  async function refreshRuntimeState({
    announceErrors,
  }: {
    announceErrors: boolean;
  }) {
    if (DEMO_TRAINING_CAPTURE_ONLY) {
      return;
    }
    if (runtimeRecorderMutationInFlightRef.current) {
      return;
    }
    const activeRefresh = runtimeStateRefreshInFlightRef.current;
    if (activeRefresh) {
      await activeRefresh.catch(() => undefined);
      return;
    }
    const refreshGeneration = runtimeStateRefreshGenerationRef.current;
    const requestId = runtimeStateRefreshRequestIdRef.current + 1;
    runtimeStateRefreshRequestIdRef.current = requestId;

    const refresh = (async () => {
      const [sessions, activeSession] = await Promise.all([
        fetchRuntimeSessions(),
        fetchActiveRecorderSession(),
      ]);
      if (
        refreshGeneration !== runtimeStateRefreshGenerationRef.current ||
        requestId !== runtimeStateRefreshRequestIdRef.current
      ) {
        return;
      }
      const runtimeWorkflows = workflowsFromRuntimeSessions(sessions);
      setWorkflowItems(mergeRuntimeWorkflows(runtimeWorkflows));
      const latestRuntimeWorkflow = runtimeWorkflows[0] ?? null;
      setSelectedWorkflowId((currentWorkflowId) =>
        shouldSelectRuntimeWorkflow(currentWorkflowId, latestRuntimeWorkflow)
          ? latestRuntimeWorkflow.id
          : currentWorkflowId,
      );
      setActiveTrainingSession(activeSession);
    })();
    runtimeStateRefreshInFlightRef.current = refresh;
    try {
      await refresh;
    } catch (error) {
      if (
        announceErrors &&
        refreshGeneration === runtimeStateRefreshGenerationRef.current &&
        requestId === runtimeStateRefreshRequestIdRef.current
      ) {
        showToast(toErrorMessage(error));
      }
    } finally {
      if (runtimeStateRefreshInFlightRef.current === refresh) {
        runtimeStateRefreshInFlightRef.current = null;
      }
    }
  }

  async function refreshProductState({
    announceErrors,
  }: {
    announceErrors: boolean;
  }) {
    const capabilityCheckAtStart = capabilityCheckInFlightRef.current;
    const result = await runProductStateRefresh(fetchProductState, {
      mergeSnapshot: (state, current) =>
        capabilityCheckAtStart && current
          ? {
              ...state,
              capabilityProviders: current.capabilityProviders,
            }
          : state,
      formatError: toErrorMessage,
    });
    if (result.committed && result.snapshot) {
      setRunningWorkerIds(
        new Set(
          result.snapshot.runs
            .filter((run) => run.status === "running")
            .map((run) => run.workerId),
        ),
      );
    }
    if (result.committed && result.error && announceErrors) {
      showToast(toErrorMessage(result.error));
    }
  }

  async function syncPortableProductState(): Promise<void> {
    await cloudAuth.sync("push");
  }

  async function handleCheckCapabilityProvider(
    providerId: ProductCapabilityProviderId,
  ) {
    if (capabilityCheckInFlightRef.current) {
      return;
    }
    capabilityCheckInFlightRef.current = providerId;
    invalidateProductState();
    setCheckingCapabilityProviderId(providerId);
    setCapabilityProviderError(null);
    try {
      const response = await checkProductCapabilityProvider(providerId);
      applyProductStateSnapshot(response.state);
      showToast(
        response.provider.status === "ready"
          ? appLanguage === "zh"
            ? `${response.provider.label} 已可用。`
            : `${response.provider.label} is ready.`
          : (formatChromeCapabilityDetail(response.provider, appLanguage) ??
              (appLanguage === "zh"
                ? `${response.provider.label} 需要处理。`
                : `${response.provider.label} needs attention.`)),
      );
    } catch (error) {
      const message = toErrorMessage(error);
      setCapabilityProviderError(message);
      showToast(message);
    } finally {
      capabilityCheckInFlightRef.current = null;
      setCheckingCapabilityProviderId(null);
    }
  }

  async function handleTestLlmConnection() {
    if (!llmForm) {
      return;
    }

    setIsCheckingLlmProvider(true);
    setLlmProviderError(null);
    setLlmFeedback(null);
    try {
      const response = await fetchRuntimeLlmModels(
        buildLlmModelsInput(llmForm),
      );
      setLlmModels(response.models);
      setLlmModelsLoaded(true);
      setLlmModelsError(null);

      const message =
        appLanguage === "zh"
          ? "连接检测通过。保存更改后才会使用这些设置。"
          : "Connection test passed. Save changes to use these settings.";
      setLlmFeedback(message);
      showToast(message);
    } catch (error) {
      const message = toErrorMessage(error);
      setLlmModels([]);
      setLlmModelsLoaded(false);
      setLlmModelsError(message);
      setLlmProviderError(message);
      showToast(message);
    } finally {
      setIsCheckingLlmProvider(false);
    }
  }

  async function handleCheckLlmProvider({
    saveBeforeCheck,
  }: {
    saveBeforeCheck: boolean;
  }) {
    setIsCheckingLlmProvider(true);
    setLlmProviderError(null);
    try {
      let modelDiscoveryForm = llmForm;
      if (saveBeforeCheck && llmForm) {
        const response = await updateRuntimeLlmConfig(
          buildLlmUpdateInput(llmForm),
        );
        modelDiscoveryForm = buildLlmForm(response.config);
        setLlmForm(modelDiscoveryForm);
      }
      const state = await refreshProductHermes();
      applyProductStateSnapshot(state);
      setRunningWorkerIds(
        new Set(
          state.runs
            .filter((run) => run.status === "running")
            .map((run) => run.workerId),
        ),
      );
      if (isHermesProviderReady(state.hermes)) {
        setStartupLlmConnectionReady(true);
        updateStartupDependencyStatus({
          id: "hermes",
          phase: "ready",
          detail: null,
        });
        setLlmFeedback(
          saveBeforeCheck
            ? appLanguage === "zh"
              ? "模型设置已保存，连接检测通过。"
              : "Model settings saved. Connection test passed."
            : appLanguage === "zh"
              ? "已保存的模型配置连接正常。"
              : "The saved model configuration is ready.",
        );
        showToast(
          appLanguage === "zh"
            ? "LLM 提供方连接正常。"
            : "LLM provider is ready.",
        );
        if (saveBeforeCheck) {
          await handleLoadLlmModels(modelDiscoveryForm);
        }
      } else {
        setStartupLlmConnectionReady(false);
        const message =
          state.hermes.lastError ??
          state.hermes.providerHealth.message ??
          (appLanguage === "zh"
            ? "模型连接不可用，请检查地址、模型和 API Key。"
            : "Model connection is unavailable. Check the endpoint, model, and API key.");
        setLlmProviderError(message);
        updateStartupDependencyStatus({
          id: "hermes",
          phase: "attention",
          detail: message,
        });
        showToast(message);
      }
    } catch (error) {
      setStartupLlmConnectionReady(false);
      const message = toErrorMessage(error);
      setLlmProviderError(message);
      showToast(message);
    } finally {
      setIsCheckingLlmProvider(false);
    }
  }

  function completeStartupLlmSetup() {
    const allRuntimeDependenciesReady =
      startupRuntimePreparation.dependencies.length === 3 &&
      startupRuntimePreparation.dependencies.every(
        (dependency) => dependency.phase === "ready",
      );
    if (!startupLlmConnectionReady || !allRuntimeDependenciesReady) {
      return;
    }
    persistStartupLlmSetupCompleted();
    setStartupLlmSetupCompleted(true);
    setStartupLlmSetupRequired(false);
  }

  async function handleTrainWorker() {
    if (trainingAction !== "idle") {
      return;
    }

    if (DEMO_TRAINING_CAPTURE_ONLY) {
      if (demoTrainingActive) {
        setTrainingAction("stopping");
        showToast("Finishing Learning Mode and preparing the workflow...");
        try {
          await demoDelay(650);
          const captured = createDemoCapturedWorkflow();
          setWorkflowItems((previous) => mergeWorkflowItem(previous, captured));
          setDemoTrainingActive(false);
          setActiveTrainingSession(null);
          setActivePage("workflows");
          setSelectedWorkflowId(captured.id);
          showToast("Learning finished. Review the workflow and install it.");
        } finally {
          setTrainingAction("idle");
        }
        return;
      }

      setTrainingAction("starting");
      try {
        await demoDelay(450);
        setDemoTrainingActive(true);
        showToast("Learning Mode started. Switch apps and work normally.");
      } finally {
        setTrainingAction("idle");
      }
      return;
    }

    if (activeTrainingSession) {
      setTrainingAction("stopping");
      runtimeRecorderMutationInFlightRef.current = true;
      runtimeStateRefreshGenerationRef.current += 1;
      showToast("Finishing Learning Mode and preparing the workflow...");
      try {
        const stopped = await stopRuntimeTraining();
        const workflow = workflowFromGeneratedSession(
          stopped,
          `runtime-${stopped.sessionId}`,
        );
        setWorkflowItems((previous) =>
          mergeWorkflowItem(previous, {
            ...workflow,
            phase: workflow.skill ? workflow.phase : "captured",
            status: workflow.skill ? workflow.status : "Captured",
            tone: workflow.skill ? workflow.tone : "idle",
          }),
        );
        setActiveTrainingSession(null);
        setActivePage("workflows");
        setSelectedWorkflowId(workflow.id);
        await refreshProductState({ announceErrors: false });
        showToast("Learning finished. Review the workflow and install it.");
      } catch (error) {
        showToast(toErrorMessage(error));
      } finally {
        runtimeRecorderMutationInFlightRef.current = false;
        setTrainingAction("idle");
      }
      return;
    }

    setTrainingAction("starting");
    runtimeRecorderMutationInFlightRef.current = true;
    runtimeStateRefreshGenerationRef.current += 1;
    try {
      const started = await startRuntimeTraining({
        enableAudio: recorderEnableAudio,
        ocrLanguagePriority: normalizeRecorderLanguageDraft(
          recorderLanguageDraft,
        ),
      });
      setActiveTrainingSession(started);
      const workflow = workflowFromGeneratedSession(
        started,
        `runtime-${started.sessionId}`,
      );
      setWorkflowItems((previous) => mergeWorkflowItem(previous, workflow));
      showToast("Learning Mode started. Switch apps and work normally.");
    } catch (error) {
      showToast(toErrorMessage(error));
    } finally {
      runtimeRecorderMutationInFlightRef.current = false;
      setTrainingAction("idle");
    }
  }

  async function extractDiscoveredWorkflow(input: {
    workflowItemId: string;
    sessionId: string;
    workflowPath: string;
    workflowId: string;
  }) {
    const progressPolling = startSettledPolling({
      intervalMs: 750,
      poll: async ({ isCurrent }) => {
        const session = await fetchRuntimeSession(input.sessionId);
        if (!isCurrent()) {
          return;
        }
        setGenerationProgress({
          workflowId: input.workflowItemId,
          progress: session.generationProgress,
        });
      },
    });
    setWorkflowItems((previous) =>
      previous.map((item) =>
        item.id === input.workflowItemId
          ? {
              ...item,
              phase: "generating",
              status: "Analyzing",
              tone: "working",
              errorMessage: null,
              requiresWorkflowSelection: false,
            }
          : item,
      ),
    );

    try {
      const extracted = await extractRuntimeWorkflowLogic({
        sessionId: input.sessionId,
        workflowPath: input.workflowPath,
        workflowId: input.workflowId,
      });
      setGenerationProgress({
        workflowId: input.workflowItemId,
        progress: extracted.generationProgress,
      });

      const generated = workflowFromGeneratedSession(
        extracted,
        input.workflowItemId,
      );
      setWorkflowItems((previous) => mergeWorkflowItem(previous, generated));
      setSelectedWorkflowId(generated.id);
      await refreshProductState({ announceErrors: false });
      showToast(
        appLanguage === "zh"
          ? "Workflow 草稿已生成。"
          : "Workflow draft is ready.",
      );
    } catch (error) {
      const message = toErrorMessage(error);
      setWorkflowItems((previous) =>
        previous.map((item) =>
          item.id === input.workflowItemId
            ? {
                ...item,
                phase: "failed",
                status: "Review needed",
                tone: "danger",
                errorMessage: message,
              }
            : item,
        ),
      );
      showToast(message);
    } finally {
      progressPolling.stop();
      setGenerationProgress(null);
    }
  }

  function openWorkflowSelection(workflowId: string) {
    const workflow = workflowItems.find((item) => item.id === workflowId);
    const candidates = workflow?.workflowCandidates ?? [];
    const recommended = selectPreferredWorkflowCandidate(candidates);
    if (
      !workflow?.sessionId ||
      !workflow.workflowPath ||
      candidates.length < 2 ||
      !recommended
    ) {
      return;
    }
    setWorkflowSelectionRequest({
      workflowItemId: workflow.id,
      sessionId: workflow.sessionId,
      workflowPath: workflow.workflowPath,
      candidates,
      recommendedWorkflowId: recommended.workflowId,
    });
  }

  function handleConfirmWorkflowSelection(workflowId: string) {
    const request = workflowSelectionRequest;
    if (
      !request ||
      !request.candidates.some(
        (candidate) => candidate.workflowId === workflowId,
      )
    ) {
      return;
    }
    setWorkflowSelectionRequest(null);
    void extractDiscoveredWorkflow({
      workflowItemId: request.workflowItemId,
      sessionId: request.sessionId,
      workflowPath: request.workflowPath,
      workflowId,
    });
  }

  async function handleGenerateWorkflow(workflowId: string) {
    const workflow = workflowItems.find((item) => item.id === workflowId);
    if (!workflow?.sessionId) {
      showToast("This sample workflow is already ready to review.");
      return;
    }

    if (workflow.sessionId === DEMO_CAPTURED_SESSION_ID) {
      setWorkflowItems((previous) =>
        previous.map((item) =>
          item.id === workflowId
            ? {
                ...item,
                phase: "generating",
                status: "Analyzing",
                tone: "working",
                errorMessage: null,
              }
            : item,
        ),
      );

      try {
        await demoDelay(900);
        await demoDelay(1100);
        await demoDelay(1000);
        await demoDelay(500);

        const generated = createDemoGeneratedWorkflow(workflowId);
        setWorkflowItems((previous) => mergeWorkflowItem(previous, generated));
        setSelectedWorkflowId(generated.id);
        showToast("Workflow draft is ready.");
      } finally {
        setGenerationProgress(null);
      }
      return;
    }

    const progressPolling = startSettledPolling({
      intervalMs: 750,
      poll: async ({ isCurrent }) => {
        const session = await fetchRuntimeSession(workflow.sessionId!);
        if (!isCurrent()) {
          return;
        }
        if (session.generationProgress) {
          setGenerationProgress({
            workflowId,
            progress: session.generationProgress,
          });
        }
      },
    });
    setWorkflowItems((previous) =>
      previous.map((item) =>
        item.id === workflowId
          ? {
              ...item,
              phase: "generating",
              status: "Analyzing",
              tone: "working",
              errorMessage: null,
            }
          : item,
      ),
    );

    try {
      const discovered = await discoverRuntimeWorkflow(workflow.sessionId);
      const candidate = selectWorkflowCandidate(discovered);
      const workflowPath =
        discovered.selection.workflowPath ??
        discovered.workflowDiscovery.latestPath;
      if (!candidate || !workflowPath) {
        throw new Error(
          appLanguage === "zh"
            ? "Workflow 检测已完成，但没有可供选择的候选项。"
            : "Workflow discovery finished without a selectable workflow candidate.",
        );
      }

      if (discovered.generationProgress) {
        setGenerationProgress({
          workflowId,
          progress: discovered.generationProgress,
        });
      }

      if (discovered.workflowDiscovery.workflowCandidates.length > 1) {
        const discoveredWorkflow = workflowFromGeneratedSession(
          discovered,
          workflowId,
        );
        setWorkflowItems((previous) =>
          mergeWorkflowItem(previous, discoveredWorkflow),
        );
        setSelectedWorkflowId(discoveredWorkflow.id);
        setWorkflowSelectionRequest({
          workflowItemId: workflowId,
          sessionId: workflow.sessionId,
          workflowPath,
          candidates: discovered.workflowDiscovery.workflowCandidates,
          recommendedWorkflowId: candidate.workflowId,
        });
        showToast(
          appLanguage === "zh"
            ? `检测到 ${discovered.workflowDiscovery.workflowCandidates.length} 个 Workflow，请选择要生成的一个。`
            : `${discovered.workflowDiscovery.workflowCandidates.length} workflows detected. Choose one to generate.`,
        );
        return;
      }

      progressPolling.stop();
      setGenerationProgress(null);
      await extractDiscoveredWorkflow({
        workflowItemId: workflowId,
        sessionId: workflow.sessionId,
        workflowPath,
        workflowId: candidate.workflowId,
      });
    } catch (error) {
      const message = toErrorMessage(error);
      setWorkflowItems((previous) =>
        previous.map((item) =>
          item.id === workflowId
            ? {
                ...item,
                phase: "failed",
                status: "Review needed",
                tone: "danger",
                errorMessage: message,
              }
            : item,
        ),
      );
      showToast(message);
    } finally {
      progressPolling.stop();
      setGenerationProgress(null);
    }
  }

  async function handleCreateWorkerDraft(input: WorkerDraftInput) {
    try {
      const response = await createProductWorker({ ...input, mode: "new" });
      applyProductStateSnapshot(response.state);
      await syncPortableProductState();
      setSelectedWorkerId(response.worker.id);
      setInstallTargetId(response.worker.id);
      setActivePage("workers");
      setIsWorkerDraftOpen(false);
      showToast(`${response.worker.name} setup created.`);
      if (input.channel.testAfterCreate && input.channel.platform !== "none") {
        const testResponse = await testProductWorkerChannel(response.worker.id);
        applyProductStateSnapshot(testResponse.state);
        showToast(channelTestToast(testResponse.channel));
      }
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleAssignDevice(input: {
    workerId: string;
    deviceId: string;
  }) {
    try {
      const response = await assignProductDevice(input);
      applyProductStateSnapshot(response.state);
      setSelectedWorkerId(response.worker.id);
      setSelectedDeviceId(response.device.id);
      setIsDeviceAssignDialogOpen(false);
      showToast(`${response.worker.name} assigned to ${response.device.name}.`);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  function handleExportDeviceReport() {
    const report = buildDeviceReport({
      devices: deviceItems,
      workers: workerItems,
    });
    if (typeof URL.createObjectURL !== "function") {
      showToast("Device health report prepared.");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([report], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "oysterworkflow-device-report.txt";
    link.click();
    URL.revokeObjectURL(url);
    showToast("Device health report exported.");
  }

  async function handleInstallWorkflow() {
    if (!selectedWorkflow) {
      showToast(
        appLanguage === "zh"
          ? "请先创建并选择一个工作流。"
          : "Create and select a workflow before deploying.",
      );
      return;
    }
    const targetWorker = workerItems.find(
      (worker) => worker.id === installTargetId,
    );
    if (!targetWorker) {
      showToast(
        appLanguage === "zh"
          ? "请先创建并选择一个 AI Worker。"
          : "Create and select an AI worker before deploying.",
      );
      return;
    }
    const targetWorkerId = targetWorker.id;
    try {
      const response = await installProductWorkflow({
        workerId: targetWorkerId,
        workflowId: selectedWorkflow.id,
        workflowTitle: selectedWorkflow.title,
        description: selectedWorkflow.description,
        apps: selectedWorkflow.connectedApps,
        skillPath: selectedWorkflow.skillPath,
      });
      applyProductStateSnapshot(response.state);
      setDeployedWorkflow({
        workerId: targetWorkerId,
        workflowId: selectedWorkflow.id,
        workflowTitle: selectedWorkflow.title,
        description: selectedWorkflow.description,
        apps: selectedWorkflow.connectedApps,
      });
      setRunningWorkerIds((previous) => {
        const next = new Set(previous);
        next.delete(targetWorkerId);
        return next;
      });
      setSelectedWorkerId(targetWorkerId);
      setActivePage("workers");
      showToast(`${selectedWorkflow.title} deployed to ${targetWorker.name}.`);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleToggleWorkerRun(workerId: string) {
    try {
      const workerIsRunning =
        runningWorkerIds.has(workerId) || productRunningWorkerIds.has(workerId);
      const nextState = workerIsRunning
        ? await stopProductWorker(workerId)
        : await startProductWorker(workerId);
      applyProductStateSnapshot(nextState);
      setRunningWorkerIds(
        new Set(
          nextState.runs
            .filter((run) => run.status === "running")
            .map((run) => run.workerId),
        ),
      );
      const latestRun = nextState.runs.find((run) => run.workerId === workerId);
      if (latestRun?.status === "failed" && latestRun.errorMessage) {
        showToast(latestRun.errorMessage);
        return;
      }
      showToast(workerIsRunning ? "Worker stopped." : "AI worker ready.");
    } catch (error) {
      showToast(toErrorMessage(error));
      await refreshProductState({ announceErrors: false });
    }
  }

  async function handleRunInstalledWorkflow(installedWorkflowId: string) {
    try {
      const response = await runProductInstalledWorkflow(installedWorkflowId);
      applyProductStateSnapshot(response.state);
      setRunningWorkerIds(
        new Set(
          response.state.runs
            .filter((run) => run.status === "running")
            .map((run) => run.workerId),
        ),
      );
      setSelectedWorkerId(response.run.workerId);
      setWorkerTabRequest({
        workerId: response.run.workerId,
        tab: "agent",
        requestId: Date.now(),
      });
      showToast(`${response.run.workflowTitle} started.`);
    } catch (error) {
      showToast(toErrorMessage(error));
      await refreshProductState({ announceErrors: false });
    }
  }

  function handleOpenWorkerFromDevice(workerId: string) {
    setSelectedWorkerId(workerId);
    setWorkerTabRequest({
      workerId,
      tab: "agent",
      requestId: Date.now(),
    });
    setActivePage("workers");
  }

  async function handleSendWorkerCommand(workerId: string, command: string) {
    try {
      const response = await sendProductWorkerCommand({ workerId, command });
      applyProductStateSnapshot(response.state);
    } catch (error) {
      showToast(toErrorMessage(error));
      await refreshProductState({ announceErrors: false });
    }
  }

  async function handleInstalledWorkflowStatusChange(
    workflowId: string,
    status: InstalledWorkflowStatus,
  ) {
    try {
      const nextState = await updateProductInstalledWorkflowStatus({
        installedWorkflowId: workflowId,
        status,
      });
      applyProductStateSnapshot(nextState);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleInstalledWorkflowRemove(workflowId: string) {
    try {
      const response = await deleteProductInstalledWorkflow(workflowId);
      applyProductStateSnapshot(response.state);
      setDeployedWorkflow((current) =>
        current?.workflowId === response.installedWorkflow.workflowId &&
        current.workerId === response.installedWorkflow.workerId
          ? null
          : current,
      );
      showToast(`${response.installedWorkflow.workflowTitle} removed.`);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleAccountSetup(input: {
    name: string;
    email: string;
    workspaceName: string;
  }) {
    try {
      const nextState = await setupProductAccount(input);
      applyProductStateSnapshot(nextState);
      setIsAccountModalOpen(false);
      showToast("Account saved.");
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleWorkerConfigSave(
    workerId: string,
    config: ProductWorkerConfigInput,
  ) {
    try {
      const response = await updateProductWorkerConfig({ workerId, config });
      applyProductStateSnapshot(response.state);
      await syncPortableProductState();
      showToast(`${response.worker.name} setup saved.`);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  async function handleConfirmDeleteWorker() {
    if (!deleteWorkerId) {
      return;
    }
    const workerToDelete = workerItems.find(
      (worker) => worker.id === deleteWorkerId,
    );
    if (!workerToDelete) {
      setDeleteWorkerId(null);
      return;
    }
    const remainingWorkers = workerItems.filter(
      (worker) => worker.id !== workerToDelete.id,
    );
    const deletedIndex = workerItems.findIndex(
      (worker) => worker.id === workerToDelete.id,
    );
    const fallbackWorker =
      remainingWorkers[Math.min(deletedIndex, remainingWorkers.length - 1)] ??
      remainingWorkers[0];

    try {
      const response = await deleteProductWorker(workerToDelete.id);
      applyProductStateSnapshot(response.state);
      setRunningWorkerIds((previous) => {
        const next = new Set(previous);
        next.delete(workerToDelete.id);
        return next;
      });
      setDeployedWorkflow((current) =>
        current?.workerId === workerToDelete.id ? null : current,
      );
      setSelectedWorkerId(fallbackWorker?.id ?? "");
      if (installTargetId === workerToDelete.id) {
        setInstallTargetId(fallbackWorker?.id ?? "");
      }
      setDeleteWorkerId(null);
      await syncPortableProductState();
      showToast(
        appLanguage === "zh"
          ? `${workerToDelete.name} 已删除。`
          : `${workerToDelete.name} deleted.`,
      );
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  function handleRequestDeleteWorkflow(workflowId: string) {
    setDeleteWorkflowId(workflowId);
  }

  async function handleConfirmDeleteWorkflow() {
    if (!deleteWorkflowId) {
      return;
    }

    const workflowToDelete = visibleWorkflowItems.find(
      (workflow) => workflow.id === deleteWorkflowId,
    );
    if (!workflowToDelete) {
      setDeleteWorkflowId(null);
      return;
    }

    const nextVisibleWorkflows = visibleWorkflowItems.filter(
      (workflow) => workflow.id !== deleteWorkflowId,
    );
    const deletedIndex = visibleWorkflowItems.findIndex(
      (workflow) => workflow.id === deleteWorkflowId,
    );
    const fallbackWorkflow =
      nextVisibleWorkflows[
        Math.min(deletedIndex, nextVisibleWorkflows.length - 1)
      ] ?? nextVisibleWorkflows[0];

    try {
      const response = await deleteProductWorkflow({
        workflowId: workflowToDelete.id,
        workflowTitle: workflowToDelete.title,
      });
      applyProductStateSnapshot(response.state);
      setWorkflowItems((previous) =>
        previous.filter((workflow) => workflow.id !== workflowToDelete.id),
      );
      if (selectedWorkflowId === deleteWorkflowId) {
        setSelectedWorkflowId(fallbackWorkflow?.id ?? "");
        setVersionHistoryWorkflowId(null);
        setFullMapWorkflowId(null);
      }
      if (generationProgress?.workflowId === deleteWorkflowId) {
        setGenerationProgress(null);
      }
      setDeleteWorkflowId(null);
      showToast(`${workflowToDelete.title} deleted.`);
    } catch (error) {
      showToast(toErrorMessage(error));
    }
  }

  function dismissActiveWorkflowMergeDecision() {
    if (!activeWorkflowMergeDecision) return;
    setDeferredWorkflowMergeHashes((previous) => {
      const next = new Set(previous);
      next.add(activeWorkflowMergeDecision.proposalHash);
      return next;
    });
    setPendingWorkflowMerges((previous) => previous.slice(1));
    setWorkflowMergeError(null);
  }

  async function handleKeepWorkflowAsNew() {
    if (!activeWorkflowMergeDecision || isWorkflowMergeSubmitting) return;
    setIsWorkflowMergeSubmitting(true);
    setWorkflowMergeError(null);
    try {
      const response = await keepProductWorkflowAsNew(
        activeWorkflowMergeDecision.sourceWorkflowId,
      );
      applyProductStateSnapshot(response.state);
      setPendingWorkflowMerges((previous) => previous.slice(1));
      setSelectedWorkflowId(activeWorkflowMergeDecision.sourceWorkflowId);
      showToast(
        appLanguage === "zh"
          ? "已创建为独立工作流。"
          : "Created as a separate workflow.",
      );
    } catch (error) {
      setWorkflowMergeError(toErrorMessage(error));
    } finally {
      setIsWorkflowMergeSubmitting(false);
    }
  }

  async function handleMergeWorkflow(targetWorkflowId: string) {
    if (!activeWorkflowMergeDecision || isWorkflowMergeSubmitting) return;
    setIsWorkflowMergeSubmitting(true);
    setWorkflowMergeError(null);
    try {
      const sourceWorkflowId = activeWorkflowMergeDecision.sourceWorkflowId;
      const response = await applyProductWorkflowMergeProposal(
        sourceWorkflowId,
        targetWorkflowId,
      );
      applyProductStateSnapshot(response.state);
      setWorkflowItems((previous) => {
        const target = previous.find(
          (workflow) => workflow.id === targetWorkflowId,
        );
        const remaining = previous.filter(
          (workflow) =>
            workflow.id !== sourceWorkflowId &&
            workflow.id !== targetWorkflowId,
        );
        return target ? [target, ...remaining] : remaining;
      });
      setPendingWorkflowMerges((previous) => previous.slice(1));
      setSelectedWorkflowId(targetWorkflowId);
      setActivePage("workflows");
      showToast(
        appLanguage === "zh"
          ? "已合并。原卡片已收起，更新后的工作流已置顶。"
          : "Merged. The source card was removed and the updated workflow moved to the top.",
      );
    } catch (error) {
      setWorkflowMergeError(toErrorMessage(error));
    } finally {
      setIsWorkflowMergeSubmitting(false);
    }
  }

  function handleWorkflowVersionRestored(
    state: ProductStateSnapshot,
    workflowId: string,
  ) {
    applyProductStateSnapshot(state);
    setSelectedWorkflowId(workflowId);
    setWorkflowItems((previous) => {
      const workflow = previous.find((item) => item.id === workflowId);
      return workflow
        ? [workflow, ...previous.filter((item) => item.id !== workflowId)]
        : previous;
    });
    showToast(
      appLanguage === "zh"
        ? "历史版本已恢复为新的当前版本。"
        : "The historical version is now a new current version.",
    );
  }

  return (
    <div className="demo-shell">
      <Sidebar
        activePage={activePage}
        accountIdentity={accountIdentity}
        onNavigate={setActivePage}
        onOpenAccount={() => setIsAccountModalOpen(true)}
        onOpenSettings={() => openSettings("general")}
        onOpenUtility={setAccountUtilityPanel}
      />
      <main className="demo-main">
        {activePage === "workers" && displayedSelectedWorker ? (
          <WorkersPage
            appLanguage={appLanguage}
            workers={displayedWorkers}
            selectedWorker={displayedSelectedWorker}
            onSelectWorker={setSelectedWorkerId}
            onTrain={handleTrainWorker}
            onAssignDevice={() => setActivePage("devices")}
            onOpenWorkerDraft={() => setIsWorkerDraftOpen(true)}
            onAction={showToast}
            deployedWorkflow={productState ? null : deployedWorkflow}
            runningWorkerIds={runningWorkerIds}
            onToggleWorkerRun={handleToggleWorkerRun}
            onRunInstalledWorkflow={handleRunInstalledWorkflow}
            onSendWorkerCommand={handleSendWorkerCommand}
            onInstalledWorkflowStatusChange={
              handleInstalledWorkflowStatusChange
            }
            onInstalledWorkflowRemove={handleInstalledWorkflowRemove}
            onWorkerConfigSave={handleWorkerConfigSave}
            onDeleteWorker={setDeleteWorkerId}
            onOpenChannelSetup={setChannelSetupWorkerId}
            workerTabRequest={workerTabRequest}
            trainingAction={trainingAction}
            isTraining={demoTrainingActive || Boolean(activeTrainingSession)}
            productState={productState}
            isProductStateLoading={isDesktopRuntime && productState === null}
            checkingCapabilityProviderId={checkingCapabilityProviderId}
            capabilityProviderError={capabilityProviderError}
            isCheckingLlmProvider={isCheckingLlmProvider}
            llmProviderError={llmProviderError}
            onCheckCapabilityProvider={handleCheckCapabilityProvider}
            onCheckLlmProvider={() =>
              handleCheckLlmProvider({ saveBeforeCheck: false })
            }
          />
        ) : null}
        {activePage === "workers" && !displayedSelectedWorker ? (
          <WorkersEmptyState
            language={appLanguage}
            isLoading={
              isDesktopRuntime && productState === null && !productStateError
            }
            errorMessage={productStateError}
            onRetry={() => {
              void refreshProductState({ announceErrors: true });
            }}
            onCreate={() => setIsWorkerDraftOpen(true)}
          />
        ) : null}
        {activePage === "workflows" && selectedWorkflow ? (
          <WorkflowsPage
            workers={workerItems}
            workflows={visibleWorkflowItems}
            selectedWorkflow={selectedWorkflow}
            appLanguage={appLanguage}
            installTargetId={installTargetId}
            generationProgress={generationProgress}
            onSelectWorkflow={setSelectedWorkflowId}
            onInstallTargetChange={setInstallTargetId}
            onOpenVersionHistory={() =>
              setVersionHistoryWorkflowId(selectedWorkflow.id)
            }
            onOpenFullMap={() => setFullMapWorkflowId(selectedWorkflow.id)}
            onGenerateWorkflow={handleGenerateWorkflow}
            onChooseWorkflow={openWorkflowSelection}
            onInstallWorkflow={handleInstallWorkflow}
            onDeleteWorkflow={handleRequestDeleteWorkflow}
          />
        ) : null}
        {activePage === "workflows" && !selectedWorkflow ? (
          <WorkflowsEmptyState
            language={appLanguage}
            isLoading={
              isDesktopRuntime && productState === null && !productStateError
            }
            errorMessage={productStateError}
            onRetry={() => {
              void refreshProductState({ announceErrors: true });
            }}
          />
        ) : null}
        {activePage === "devices" && selectedDevice ? (
          <DevicesPage
            devices={deviceItems}
            workers={assignableWorkerItems}
            selectedDevice={selectedDevice}
            onSelectDevice={setSelectedDeviceId}
            onOpenAssignDevice={() => setIsDeviceAssignDialogOpen(true)}
            onExportReport={handleExportDeviceReport}
            onOpenWorker={handleOpenWorkerFromDevice}
          />
        ) : null}
        {activePage === "devices" && !selectedDevice ? (
          <DevicesEmptyState
            language={appLanguage}
            isLoading={
              isDesktopRuntime && productState === null && !productStateError
            }
            errorMessage={productStateError}
            onRetry={() => {
              void refreshProductState({ announceErrors: true });
            }}
          />
        ) : null}
      </main>

      {workflowSelectionRequest ? (
        <WorkflowSelectionDialog
          key={`${workflowSelectionRequest.sessionId}:${workflowSelectionRequest.workflowPath}`}
          language={appLanguage}
          candidates={workflowSelectionRequest.candidates}
          recommendedWorkflowId={workflowSelectionRequest.recommendedWorkflowId}
          onClose={() => setWorkflowSelectionRequest(null)}
          onConfirm={handleConfirmWorkflowSelection}
        />
      ) : null}

      {workflowPendingDeletion ? (
        <WorkflowDeleteDialog
          language={appLanguage}
          workflow={workflowPendingDeletion}
          installedWorkflowCount={
            workflowPendingDeletionImpact.installedWorkflowCount
          }
          hasActiveSession={workflowPendingDeletionImpact.hasActiveSession}
          onCancel={() => setDeleteWorkflowId(null)}
          onConfirm={handleConfirmDeleteWorkflow}
        />
      ) : null}

      {!startupBlockingSurfaceOpen && activeWorkflowMergeDecision ? (
        <WorkflowMergeDecisionDialog
          key={activeWorkflowMergeDecision.proposalHash}
          language={appLanguage}
          decision={activeWorkflowMergeDecision}
          isSubmitting={isWorkflowMergeSubmitting}
          errorMessage={workflowMergeError}
          onCreateNew={() => void handleKeepWorkflowAsNew()}
          onMerge={(targetWorkflowId) =>
            void handleMergeWorkflow(targetWorkflowId)
          }
          onClose={dismissActiveWorkflowMergeDecision}
        />
      ) : null}

      {versionHistoryWorkflow ? (
        <WorkflowVersionHistoryDialog
          language={appLanguage}
          workflowId={versionHistoryWorkflow.id}
          workflowTitle={versionHistoryWorkflow.title}
          onRestored={handleWorkflowVersionRestored}
          onClose={() => setVersionHistoryWorkflowId(null)}
        />
      ) : null}

      {fullMapWorkflow ? (
        <WorkflowGraphModal
          workflow={fullMapWorkflow}
          language={appLanguage}
          onClose={() => setFullMapWorkflowId(null)}
          onGraphSaved={(response) => {
            applyProductStateSnapshot(response.state);
            showToast(
              appLanguage === "zh"
                ? `已保存 Graph 修订 ${response.canonicalGraph.revision.number}。`
                : `Graph revision ${response.canonicalGraph.revision.number} saved.`,
            );
          }}
        />
      ) : null}

      {workerPendingDeletion ? (
        <WorkerDeleteDialog
          language={appLanguage}
          worker={workerPendingDeletion}
          installedWorkflowCount={workerPendingDeletionInstalledCount}
          hasActiveSession={workerPendingDeletionHasActiveSession}
          onCancel={() => setDeleteWorkerId(null)}
          onConfirm={handleConfirmDeleteWorker}
        />
      ) : null}

      {isWorkerDraftOpen ? (
        <WorkerDraftDialog
          onCancel={() => setIsWorkerDraftOpen(false)}
          onCreate={handleCreateWorkerDraft}
        />
      ) : null}

      {isDeviceAssignDialogOpen && selectedDevice ? (
        <DeviceAssignDialog
          devices={deviceItems}
          workers={assignableWorkerItems}
          initialDeviceId={selectedDevice.id}
          initialWorkerId={
            assignableWorkerItems.some(
              (worker) => worker.id === selectedWorkerId,
            )
              ? selectedWorkerId
              : assignableWorkerItems[0]?.id
          }
          onCancel={() => setIsDeviceAssignDialogOpen(false)}
          onAssign={handleAssignDevice}
        />
      ) : null}

      {channelSetupWorkerId ? (
        <WorkerChannelSetupDialog
          language={appLanguage}
          worker={
            productState?.workers.find(
              (worker) => worker.id === channelSetupWorkerId,
            ) ?? null
          }
          productState={productState}
          onCancel={() => setChannelSetupWorkerId(null)}
          onStateChange={(state) => {
            applyProductStateSnapshot(state);
          }}
        />
      ) : null}

      {accountSetupDialogOpen ? (
        <AccountSetupDialog
          account={productState?.account ?? null}
          cloudEmail={cloudAuth.state.user?.email ?? null}
          cloudDisplayName={cloudAuth.state.user?.displayName ?? null}
          workspaceName={productState?.workspace.name ?? "OysterWorkflow"}
          canClose={Boolean(productState?.account.setupCompleted)}
          onCancel={() => setIsAccountModalOpen(false)}
          onSave={handleAccountSetup}
          onSignOut={async () => {
            setIsAccountModalOpen(false);
            await cloudAuth.signOut();
          }}
        />
      ) : null}

      {accountUtilityPanel ? (
        <AccountUtilityDialog
          panel={accountUtilityPanel}
          accountIdentity={accountIdentity}
          workspaceName={productState?.workspace.name ?? "OysterWorkflow"}
          notifications={accountNotifications}
          onClose={() => setAccountUtilityPanel(null)}
          onOpenAccountSettings={() => {
            setAccountUtilityPanel(null);
            setIsAccountModalOpen(true);
          }}
        />
      ) : null}

      <SettingsModal
        open={isSettingsOpen && !startupBlockingSurfaceOpen}
        language={appLanguage}
        activeSection={activeSettingsSection}
        isDesktopRuntime={isDesktopRuntime}
        runtimePlatform={runtimeBridgeInfo.platform}
        busy={llmBusy || permissionsLoading}
        onSectionChange={(section) => {
          setActiveSettingsSection(section);
          if (section === "permissions") {
            void refreshRecorderPermissions({ force: true });
          }
          if (section === "llm" && !llmForm && !llmLoading) {
            void loadLlmSettings();
          }
          if (section === "applications") {
            setCapabilityProviderError(null);
          }
        }}
        onClose={() => setIsSettingsOpen(false)}
        general={{
          draft: generalLanguageDraft,
          feedback: generalSettingsFeedback,
          onChange: (value) => {
            setGeneralLanguageDraft(value);
            setGeneralSettingsFeedback(null);
          },
          onSave: handleSaveGeneralSettings,
        }}
        recorder={{
          draft: recorderLanguageDraft,
          enableAudio: recorderEnableAudio,
          errorMessage: recorderSettingsError,
          feedback: recorderSettingsFeedback,
          onChange: handleRecorderLanguageChange,
          onEnableAudioChange: (value) => {
            setRecorderEnableAudio(value);
            setRecorderSettingsFeedback(null);
            setRecorderSettingsError(null);
          },
          onReset: handleResetRecorderSettings,
          onSave: handleSaveRecorderSettings,
        }}
        permissions={{
          mode: permissionMode,
          permissions,
          loading: permissionsLoading,
          errorMessage: permissionsError,
          requestingKind: requestingPermissionKind,
          onRefresh: () => {
            void refreshRecorderPermissions({ force: true });
          },
          onRequestPermission: (kind) => {
            void handleRequestRecorderPermission(kind);
          },
        }}
        applications={{
          providers: productState?.capabilityProviders ?? [],
          checkingProviderId: checkingCapabilityProviderId,
          errorMessage: capabilityProviderError,
          onCheckProvider: (providerId) => {
            void handleCheckCapabilityProvider(providerId);
          },
        }}
        updates={{
          snapshot: desktopUpdate.snapshot,
          onCheck: () => {
            void desktopUpdate.check();
          },
          onDownload: () => {
            void desktopUpdate.download();
          },
          onInstall: () => {
            void desktopUpdate.install();
          },
        }}
        llm={{
          form: llmForm,
          startupSetup: false,
          runtimePreparation: startupRuntimePreparation,
          loading: llmLoading,
          errorMessage: llmError,
          feedback: llmFeedback,
          busy: llmBusy,
          availableModels: llmModels,
          modelsLoading: llmModelsLoading,
          modelsLoaded: llmModelsLoaded,
          modelsError: llmModelsError,
          checkingConnection: isCheckingLlmProvider,
          connectionError: llmProviderError,
          onRetry: loadLlmSettings,
          onRetryRuntimePreparation: runStartupRuntimePreparation,
          onLoadModels: handleLoadLlmModels,
          onCheckConnection: handleTestLlmConnection,
          onUpdateField: updateLlmField,
          onUpdateCallProfileField: updateLlmCallProfileField,
          onSave: handleSaveLlmSettings,
        }}
      />

      <StartupLlmSetupModal
        open={startupWorkspaceGateOpen}
        language={appLanguage}
        onContinue={completeStartupLlmSetup}
        llm={{
          form: llmForm,
          startupConnectionReady: startupLlmConnectionReady,
          runtimePreparation: startupRuntimePreparation,
          loading: llmLoading,
          errorMessage: llmError,
          feedback: llmFeedback,
          busy: llmBusy,
          availableModels: llmModels,
          modelsLoading: llmModelsLoading,
          modelsLoaded: llmModelsLoaded,
          modelsError: llmModelsError,
          checkingConnection: isCheckingLlmProvider,
          connectionError: llmProviderError,
          onRetry: loadLlmSettings,
          onRetryRuntimePreparation: runStartupRuntimePreparation,
          onLoadModels: handleLoadLlmModels,
          onCheckConnection: () =>
            handleCheckLlmProvider({ saveBeforeCheck: true }),
          onUpdateField: updateLlmField,
          onUpdateCallProfileField: updateLlmCallProfileField,
          onSave: handleSaveLlmSettings,
        }}
      />

      <StartupPermissionGate
        open={startupPermissionGateOpen}
        language={appLanguage}
        permissions={permissions}
        loading={permissionsLoading}
        errorMessage={permissionsError}
        requestingKind={requestingPermissionKind}
        allGranted={Boolean(
          permissions?.canStartRecording && !startupPermissionRestartRequired,
        )}
        canQuitAndReopen={hasDesktopQuitAndReopenBridge()}
        onContinue={continueAfterStartupPermissions}
        onRefresh={() => {
          void handleRefreshStartupPermissions();
        }}
        onQuitAndReopen={() => {
          void handleQuitAndReopen();
        }}
        onRequestPermission={(kind) => {
          void handleRequestRecorderPermission(kind);
        }}
      />

      {toast ? (
        <div className="demo-toast" role="status" aria-live="polite">
          {toast}
        </div>
      ) : null}
    </div>
  );
}

interface SidebarProps {
  activePage: PageId;
  accountIdentity: AccountDisplayIdentity;
  onNavigate: (page: PageId) => void;
  onOpenAccount: () => void;
  onOpenSettings: () => void;
  onOpenUtility: (panel: AccountUtilityPanel) => void;
}

function Sidebar({
  activePage,
  accountIdentity,
  onNavigate,
  onOpenAccount,
  onOpenSettings,
  onOpenUtility,
}: SidebarProps) {
  const items: Array<{ id: PageId; label: string; icon: IconName }> = [
    { id: "workers", label: "AI workers", icon: "user" },
    { id: "workflows", label: "Workflows", icon: "network" },
    { id: "devices", label: "Devices", icon: "device" },
  ];

  return (
    <aside className="demo-sidebar">
      <div className="brand-lockup">
        <div className="brand-lockup-content">
          <img src={oysterIconUrl} alt="" className="brand-mark" />
          <span>OysterWorkflow</span>
        </div>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        {items.map((item) => (
          <button
            key={item.id}
            className={`sidebar-link ${
              activePage === item.id ? "is-active" : ""
            }`}
            type="button"
            onClick={() => onNavigate(item.id)}
          >
            <SvgIcon name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-profile">
        <button
          type="button"
          className="profile-main"
          onClick={onOpenAccount}
          aria-label="Account profile"
        >
          {accountIdentity.source === "cloud" ? (
            <span
              className="profile-avatar profile-avatar-monogram"
              aria-hidden="true"
            >
              {accountIdentity.initials}
            </span>
          ) : (
            <img
              src={alexAvatarUrl}
              alt={accountIdentity.name}
              className="profile-avatar"
            />
          )}
          <div>
            <strong>{accountIdentity.name}</strong>
            {accountIdentity.email ? (
              <span title={accountIdentity.email}>{accountIdentity.email}</span>
            ) : null}
          </div>
          <SvgIcon name="chevron" size={18} />
        </button>
        <div className="profile-actions" aria-label="Account utilities">
          <button
            type="button"
            aria-label="Notifications"
            title="Notifications"
            onClick={() => onOpenUtility("notifications")}
          >
            <SvgIcon name="bell" size={18} />
          </button>
          <button
            type="button"
            aria-label="Help"
            title="Help"
            onClick={() => onOpenUtility("help")}
          >
            <SvgIcon name="help" size={18} />
          </button>
          <button
            type="button"
            aria-label="Settings"
            title="Settings"
            onClick={onOpenSettings}
          >
            <SvgIcon name="gear" size={18} />
          </button>
        </div>
      </div>
    </aside>
  );
}

interface WorkersPageProps {
  appLanguage: AppLanguage;
  workers: Worker[];
  selectedWorker: Worker;
  deployedWorkflow: DeployedWorkflow | null;
  runningWorkerIds: Set<string>;
  trainingAction: "idle" | "starting" | "stopping";
  isTraining: boolean;
  productState: ProductStateSnapshot | null;
  isProductStateLoading: boolean;
  checkingCapabilityProviderId: ProductCapabilityProviderId | null;
  capabilityProviderError: string | null;
  isCheckingLlmProvider: boolean;
  llmProviderError: string | null;
  onSelectWorker: (workerId: string) => void;
  onTrain: () => void;
  onToggleWorkerRun: (workerId: string) => void | Promise<void>;
  onRunInstalledWorkflow: (installedWorkflowId: string) => Promise<void>;
  onSendWorkerCommand: (workerId: string, command: string) => Promise<void>;
  onInstalledWorkflowStatusChange: (
    workflowId: string,
    status: InstalledWorkflowStatus,
  ) => Promise<void>;
  onInstalledWorkflowRemove: (workflowId: string) => Promise<void>;
  onWorkerConfigSave: (
    workerId: string,
    config: ProductWorkerConfigInput,
  ) => Promise<void>;
  onDeleteWorker: (workerId: string) => void;
  onOpenChannelSetup: (workerId: string) => void;
  workerTabRequest: {
    workerId: string;
    tab: WorkerDetailTab;
    requestId: number;
  } | null;
  onAssignDevice: () => void;
  onOpenWorkerDraft: () => void;
  onCheckCapabilityProvider: (
    providerId: ProductCapabilityProviderId,
  ) => void | Promise<void>;
  onCheckLlmProvider: () => void | Promise<void>;
  onAction: (message: string) => void;
}

function WorkersEmptyState(input: {
  language: AppLanguage;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
  onCreate: () => void;
}) {
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  return (
    <section className="page-stack">
      <PageHeader
        title={t("AI workers", "AI Worker")}
        subtitle={t(
          "Create a worker, then deploy workflows to that worker.",
          "先创建 Worker，再把工作流部署给它。",
        )}
        actions={
          input.isLoading ? null : input.errorMessage ? (
            <button
              className="primary-button"
              type="button"
              onClick={input.onRetry}
            >
              <SvgIcon name="activity" />
              {t("Retry", "重试")}
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              onClick={input.onCreate}
            >
              <SvgIcon name="plus" />
              {t("New worker", "新建 Worker")}
            </button>
          )
        }
      />
      <section className="panel-card workers-empty-state" aria-live="polite">
        <SvgIcon
          name={input.isLoading || input.errorMessage ? "activity" : "user"}
          size={28}
        />
        <div>
          <h2>
            {input.isLoading
              ? t("Loading AI workers", "正在加载 AI Worker")
              : input.errorMessage
                ? t("AI workers could not be loaded", "无法加载 AI Worker")
                : t("No AI workers yet", "还没有 AI Worker")}
          </h2>
          <p>
            {input.isLoading
              ? t(
                  "Restoring this workspace from the local runtime.",
                  "正在从本地运行环境恢复此工作空间。",
                )
              : input.errorMessage
                ? input.errorMessage
                : t(
                    "Create your first worker to start deploying workflows.",
                    "创建第一个 Worker，即可开始部署工作流。",
                  )}
          </p>
        </div>
      </section>
    </section>
  );
}

function WorkflowsEmptyState(input: {
  language: AppLanguage;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
}) {
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  return (
    <section className="page-stack">
      <PageHeader
        title={t("Workflows", "工作流")}
        subtitle={t(
          "Capture a workflow before deploying it.",
          "先录制工作流，再将它部署给 AI Worker。",
        )}
        actions={
          input.isLoading ? null : input.errorMessage ? (
            <button
              className="primary-button"
              type="button"
              onClick={input.onRetry}
            >
              <SvgIcon name="activity" />
              {t("Retry", "重试")}
            </button>
          ) : null
        }
      />
      <section className="panel-card workers-empty-state" aria-live="polite">
        <SvgIcon name="activity" size={28} />
        <div>
          <h2>
            {input.isLoading
              ? t("Loading workflows", "正在加载工作流")
              : input.errorMessage
                ? t("Workflows could not be loaded", "无法加载工作流")
                : t("No workflows yet", "还没有工作流")}
          </h2>
          <p>
            {input.isLoading
              ? t(
                  "Restoring workflows from the local runtime.",
                  "正在从本地运行环境恢复工作流。",
                )
              : input.errorMessage
                ? input.errorMessage
                : t(
                    "Record your first workflow from a training session.",
                    "通过训练会话录制第一个工作流。",
                  )}
          </p>
        </div>
      </section>
    </section>
  );
}

function DevicesEmptyState(input: {
  language: AppLanguage;
  isLoading: boolean;
  errorMessage: string | null;
  onRetry: () => void;
}) {
  const t = (english: string, chinese: string) =>
    input.language === "zh" ? chinese : english;
  return (
    <section className="page-stack">
      <PageHeader
        title={t("Devices", "设备")}
        subtitle={t(
          "Review trusted computers and worker assignments.",
          "查看受信任的电脑与 Worker 分配。",
        )}
        actions={
          input.errorMessage ? (
            <button
              className="primary-button"
              type="button"
              onClick={input.onRetry}
            >
              <SvgIcon name="activity" />
              {t("Retry", "重试")}
            </button>
          ) : null
        }
      />
      <section className="panel-card workers-empty-state" aria-live="polite">
        <SvgIcon name={input.isLoading ? "activity" : "device"} size={28} />
        <div>
          <h2>
            {input.isLoading
              ? t("Loading devices", "正在加载设备")
              : input.errorMessage
                ? t("Devices could not be loaded", "无法加载设备")
                : t("No devices registered", "还没有已注册设备")}
          </h2>
          <p>
            {input.isLoading
              ? t(
                  "Waiting for the local runtime to register this computer.",
                  "正在等待本地运行环境注册此电脑。",
                )
              : input.errorMessage
                ? input.errorMessage
                : t(
                    "This computer will appear after the local runtime finishes setup.",
                    "本地运行环境完成设置后，此电脑会显示在这里。",
                  )}
          </p>
        </div>
      </section>
    </section>
  );
}

function WorkersPage({
  appLanguage,
  workers: workerItems,
  selectedWorker,
  deployedWorkflow,
  runningWorkerIds,
  trainingAction,
  isTraining,
  productState,
  isProductStateLoading,
  checkingCapabilityProviderId,
  capabilityProviderError,
  isCheckingLlmProvider,
  llmProviderError,
  onSelectWorker,
  onTrain,
  onToggleWorkerRun,
  onRunInstalledWorkflow,
  onSendWorkerCommand,
  onInstalledWorkflowStatusChange,
  onInstalledWorkflowRemove,
  onWorkerConfigSave,
  onDeleteWorker,
  onOpenChannelSetup,
  workerTabRequest,
  onAssignDevice,
  onOpenWorkerDraft,
  onCheckCapabilityProvider,
  onCheckLlmProvider,
  onAction,
}: WorkersPageProps) {
  const [activeWorkerTab, setActiveWorkerTab] =
    useState<WorkerDetailTab>("installed");
  const [workflowStatusOverrides, setWorkflowStatusOverrides] = useState<
    Record<string, InstalledWorkflowStatus>
  >({});
  const [installedWorkflowSearch, setInstalledWorkflowSearch] = useState("");
  const [installedWorkflowStatusFilter, setInstalledWorkflowStatusFilter] =
    useState<InstalledWorkflowStatusFilter>("All");
  const [installedWorkflowPage, setInstalledWorkflowPage] = useState(1);
  const [workerRunAction, setWorkerRunAction] = useState<
    "starting" | "stopping" | null
  >(null);
  const [runHistoryWorkflowId, setRunHistoryWorkflowId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (workerTabRequest && workerTabRequest.workerId === selectedWorker.id) {
      setActiveWorkerTab(workerTabRequest.tab);
    }
  }, [
    selectedWorker.id,
    workerTabRequest?.requestId,
    workerTabRequest?.tab,
    workerTabRequest?.workerId,
  ]);

  const installedWorkflows = useMemo(() => {
    if (productState) {
      return installedProductWorkflowsForWorker(
        productState,
        selectedWorker.id,
      ).map((workflow) => ({
        ...installedWorkflowFromProductState(productState, workflow),
        status: workflowStatusOverrides[workflow.id] ?? workflow.status,
      }));
    }

    if (isProductStateLoading) {
      return [];
    }

    const catalogWorkflows = installedWorkflowsForWorker(selectedWorker.id);
    const deployedItem =
      deployedWorkflow?.workerId === selectedWorker.id
        ? installedWorkflowFromDeployment(deployedWorkflow, selectedWorker)
        : null;
    const mergedWorkflows =
      deployedItem &&
      !catalogWorkflows.some((workflow) => workflow.name === deployedItem.name)
        ? [deployedItem, ...catalogWorkflows]
        : catalogWorkflows;

    return mergedWorkflows.map((workflow) => ({
      ...workflow,
      status: workflowStatusOverrides[workflow.id] ?? workflow.status,
    }));
  }, [
    deployedWorkflow,
    isProductStateLoading,
    productState,
    selectedWorker,
    workflowStatusOverrides,
  ]);
  const runHistoryWorkflow = useMemo(
    () =>
      runHistoryWorkflowId
        ? (installedWorkflows.find(
            (workflow) => workflow.id === runHistoryWorkflowId,
          ) ?? null)
        : null,
    [installedWorkflows, runHistoryWorkflowId],
  );
  const deployedWorkflowAddsInstall =
    !productState &&
    deployedWorkflow?.workerId === selectedWorker.id &&
    !installedWorkflowCatalog.some(
      (workflow) =>
        workflow.workerId === selectedWorker.id &&
        workflow.name === deployedWorkflow.workflowTitle,
    );
  const installedWorkflowTotal = productState
    ? installedWorkflows.length
    : selectedWorker.id === "sales"
      ? Math.max(
          SALES_INSTALLED_WORKFLOW_BASE_TOTAL +
            (deployedWorkflowAddsInstall ? 1 : 0),
          installedWorkflows.length,
        )
      : installedWorkflows.length;
  const installedSummary = useMemo(
    () => ({
      ...summarizeInstalledWorkflows(installedWorkflows),
      count: installedWorkflowTotal,
    }),
    [installedWorkflowTotal, installedWorkflows],
  );
  const chromeCapabilityProvider = useMemo(
    () =>
      productState?.capabilityProviders?.find(
        (provider) => provider.id === "chrome",
      ) ?? null,
    [productState],
  );
  const productWorker = productState?.workers.find(
    (worker) => worker.id === selectedWorker.id,
  );
  const isChromeCapabilityChecking = checkingCapabilityProviderId === "chrome";
  const workerApplicationsPanel = (
    <WorkerApplicationsPanel
      language={appLanguage}
      provider={chromeCapabilityProvider}
      channel={productWorker?.config.channel ?? null}
      hermes={productState?.hermes ?? null}
      isLoading={isProductStateLoading}
      isChecking={isChromeCapabilityChecking}
      isCheckingLlm={isCheckingLlmProvider}
      errorMessage={capabilityProviderError}
      llmErrorMessage={llmProviderError}
      onCheck={() => onCheckCapabilityProvider("chrome")}
      onOpenChannel={() => onOpenChannelSetup(selectedWorker.id)}
      onCheckLlm={onCheckLlmProvider}
    />
  );
  const filteredInstalledWorkflows = useMemo(
    () =>
      installedWorkflows.filter((workflow) =>
        matchesInstalledWorkflowFilter(
          workflow,
          installedWorkflowSearch,
          installedWorkflowStatusFilter,
        ),
      ),
    [
      installedWorkflowSearch,
      installedWorkflowStatusFilter,
      installedWorkflows,
    ],
  );
  const installedWorkflowPageCount = Math.max(
    1,
    Math.ceil(filteredInstalledWorkflows.length / INSTALLED_WORKFLOW_PAGE_SIZE),
  );
  useEffect(() => {
    setInstalledWorkflowPage(1);
  }, [
    installedWorkflowSearch,
    installedWorkflowStatusFilter,
    selectedWorker.id,
  ]);
  useEffect(() => {
    if (installedWorkflowPage > installedWorkflowPageCount) {
      setInstalledWorkflowPage(installedWorkflowPageCount);
    }
  }, [installedWorkflowPage, installedWorkflowPageCount]);
  const pagedInstalledWorkflows = useMemo(() => {
    const start = (installedWorkflowPage - 1) * INSTALLED_WORKFLOW_PAGE_SIZE;
    return filteredInstalledWorkflows.slice(
      start,
      start + INSTALLED_WORKFLOW_PAGE_SIZE,
    );
  }, [filteredInstalledWorkflows, installedWorkflowPage]);
  const activeRun = activeProductRunForWorker(productState, selectedWorker.id);
  const agentSessionRun =
    activeRun ??
    productState?.runs.find((run) => run.workerId === selectedWorker.id) ??
    null;
  const workerChannelPlatform =
    productWorker?.config?.channel?.platform ?? "none";
  const workerChannelIconClassName =
    workerChannelPlatform === "weixin" || workerChannelPlatform === "wecom"
      ? "is-wechat"
      : workerChannelPlatform === "slack"
        ? "is-slack"
        : "";
  const agentRunEvents = productAgentConversationEventsForWorker(
    productState,
    selectedWorker.id,
    agentSessionRun?.id,
  );
  const recentRunItems = productState
    ? productState.runs
        .filter((run) => run.workerId === selectedWorker.id)
        .filter((run) => !isRuntimeRecoveryRun(run))
        .slice(0, 3)
        .map((run) => workflowRunEventFromProductRun(run))
    : recentWorkflowRuns;
  const isWorkerRunning =
    runningWorkerIds.has(selectedWorker.id) || activeRun?.status === "running";
  const hasCurrentRun = Boolean(activeRun);
  const isWorkerSessionOpen = hasCurrentRun || isWorkerRunning;
  const isWorkerReadyForCommand = productState
    ? Boolean(
        activeRun?.hermesSessionId &&
        (activeRun.status === "running" ||
          activeRun.status === "waiting_for_user" ||
          activeRun.status === "blocked"),
      )
    : isWorkerRunning;
  const hasWorkerExecutionStarted = Boolean(
    activeRun &&
    productState?.runEvents.some(
      (event) =>
        event.runId === activeRun.id &&
        event.source === "executor" &&
        event.status === "AI worker working",
    ),
  );
  const selectedInstalledWorkflow =
    selectedWorker.selectedInstalledWorkflowId !== null
      ? (installedWorkflows.find(
          (workflow) =>
            workflow.id === selectedWorker.selectedInstalledWorkflowId,
        ) ?? null)
      : null;
  const deployedWorkflowTitle =
    activeRun?.workflowTitle ??
    (deployedWorkflow?.workerId === selectedWorker.id
      ? deployedWorkflow.workflowTitle
      : (selectedInstalledWorkflow?.name ??
        installedWorkflows[0]?.name ??
        null));
  const trainButtonLabel =
    trainingAction === "starting"
      ? "Starting training..."
      : trainingAction === "stopping"
        ? "Stopping training..."
        : isTraining
          ? "Stop training"
          : "Train my AI worker";
  const workButtonLabel =
    workerRunAction === "starting"
      ? "Initializing..."
      : workerRunAction === "stopping"
        ? "Stopping worker..."
        : isWorkerRunning
          ? "Stop worker"
          : "Start worker";
  const workerTabs: Array<{ id: WorkerDetailTab; label: string }> = [
    { id: "agent", label: "Agent" },
    { id: "installed", label: "Installed workflows" },
    { id: "config", label: "Config" },
    { id: "activity", label: "Activity" },
  ];

  async function handleToggleWorkerRun() {
    if (!isWorkerRunning) {
      setActiveWorkerTab("agent");
    }
    setWorkerRunAction(isWorkerRunning ? "stopping" : "starting");
    try {
      await onToggleWorkerRun(selectedWorker.id);
    } finally {
      setWorkerRunAction(null);
    }
  }

  function handleSelectNextWorker() {
    if (workerItems.length === 0) {
      return;
    }
    const selectedIndex = workerItems.findIndex(
      (worker) => worker.id === selectedWorker.id,
    );
    const nextIndex =
      selectedIndex === -1 ? 0 : (selectedIndex + 1) % workerItems.length;
    onSelectWorker(workerItems[nextIndex].id);
  }

  async function handleInstalledWorkflowAction(
    workflow: InstalledWorkflow,
    action: string,
  ) {
    if (action === "Enable" || action === "Disable") {
      const nextStatus: InstalledWorkflowStatus =
        action === "Enable" ? "Enabled" : "Paused";
      setWorkflowStatusOverrides((previous) => ({
        ...previous,
        [workflow.id]: nextStatus,
      }));
      await onInstalledWorkflowStatusChange(workflow.id, nextStatus);
      onAction(`${workflow.name} ${nextStatus.toLowerCase()}.`);
      return;
    }

    if (action === "Update") {
      onAction(`${workflow.name} update is not connected yet.`);
      return;
    }

    if (action === "Review") {
      if (!productState) {
        onAction(`${workflow.name} review is available after Runtime loads.`);
        return;
      }
      setRunHistoryWorkflowId(workflow.id);
      return;
    }

    if (action === "View runs") {
      if (!productState) {
        onAction(
          `${workflow.name} run history is available after Runtime loads.`,
        );
        return;
      }
      setRunHistoryWorkflowId(workflow.id);
      return;
    }

    if (action === "Run") {
      if (activeRun?.installedWorkflowId === workflow.id) {
        if (isWorkerRunning) {
          await handleToggleWorkerRun();
          return;
        }
        setActiveWorkerTab("agent");
        await onSendWorkerCommand(
          selectedWorker.id,
          "Continue the workflow from the current screen.",
        );
        return;
      }
      if (hasCurrentRun) {
        onAction("Pause the active workflow before starting another one.");
        return;
      }
      if (workflow.status !== "Enabled") {
        onAction(`${workflow.name} must be enabled before it can run.`);
        return;
      }
      setActiveWorkerTab("agent");
      await onRunInstalledWorkflow(workflow.id);
      return;
    }

    if (action === "Remove") {
      await onInstalledWorkflowRemove(workflow.id);
      return;
    }

    onAction(`${workflow.name} action is not available yet.`);
  }

  return (
    <section className="page-stack">
      <PageHeader
        title="AI workers"
        subtitle="Train workers, assign computers, and manage sessions"
        actions={
          <button
            className="primary-button"
            type="button"
            onClick={onOpenWorkerDraft}
          >
            <SvgIcon name="plus" />
            New AI worker
          </button>
        }
      />

      <div className="worker-page-grid">
        <section className="worker-strip panel-card">
          {workerItems.map((worker) => (
            <button
              key={worker.id}
              type="button"
              className={`worker-mini-card ${
                selectedWorker.id === worker.id ? "is-selected" : ""
              }`}
              onClick={() => onSelectWorker(worker.id)}
            >
              <WorkerAvatar worker={worker} />
              <span>
                <strong>{worker.name}</strong>
                <small>
                  <StatusDot tone={worker.tone} />
                  {worker.status}
                </small>
                <span className="worker-card-foot">
                  <span>{worker.device}</span>
                  <span>{worker.heartbeat}</span>
                </span>
              </span>
            </button>
          ))}
          <button
            className="strip-arrow"
            type="button"
            aria-label="Next worker"
            onClick={handleSelectNextWorker}
            disabled={workerItems.length <= 1}
          >
            <SvgIcon name="arrowRight" />
          </button>
        </section>

        <section
          className={`selected-worker panel-card ${
            activeWorkerTab === "installed" ? "is-workflow-management" : ""
          }`}
        >
          <div className="worker-hero">
            <div
              className="worker-avatar-panel"
              aria-label="AI worker avatar settings"
            >
              <div className="worker-avatar-stage">
                <WorkerAvatar worker={selectedWorker} size="large" />
              </div>
              <button
                className="upload-avatar-button worker-upload-button"
                type="button"
                disabled
                title="Avatar upload requires profile storage and is not available yet."
              >
                <SvgIcon name="upload" size={14} />
                Upload avatar
              </button>
            </div>
            <div>
              <p className="section-kicker">Selected worker</p>
              <div className="title-with-pill">
                <h2>{selectedWorker.name}</h2>
                <StatusPill tone={selectedWorker.tone}>
                  {selectedWorker.status}
                </StatusPill>
              </div>
              <p>{selectedWorker.description}</p>
              <div className="worker-hero-meta">
                <span>
                  <b>Device</b>
                  {selectedWorker.device}
                </span>
                <span>
                  <b>Policy</b>
                  Allow all
                </span>
              </div>
              <div
                className="worker-install-summary"
                aria-label="Installed workflow summary"
              >
                <Metric
                  label="Installed workflows"
                  value={
                    isProductStateLoading
                      ? "..."
                      : String(installedSummary.count)
                  }
                />
                <Metric
                  label="Total runs"
                  value={
                    isProductStateLoading
                      ? "..."
                      : String(installedSummary.runs)
                  }
                />
                <Metric
                  label="Successful runs"
                  value={
                    isProductStateLoading
                      ? "..."
                      : String(installedSummary.successes)
                  }
                />
                <Metric
                  label="Success rate"
                  value={
                    isProductStateLoading ? "..." : installedSummary.successRate
                  }
                />
              </div>
            </div>
          </div>

          <div className="worker-actions">
            <button
              className={`primary-button large ${isTraining ? "danger" : ""}`}
              type="button"
              onClick={onTrain}
              disabled={trainingAction !== "idle"}
            >
              <SvgIcon name={isTraining ? "stop" : "play"} />
              {trainButtonLabel}
            </button>
            <button
              className="ghost-button large"
              type="button"
              onClick={onAssignDevice}
            >
              <SvgIcon name="device" />
              Assign device
            </button>
            <button
              className={`ghost-button large work-toggle-button ${
                isWorkerRunning ? "is-running" : ""
              }`}
              type="button"
              aria-pressed={isWorkerRunning}
              onClick={handleToggleWorkerRun}
              disabled={workerRunAction !== null}
              aria-busy={workerRunAction !== null}
            >
              <SvgIcon name={isWorkerRunning ? "stop" : "play"} />
              {workButtonLabel}
            </button>
          </div>

          <div
            className="worker-detail-tabs"
            role="tablist"
            aria-label="Worker detail sections"
          >
            {workerTabs.map((tab) => (
              <button
                key={tab.id}
                id={`worker-tab-${tab.id}`}
                className={`worker-tab ${
                  activeWorkerTab === tab.id ? "is-active" : ""
                }`}
                type="button"
                role="tab"
                aria-selected={activeWorkerTab === tab.id}
                aria-controls={`worker-panel-${tab.id}`}
                onClick={() => setActiveWorkerTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div
            id={`worker-panel-${activeWorkerTab}`}
            className="worker-tab-panel"
            role="tabpanel"
            aria-labelledby={`worker-tab-${activeWorkerTab}`}
          >
            {activeWorkerTab === "agent" ? (
              <WorkerAgentPanel
                worker={selectedWorker}
                isWorkerRunning={isWorkerSessionOpen}
                isWorkerProcessing={isWorkerRunning}
                isCommandReady={isWorkerReadyForCommand}
                hasWorkerExecutionStarted={hasWorkerExecutionStarted}
                deployedWorkflowTitle={deployedWorkflowTitle}
                runEvents={productState ? agentRunEvents : undefined}
                onSendCommand={(command) =>
                  onSendWorkerCommand(selectedWorker.id, command)
                }
              />
            ) : null}
            {activeWorkerTab === "installed" ? (
              <WorkerInstalledWorkflowsPanel
                workflows={pagedInstalledWorkflows}
                installedCount={installedWorkflows.length}
                totalCount={filteredInstalledWorkflows.length}
                searchQuery={installedWorkflowSearch}
                statusFilter={installedWorkflowStatusFilter}
                activeRunInstalledWorkflowId={
                  activeRun?.installedWorkflowId ?? null
                }
                activeRunStatus={activeRun?.status ?? null}
                hasActiveRun={hasCurrentRun}
                page={installedWorkflowPage}
                pageCount={installedWorkflowPageCount}
                pageSize={INSTALLED_WORKFLOW_PAGE_SIZE}
                onSearchQueryChange={setInstalledWorkflowSearch}
                onStatusFilterChange={setInstalledWorkflowStatusFilter}
                onWorkflowAction={handleInstalledWorkflowAction}
                onPageChange={setInstalledWorkflowPage}
                isLoading={isProductStateLoading}
              />
            ) : null}
            {activeWorkerTab === "config" ? (
              <WorkerConfigPanel
                language={appLanguage}
                worker={selectedWorker}
                productWorker={productWorker ?? null}
                hermes={productState?.hermes ?? null}
                onSave={(config) =>
                  onWorkerConfigSave(selectedWorker.id, config)
                }
                onDelete={() => onDeleteWorker(selectedWorker.id)}
              />
            ) : null}
            {activeWorkerTab === "activity" ? (
              <WorkerActivityPanel
                worker={selectedWorker}
                productState={productState}
              />
            ) : null}
          </div>
        </section>

        <aside className="side-stack">
          {activeWorkerTab === "installed" ? (
            <>
              {workerApplicationsPanel}
              <InstalledWorkflowSidebar
                worker={selectedWorker}
                isWorkerRunning={isWorkerRunning}
                recentRuns={recentRunItems}
              />
            </>
          ) : (
            <>
              <Panel title="Assigned device">
                <div className="device-summary">
                  <span className="summary-icon">
                    <SvgIcon name="device" />
                  </span>
                  <div>
                    <strong>{selectedWorker.device}</strong>
                    <span className="summary-status">
                      <StatusDot
                        tone={
                          selectedWorker.device === "Unassigned"
                            ? "idle"
                            : "ready"
                        }
                      />
                      {selectedWorker.device === "Unassigned"
                        ? "Not assigned"
                        : "Assigned"}
                    </span>
                  </div>
                  <SvgIcon name="chevron" />
                </div>
                <button
                  className="device-summary device-summary-button"
                  type="button"
                  aria-label={`Configure ${selectedWorker.name} message channel`}
                  onClick={() => onOpenChannelSetup(selectedWorker.id)}
                >
                  <span
                    className={`summary-icon ${workerChannelIconClassName}`}
                  >
                    {workerChannelPlatform === "none" ||
                    !productWorker?.config.channel ? (
                      <SvgIcon name="chat" />
                    ) : (
                      <img
                        src={workerChannelIconUrl(workerChannelPlatform)}
                        alt=""
                      />
                    )}
                  </span>
                  <div>
                    <strong>
                      {productWorker?.config.channel?.label ?? "No channel"}
                    </strong>
                    <span className="summary-status">
                      <StatusDot
                        tone={workerChannelStatusTone(
                          productWorker?.config.channel ?? null,
                        )}
                      />
                      {workerChannelStatusLabel(
                        productWorker?.config.channel ?? null,
                      )}
                    </span>
                  </div>
                  <SvgIcon name="chevron" />
                </button>
              </Panel>
              {workerApplicationsPanel}
            </>
          )}
        </aside>
      </div>
      {productState && runHistoryWorkflow ? (
        <InstalledWorkflowRunHistoryDialog
          workflow={runHistoryWorkflow}
          productState={productState}
          onClose={() => setRunHistoryWorkflowId(null)}
        />
      ) : null}
    </section>
  );
}

const WORKFLOW_GENERATION_STAGE_LABELS: Record<
  LabWorkflowGenerationStage,
  { en: string; zh: string }
> = {
  "analyzing-recording": {
    en: "Analyzing recording",
    zh: "分析录制内容",
  },
  "discovering-workflow": {
    en: "Discovering workflow",
    zh: "发现工作流",
  },
  "building-skill": {
    en: "Building skill",
    zh: "构建技能",
  },
  "building-workflow-graph": {
    en: "Building workflow graph",
    zh: "构建工作流图",
  },
};

function formatGenerationStageDuration(
  startedAt: string | null,
  completedAt: string | null,
  nowMs: number,
): string | null {
  if (!startedAt) {
    return null;
  }
  const startedAtMs = Date.parse(startedAt);
  const completedAtMs = completedAt ? Date.parse(completedAt) : nowMs;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs)) {
    return null;
  }
  const durationMs = Math.max(0, completedAtMs - startedAtMs);
  if (durationMs < 1_000) {
    return "<1s";
  }
  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function WorkflowGenerationProgressPanel({
  progress,
  language,
  waitingForSelectionCount = 0,
}: {
  progress: LabWorkflowGenerationProgress;
  language: AppLanguage;
  waitingForSelectionCount?: number;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!progress.currentStage) {
      return undefined;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress.currentStage]);

  const completedCount = LAB_WORKFLOW_GENERATION_STAGES.filter(
    (stage) => progress.stages[stage].completedAt,
  ).length;
  const activeIndex = progress.currentStage
    ? LAB_WORKFLOW_GENERATION_STAGES.indexOf(progress.currentStage)
    : -1;
  const activeLabel =
    waitingForSelectionCount > 1
      ? language === "zh"
        ? `检测到 ${waitingForSelectionCount} 个 Workflow，等待选择`
        : `${waitingForSelectionCount} workflows detected. Waiting for selection`
      : progress.currentStage
        ? WORKFLOW_GENERATION_STAGE_LABELS[progress.currentStage][language]
        : progress.failedStage
          ? language === "zh"
            ? "生成需要处理"
            : "Generation needs attention"
          : progress.completedAt
            ? language === "zh"
              ? "工作流已生成"
              : "Workflow generated"
            : language === "zh"
              ? "录制内容已分析"
              : "Recording analyzed";
  const progressSummary =
    activeIndex >= 0
      ? language === "zh"
        ? `第 ${activeIndex + 1}/4 阶段`
        : `Stage ${activeIndex + 1} of 4`
      : language === "zh"
        ? `已完成 ${completedCount}/4 个阶段`
        : `${completedCount} of 4 stages complete`;

  return (
    <section
      className="generate-progress"
      aria-label={
        language === "zh" ? "工作流生成进度" : "Workflow generation progress"
      }
      aria-live="polite"
    >
      <div className="progress-topline">
        <div>
          <span>
            {language === "zh" ? "工作流生成" : "Workflow generation"}
          </span>
          <strong>{activeLabel}</strong>
        </div>
        <small>{progressSummary}</small>
      </div>
      <div className="generation-stage-track" aria-hidden="true">
        {LAB_WORKFLOW_GENERATION_STAGES.map((stage) => {
          const timing = progress.stages[stage];
          const state = timing.completedAt
            ? "completed"
            : progress.currentStage === stage
              ? "active"
              : progress.failedStage === stage
                ? "failed"
                : "pending";
          return <span key={stage} className={`is-${state}`} />;
        })}
      </div>
      <ol className="generation-stage-list">
        {LAB_WORKFLOW_GENERATION_STAGES.map((stage, index) => {
          const timing = progress.stages[stage];
          const isCompleted = Boolean(timing.completedAt);
          const isActive = progress.currentStage === stage;
          const isFailed = progress.failedStage === stage;
          const stateLabel = isCompleted
            ? language === "zh"
              ? "已完成"
              : "Done"
            : isActive
              ? language === "zh"
                ? "进行中"
                : "In progress"
              : isFailed
                ? language === "zh"
                  ? "失败"
                  : "Failed"
                : language === "zh"
                  ? "等待中"
                  : "Waiting";
          const duration = formatGenerationStageDuration(
            timing.startedAt,
            timing.completedAt,
            nowMs,
          );
          return (
            <li
              key={stage}
              className={`${isCompleted ? "is-completed" : ""} ${isActive ? "is-active" : ""} ${isFailed ? "is-failed" : ""}`}
              aria-current={isActive ? "step" : undefined}
            >
              <span className="generation-stage-index">{index + 1}</span>
              <span className="generation-stage-copy">
                <strong>
                  {WORKFLOW_GENERATION_STAGE_LABELS[stage][language]}
                </strong>
                <small>{stateLabel}</small>
              </span>
              {duration ? (
                <span className="generation-stage-duration">{duration}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

interface WorkflowsPageProps {
  workers: Worker[];
  workflows: WorkflowSummary[];
  selectedWorkflow: WorkflowSummary;
  appLanguage: AppLanguage;
  installTargetId: string;
  generationProgress: GenerateWorkflowProgress | null;
  onSelectWorkflow: (workflowId: string) => void;
  onInstallTargetChange: (workerId: string) => void;
  onOpenVersionHistory: () => void;
  onOpenFullMap: () => void;
  onGenerateWorkflow: (workflowId: string) => void;
  onChooseWorkflow: (workflowId: string) => void;
  onInstallWorkflow: () => void;
  onDeleteWorkflow: (workflowId: string) => void;
}

function WorkflowsPage({
  workers: workerItems,
  workflows: workflowItems,
  selectedWorkflow,
  appLanguage,
  installTargetId,
  generationProgress,
  onSelectWorkflow,
  onInstallTargetChange,
  onOpenVersionHistory,
  onOpenFullMap,
  onGenerateWorkflow,
  onChooseWorkflow,
  onInstallWorkflow,
  onDeleteWorkflow,
}: WorkflowsPageProps) {
  const workflowListRef = useRef<HTMLElement>(null);
  const [workflowListPage, setWorkflowListPage] = useState(1);
  const [workflowSearchQuery, setWorkflowSearchQuery] = useState("");
  const [workflowStatusFilter, setWorkflowStatusFilter] =
    useState<WorkflowStatusFilter>("All");
  const selectedProgress =
    generationProgress?.workflowId === selectedWorkflow.id
      ? generationProgress
      : selectedWorkflow.generationProgress
        ? {
            workflowId: selectedWorkflow.id,
            progress: selectedWorkflow.generationProgress,
          }
        : null;
  const isDraftWorkflow =
    selectedWorkflow.id.startsWith("manual-") ||
    selectedWorkflow.id.startsWith("imported-");
  const isGenerated =
    selectedWorkflow.phase === "generated" || selectedWorkflow.phase === "demo";
  const canGenerate =
    selectedWorkflow.sourceType === "runtime" &&
    selectedWorkflow.phase !== "generated" &&
    selectedWorkflow.phase !== "generating" &&
    selectedWorkflow.stats.uiEvents !== null;
  const workflowHeaderPrefix = isDraftWorkflow
    ? "Workflow draft:"
    : isGenerated || selectedWorkflow.title === DEMO_WORKFLOW_TITLE
      ? "Detected workflow:"
      : "Captured session:";
  const workflowSourceLabel = isDraftWorkflow
    ? "Workflow draft"
    : "Training session";
  const workflowSourceDetail = selectedWorkflow.id.startsWith("imported-")
    ? "Imported brief"
    : isDraftWorkflow
      ? "Manual entry"
      : "Screen, text, and voice captured";
  const filteredWorkflowItems = useMemo(
    () =>
      workflowItems.filter((workflow) =>
        matchesWorkflowFilter(
          workflow,
          workflowSearchQuery,
          workflowStatusFilter,
        ),
      ),
    [workflowItems, workflowSearchQuery, workflowStatusFilter],
  );
  const workflowStatusOptions = useMemo(
    () => [
      "All",
      ...Array.from(new Set(workflowItems.map((item) => item.status))),
    ],
    [workflowItems],
  );
  const workflowListPageCount = Math.max(
    1,
    Math.ceil(filteredWorkflowItems.length / WORKFLOW_LIST_PAGE_SIZE),
  );
  const pagedWorkflowItems = useMemo(() => {
    const start = (workflowListPage - 1) * WORKFLOW_LIST_PAGE_SIZE;
    return filteredWorkflowItems.slice(start, start + WORKFLOW_LIST_PAGE_SIZE);
  }, [filteredWorkflowItems, workflowListPage]);
  const workflowVisibleStart =
    filteredWorkflowItems.length === 0
      ? 0
      : (workflowListPage - 1) * WORKFLOW_LIST_PAGE_SIZE + 1;
  const workflowVisibleEnd = Math.min(
    workflowListPage * WORKFLOW_LIST_PAGE_SIZE,
    filteredWorkflowItems.length,
  );

  useEffect(() => {
    if (filteredWorkflowItems.length === 0) {
      setWorkflowListPage(1);
      return;
    }

    const selectedIndex = filteredWorkflowItems.findIndex(
      (workflow) => workflow.id === selectedWorkflow.id,
    );
    if (selectedIndex === -1) {
      onSelectWorkflow(filteredWorkflowItems[0].id);
      setWorkflowListPage(1);
      return;
    }

    const selectedPage =
      selectedIndex >= 0
        ? Math.floor(selectedIndex / WORKFLOW_LIST_PAGE_SIZE) + 1
        : 1;
    setWorkflowListPage(
      Math.min(Math.max(1, selectedPage), workflowListPageCount),
    );
  }, [
    filteredWorkflowItems,
    onSelectWorkflow,
    selectedWorkflow.id,
    workflowListPageCount,
  ]);

  function handleWorkflowListPageChange(nextPage: number) {
    const clampedPage = Math.min(Math.max(1, nextPage), workflowListPageCount);
    setWorkflowListPage(clampedPage);
    window.requestAnimationFrame(() => {
      workflowListRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }

  return (
    <section className="page-stack">
      <PageHeader
        title="Workflows"
        subtitle="Review workflows learned from recent training sessions"
      />

      <div className="workflows-grid">
        <section
          ref={workflowListRef}
          className="detected-workflows panel-card"
        >
          <div className="panel-title-row">
            <div>
              <h2>Detected workflows</h2>
              <p>Latest training session</p>
            </div>
          </div>
          <div
            className="workflow-list-controls detected-workflow-controls"
            aria-label="Detected workflow filters"
          >
            <label>
              <span>Search</span>
              <input
                type="search"
                aria-label="Search detected workflows"
                value={workflowSearchQuery}
                onChange={(event) => {
                  setWorkflowSearchQuery(event.target.value);
                  setWorkflowListPage(1);
                }}
                placeholder="Title, app, or code"
              />
            </label>
            <label>
              <span>Status</span>
              <select
                aria-label="Filter detected workflow status"
                value={workflowStatusFilter}
                onChange={(event) => {
                  setWorkflowStatusFilter(event.target.value);
                  setWorkflowListPage(1);
                }}
              >
                {workflowStatusOptions.map((statusOption) => (
                  <option key={statusOption} value={statusOption}>
                    {statusOption === "All" ? "All statuses" : statusOption}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div
            className="workflow-card-list"
            role="list"
            aria-label="Detected workflow list"
          >
            {pagedWorkflowItems.map((workflow) => (
              <article
                key={workflow.id}
                className={`workflow-card-shell ${
                  workflow.id === selectedWorkflow.id ? "is-selected" : ""
                }`}
                role="listitem"
              >
                <button
                  type="button"
                  className={`workflow-card ${
                    workflow.id === selectedWorkflow.id ? "is-selected" : ""
                  }`}
                  onClick={() => onSelectWorkflow(workflow.id)}
                >
                  <span className="workflow-card-body">
                    <span className="workflow-card-topline">
                      <span className="workflow-card-identity">
                        <strong>{workflow.code}</strong>
                        <small>{workflow.stats.duration}</small>
                      </span>
                      <StatusPill tone={workflow.tone}>
                        {workflow.status}
                      </StatusPill>
                    </span>
                    <strong className="workflow-card-title">
                      {workflow.title}
                    </strong>
                    <small className="workflow-card-description">
                      {workflow.description}
                    </small>
                    <span className="workflow-card-meta">
                      <span>
                        {formatStatValue(workflow.stats.uiEvents)} screen
                        actions
                      </span>
                      <span>
                        {workflow.stats.decisionPoints === null
                          ? "Pending decisions"
                          : `${workflow.stats.decisionPoints} decisions`}
                      </span>
                    </span>
                  </span>
                  <SvgIcon name="chevron" />
                </button>
                <button
                  className="workflow-card-delete"
                  type="button"
                  aria-label={`Delete workflow ${workflow.title}`}
                  onClick={() => onDeleteWorkflow(workflow.id)}
                >
                  <SvgIcon name="trash" size={17} />
                </button>
              </article>
            ))}
            {filteredWorkflowItems.length === 0 ? (
              <div className="workflow-filter-empty">
                <strong>No matching workflows</strong>
                <span>
                  Adjust the search or status filter to review detected workflow
                  candidates.
                </span>
              </div>
            ) : null}
          </div>
          {filteredWorkflowItems.length > pagedWorkflowItems.length ? (
            <nav
              className="installed-workflow-pagination workflow-list-pagination"
              aria-label="Detected workflow pages"
            >
              <span className="pagination-summary">
                {workflowVisibleStart}-{workflowVisibleEnd} of{" "}
                {filteredWorkflowItems.length}
              </span>
              <div className="pagination-buttons">
                <button
                  type="button"
                  disabled={workflowListPage === 1}
                  onClick={() =>
                    handleWorkflowListPageChange(workflowListPage - 1)
                  }
                >
                  Previous
                </button>
                <span className="pagination-current">
                  Page {workflowListPage} of {workflowListPageCount}
                </span>
                <button
                  type="button"
                  disabled={workflowListPage === workflowListPageCount}
                  onClick={() =>
                    handleWorkflowListPageChange(workflowListPage + 1)
                  }
                >
                  Next
                </button>
              </div>
            </nav>
          ) : null}
        </section>

        <section className="workflow-detail-stack">
          <div className="workflow-detected panel-card">
            <div className="workflow-session-card">
              <span>{workflowSourceLabel}</span>
              <strong>{selectedWorkflow.code}</strong>
              <small>{workflowSourceDetail}</small>
            </div>
            <div className="workflow-detected-copy">
              <h2>
                {workflowHeaderPrefix} <span>{selectedWorkflow.title}</span>
              </h2>
              <p>{selectedWorkflow.detectedAt}</p>
              {isGenerated && selectedWorkflow.connectedApps.length > 0 ? (
                <div
                  className="connected-apps-strip"
                  aria-label="Workflow apps"
                >
                  {selectedWorkflow.connectedApps.map((appName) => {
                    const app = connectedAppForName(appName);
                    return (
                      <span key={app.id} className="connected-app-pill">
                        <img src={app.icon} alt="" />
                        {app.label}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="workflow-truth-note">
                  {selectedWorkflow.requiresWorkflowSelection
                    ? appLanguage === "zh"
                      ? "Workflow 检测已完成，请选择要生成的一个。"
                      : "Workflow detection is complete. Choose one to generate."
                    : appLanguage === "zh"
                      ? "分析本次录制以构建可编辑 Workflow。"
                      : "Analyze this capture to build an editable workflow."}
                </p>
              )}
            </div>
            <StatusPill tone={selectedWorkflow.tone}>
              {selectedWorkflow.status}
            </StatusPill>
          </div>

          <RunStatistics stats={selectedWorkflow.stats} />

          {isGenerated ? (
            <section className="workflow-logic panel-card">
              <div className="logic-header">
                <div>
                  <h2>
                    {appLanguage === "zh" ? "工作流逻辑" : "Workflow logic"}
                  </h2>
                  <p>
                    {appLanguage === "zh"
                      ? "查看节点、判断路线和本次案例如何进入已有工作流。"
                      : "Review nodes, decision routes, and how this case fits the workflow."}
                  </p>
                </div>
                <div className="logic-header-actions">
                  {selectedWorkflow.graphPath ? (
                    <>
                      <button
                        className="ghost-button compact"
                        type="button"
                        onClick={onOpenVersionHistory}
                      >
                        <SvgIcon name="clock" />
                        {appLanguage === "zh" ? "版本历史" : "Version history"}
                      </button>
                      <button
                        className="primary-button compact"
                        type="button"
                        onClick={onOpenFullMap}
                      >
                        <SvgIcon name="expand" />
                        {appLanguage === "zh" ? "打开完整图" : "Open full map"}
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
              <WorkflowGraphPanel
                workflow={selectedWorkflow}
                language={appLanguage}
              />
            </section>
          ) : (
            <section className="workflow-generate-panel panel-card">
              <div>
                <h2>
                  {selectedWorkflow.requiresWorkflowSelection
                    ? appLanguage === "zh"
                      ? "选择要生成的 Workflow"
                      : "Choose a workflow to generate"
                    : appLanguage === "zh"
                      ? "分析已录制的 Workflow"
                      : "Analyze captured workflow"}
                </h2>
                <p>
                  {selectedWorkflow.requiresWorkflowSelection
                    ? appLanguage === "zh"
                      ? `本次录制检测到 ${selectedWorkflow.workflowCandidates?.length ?? 0} 个 Workflow。选择一个后再继续生成可编辑 Graph。`
                      : `${selectedWorkflow.workflowCandidates?.length ?? 0} workflows were detected in this recording. Choose one before generating an editable graph.`
                    : appLanguage === "zh"
                      ? "分析本次录制，生成可编辑 Graph、应用上下文和复核信号。"
                      : "Analyze this capture to create an editable graph, app context, and review signals."}
                </p>
                {selectedWorkflow.errorMessage ? (
                  <p className="inline-error">
                    {productizeWorkerFacingText(selectedWorkflow.errorMessage)}
                  </p>
                ) : null}
              </div>
              {selectedProgress ? (
                <WorkflowGenerationProgressPanel
                  progress={selectedProgress.progress}
                  language={appLanguage}
                  waitingForSelectionCount={
                    selectedWorkflow.requiresWorkflowSelection
                      ? selectedWorkflow.workflowCandidates?.length
                      : 0
                  }
                />
              ) : null}
              <button
                className="primary-button large"
                type="button"
                onClick={() =>
                  selectedWorkflow.requiresWorkflowSelection
                    ? onChooseWorkflow(selectedWorkflow.id)
                    : onGenerateWorkflow(selectedWorkflow.id)
                }
                disabled={
                  selectedWorkflow.requiresWorkflowSelection
                    ? false
                    : !canGenerate
                }
              >
                <SvgIcon
                  name={
                    selectedWorkflow.requiresWorkflowSelection
                      ? "target"
                      : "activity"
                  }
                />
                {selectedWorkflow.requiresWorkflowSelection
                  ? appLanguage === "zh"
                    ? "选择 Workflow"
                    : "Choose workflow"
                  : selectedWorkflow.phase === "generating"
                    ? appLanguage === "zh"
                      ? "正在生成 Workflow..."
                      : "Generating workflow..."
                    : appLanguage === "zh"
                      ? "生成 Workflow"
                      : "Generate workflow"}
              </button>
            </section>
          )}

          {isGenerated ? (
            <ClawHubPublishPanel
              workflowId={selectedWorkflow.id}
              workflowTitle={selectedWorkflow.title}
              canPublish={Boolean(selectedWorkflow.skillPath)}
            />
          ) : null}

          {isGenerated ? (
            <section className="install-panel panel-card">
              <label className="select-field">
                <span>Deploy to</span>
                <select
                  value={installTargetId}
                  disabled={workerItems.length === 0}
                  onChange={(event) =>
                    onInstallTargetChange(event.target.value)
                  }
                >
                  {workerItems.length === 0 ? (
                    <option value="">
                      {appLanguage === "zh"
                        ? "请先创建 AI Worker"
                        : "Create an AI worker first"}
                    </option>
                  ) : null}
                  {workerItems.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary-button large"
                type="button"
                onClick={onInstallWorkflow}
                disabled={
                  !installTargetId ||
                  !workerItems.some((worker) => worker.id === installTargetId)
                }
              >
                <SvgIcon name="download" />
                Deploy to AI worker
              </button>
            </section>
          ) : null}
        </section>
      </div>
    </section>
  );
}

interface DevicesPageProps {
  devices: Device[];
  workers: Worker[];
  selectedDevice: Device;
  onSelectDevice: (deviceId: string) => void;
  onOpenAssignDevice: () => void;
  onExportReport: () => void;
  onOpenWorker: (workerId: string) => void;
}

function DevicesPage({
  devices: deviceItems,
  workers: workerItems,
  selectedDevice,
  onSelectDevice,
  onOpenAssignDevice,
  onExportReport,
  onOpenWorker,
}: DevicesPageProps) {
  const assignedWorker =
    workerItems.find(
      (worker) => worker.name === selectedDevice.assignedWorker,
    ) ?? null;
  return (
    <section className="page-stack">
      <PageHeader
        title="Devices"
        subtitle="Review trusted computers and worker assignments"
        actions={
          <>
            <button
              className="primary-button"
              type="button"
              onClick={onOpenAssignDevice}
            >
              <SvgIcon name="plus" />
              Assign device
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={onExportReport}
            >
              <SvgIcon name="download" />
              Export report
            </button>
          </>
        }
      />

      <div className="devices-grid">
        <section className="device-list panel-card">
          <div className="panel-title-row">
            <div>
              <h2>Trusted computers</h2>
              <p>Keep worker assignments and availability visible</p>
            </div>
          </div>
          {deviceItems.map((device) => (
            <button
              key={device.id}
              type="button"
              className={`device-card ${
                selectedDevice.id === device.id ? "is-selected" : ""
              }`}
              onClick={() => onSelectDevice(device.id)}
            >
              <span
                className={`device-signal tone-${deviceTone(device.status)}`}
              >
                <strong>{deviceCode(device.name)}</strong>
                <small>{device.status}</small>
              </span>
              <span>
                <strong>{device.name}</strong>
                <small>{device.assignedWorker}</small>
              </span>
              <StatusPill tone={deviceTone(device.status)}>
                {device.status}
              </StatusPill>
            </button>
          ))}
        </section>

        <section className="device-detail panel-card">
          <div className="device-detail-header">
            <span
              className={`device-signal large tone-${deviceTone(selectedDevice.status)}`}
            >
              <strong>{deviceCode(selectedDevice.name)}</strong>
              <small>{selectedDevice.status}</small>
            </span>
            <div>
              <p className="section-kicker">Selected device</p>
              <h2>{selectedDevice.name}</h2>
              <p>{selectedDevice.location}</p>
            </div>
            <StatusPill tone={deviceTone(selectedDevice.status)}>
              {selectedDevice.status}
            </StatusPill>
          </div>

          <div className="device-metrics">
            <Metric label="Owner" value={selectedDevice.owner} />
            <Metric
              label="Assigned worker"
              value={selectedDevice.assignedWorker}
            />
            <Metric label="Availability" value={selectedDevice.heartbeat} />
          </div>

          <div className="device-actions">
            <button
              className="primary-button large"
              type="button"
              onClick={() =>
                assignedWorker
                  ? onOpenWorker(assignedWorker.id)
                  : onOpenAssignDevice()
              }
            >
              <SvgIcon name={assignedWorker ? "user" : "plus"} />
              {assignedWorker ? "Open worker" : "Assign worker"}
            </button>
            <button
              className="ghost-button large"
              type="button"
              onClick={onOpenAssignDevice}
            >
              <SvgIcon name="device" />
              Reassign device
            </button>
          </div>
        </section>

        <aside className="side-stack devices-side">
          <Panel title="Message routing">
            <div className="device-routing-summary">
              <span className="summary-icon">
                <SvgIcon name="chat" />
              </span>
              <div>
                <strong>
                  {assignedWorker
                    ? `Managed by ${assignedWorker.name}`
                    : "No worker assigned"}
                </strong>
                <p>
                  {assignedWorker
                    ? "Open the assigned AI worker to manage its message channel."
                    : "Assign an AI worker before configuring message routing on this computer."}
                </p>
              </div>
            </div>
          </Panel>
        </aside>
      </div>
    </section>
  );
}

interface PageHeaderProps {
  title: string;
  subtitle: string;
  actions?: React.ReactNode;
}

function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {actions ? <div className="header-actions">{actions}</div> : null}
    </header>
  );
}

function RunStatistics({ stats }: { stats: WorkflowStats }) {
  const items = [
    { label: "Screen actions", value: formatStatValue(stats.uiEvents) },
    {
      label: "Visible text",
      value: formatStatValue(stats.ocrObservations),
    },
    { label: "Voice notes", value: formatStatValue(stats.voiceNotes) },
    { label: "Duration", value: stats.duration },
    {
      label: "Decision points",
      value: formatStatValue(stats.decisionPoints),
    },
  ];

  return (
    <section className="run-statistics panel-card">
      <h2>Capture summary</h2>
      <div className="stats-strip">
        {items.map((item) => (
          <div key={item.label} className="stat-item">
            <small>{item.label}</small>
            <strong>{item.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function WorkflowSelectionDialog({
  language,
  candidates,
  recommendedWorkflowId,
  onClose,
  onConfirm,
}: {
  language: AppLanguage;
  candidates: WorkflowCandidate[];
  recommendedWorkflowId: string;
  onClose: () => void;
  onConfirm: (workflowId: string) => void;
}) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(
    recommendedWorkflowId,
  );
  const orderedCandidates = useMemo(
    () => [...candidates].sort(compareWorkflowCandidatePriority),
    [candidates],
  );
  const t = (english: string, chinese: string) =>
    language === "zh" ? chinese : english;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const formatCandidateTime = (candidate: WorkflowCandidate) => {
    const start = new Date(candidate.startTs);
    const end = new Date(candidate.endTs);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return null;
    }
    const formatter = new Intl.DateTimeFormat(
      language === "zh" ? "zh-CN" : "en-US",
      {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      },
    );
    return `${formatter.format(start)} - ${formatter.format(end)}`;
  };

  return (
    <div
      className="modal-layer workflow-selection-modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-selection-title"
      aria-describedby="workflow-selection-description"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t("Close without generating", "关闭且不生成")}
        onClick={onClose}
      />
      <section className="workflow-selection-dialog">
        <div className="modal-header">
          <div>
            <p className="section-kicker">
              {t("Workflow detected", "Workflow 检测完成")}
            </p>
            <h2 id="workflow-selection-title">
              {t("Choose what to generate", "选择要生成的 Workflow")}
            </h2>
            <span id="workflow-selection-description">
              {t(
                `${candidates.length} workflows were found in this recording. The recommended option is selected by default.`,
                `本次录制检测到 ${candidates.length} 个 Workflow，已默认选中推荐项。`,
              )}
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label={t("Close without generating", "关闭且不生成")}
            onClick={onClose}
          >
            <SvgIcon name="close" />
          </button>
        </div>

        <div
          className="workflow-candidate-options"
          role="radiogroup"
          aria-label={t("Detected workflows", "检测到的 Workflow")}
        >
          {orderedCandidates.map((candidate) => {
            const isRecommended =
              candidate.workflowId === recommendedWorkflowId;
            const isSelected = candidate.workflowId === selectedWorkflowId;
            const candidateTime = formatCandidateTime(candidate);
            return (
              <label
                key={candidate.workflowId}
                className={`workflow-candidate-option ${isSelected ? "is-selected" : ""}`}
              >
                <input
                  type="radio"
                  name="workflow-candidate"
                  value={candidate.workflowId}
                  checked={isSelected}
                  autoFocus={isRecommended}
                  onChange={() => setSelectedWorkflowId(candidate.workflowId)}
                />
                <span className="workflow-candidate-copy">
                  <span className="workflow-candidate-heading">
                    <strong>{candidate.name}</strong>
                    {isRecommended ? (
                      <small>{t("Recommended", "推荐")}</small>
                    ) : null}
                  </span>
                  <span>{candidate.description || candidate.goal}</span>
                  <span className="workflow-candidate-meta">
                    {candidateTime ? <small>{candidateTime}</small> : null}
                    <small>
                      {t(
                        `${candidate.eventCount} captured events`,
                        `${candidate.eventCount} 条录制事件`,
                      )}
                    </small>
                  </span>
                  {candidate.whyThisWorkflow ? (
                    <small className="workflow-candidate-reason">
                      {candidate.whyThisWorkflow}
                    </small>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>

        <div className="workflow-selection-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={() => onConfirm(recommendedWorkflowId)}
          >
            {t("Use recommended workflow", "使用推荐的 Workflow")}
          </button>
          <button
            className="primary-button"
            type="button"
            onClick={() => onConfirm(selectedWorkflowId)}
          >
            <SvgIcon name="activity" size={18} />
            {t("Generate selected workflow", "生成所选 Workflow")}
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkflowDeleteDialog({
  language,
  workflow,
  installedWorkflowCount,
  hasActiveSession,
  onCancel,
  onConfirm,
}: {
  language: AppLanguage;
  workflow: WorkflowSummary;
  installedWorkflowCount: number;
  hasActiveSession: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const t = (english: string, chinese: string) =>
    language === "zh" ? chinese : english;

  async function handleConfirm() {
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-workflow-title"
      aria-describedby="delete-workflow-impact delete-workflow-retention"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t("Cancel delete workflow", "取消删除 Workflow")}
        onClick={onCancel}
        disabled={isDeleting}
      />
      <section className="delete-workflow-dialog">
        <div className="delete-workflow-icon" aria-hidden="true">
          <SvgIcon name="trash" size={24} />
        </div>
        <div>
          <p className="section-kicker">
            {t("Delete workflow", "删除 Workflow")}
          </p>
          <h2 id="delete-workflow-title">{workflow.title}</h2>
          <p id="delete-workflow-impact" className="delete-workflow-impact">
            {installedWorkflowCount > 0
              ? t(
                  `This permanently removes the workflow from this workspace and removes its installation from ${installedWorkflowCount} AI worker${installedWorkflowCount === 1 ? "" : "s"}. Those workers will no longer be able to run it.`,
                  `这会从当前工作区永久删除该 Workflow，并移除它在 ${installedWorkflowCount} 个 AI Worker 上的安装关系。相关 Worker 将无法继续运行它。`,
                )
              : t(
                  "This permanently removes the workflow from this workspace. It is not currently installed on an AI worker.",
                  "这会从当前工作区永久删除该 Workflow。当前没有 AI Worker 安装它。",
                )}
          </p>
          <p id="delete-workflow-retention">
            {t(
              "Raw captures and run history are kept for audit. This action cannot be undone in the app.",
              "原始采集数据和运行历史将保留用于审计。此操作无法在应用内撤销。",
            )}
          </p>
          {hasActiveSession ? (
            <p className="delete-worker-blocked" role="alert">
              {t(
                "Stop every active run for this workflow before deleting it.",
                "请先停止此 Workflow 的所有活动运行，再执行删除。",
              )}
            </p>
          ) : null}
        </div>
        <div className="delete-workflow-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
          >
            {t("Cancel", "取消")}
          </button>
          <button
            className="primary-button danger"
            type="button"
            onClick={() => void handleConfirm()}
            disabled={hasActiveSession || isDeleting}
            aria-busy={isDeleting}
          >
            <SvgIcon name="trash" size={18} />
            {isDeleting
              ? t("Deleting...", "正在删除...")
              : t("Delete workflow", "删除 Workflow")}
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkerDeleteDialog({
  language,
  worker,
  installedWorkflowCount,
  hasActiveSession,
  onCancel,
  onConfirm,
}: {
  language: AppLanguage;
  worker: Worker;
  installedWorkflowCount: number;
  hasActiveSession: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const t = (english: string, chinese: string) =>
    language === "zh" ? chinese : english;

  async function handleConfirm() {
    setIsDeleting(true);
    try {
      await onConfirm();
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-worker-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={t("Cancel delete AI worker", "取消删除 AI Worker")}
        onClick={onCancel}
        disabled={isDeleting}
      />
      <section className="delete-workflow-dialog">
        <div className="delete-workflow-icon" aria-hidden="true">
          <SvgIcon name="trash" size={24} />
        </div>
        <div>
          <p className="section-kicker">
            {t("Delete AI worker", "删除 AI Worker")}
          </p>
          <h2 id="delete-worker-title">{worker.name}</h2>
          <p>
            {t(
              `This permanently removes the worker from this workspace, including its device assignment, message routing, and ${installedWorkflowCount} installed workflow${installedWorkflowCount === 1 ? "" : "s"}. Run history is kept for audit.`,
              `这会从当前工作区永久删除该 Worker，包括设备分配、消息路由和 ${installedWorkflowCount} 个已安装工作流。运行历史将保留用于审计。`,
            )}
          </p>
          {hasActiveSession ? (
            <p className="delete-worker-blocked" role="alert">
              {t(
                "Stop the active AI worker session before deleting it.",
                "请先停止正在运行的 AI Worker 会话，再执行删除。",
              )}
            </p>
          ) : null}
        </div>
        <div className="delete-workflow-actions">
          <button
            className="ghost-button"
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
          >
            {t("Cancel", "取消")}
          </button>
          <button
            className="primary-button danger"
            type="button"
            onClick={() => void handleConfirm()}
            disabled={hasActiveSession || isDeleting}
            aria-busy={isDeleting}
          >
            <SvgIcon name="trash" size={18} />
            {isDeleting
              ? t("Deleting...", "正在删除...")
              : t("Delete worker", "删除 Worker")}
          </button>
        </div>
      </section>
    </div>
  );
}

function WorkerDraftDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: WorkerDraftInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const dialogTitle = "New AI worker";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();
    const trimmedSource = sourceText.trim();
    if (trimmedName.length === 0 || trimmedDescription.length === 0) {
      setError("Add a worker name and scope before creating the worker.");
      return;
    }
    setIsSubmitting(true);
    try {
      await onCreate({
        name: trimmedName,
        description: trimmedDescription,
        channel: {
          platform: "none",
          accessMode: "disabled",
          homeChannel: null,
          allowedUsers: [],
          credentials: {},
          testAfterCreate: false,
        },
        sourceText: trimmedSource,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="modal-layer worker-profile-modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-draft-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={`Cancel ${dialogTitle.toLowerCase()}`}
        onClick={onCancel}
      />
      <form
        className="worker-draft-dialog worker-profile-dialog"
        onSubmit={handleSubmit}
      >
        <div className="modal-header">
          <div>
            <p className="section-kicker">Worker setup</p>
            <h2 id="worker-draft-title">{dialogTitle}</h2>
            <span>
              Create a worker profile first. Device assignment and workflow
              install happen after setup.
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={onCancel}
          >
            <SvgIcon name="close" />
          </button>
        </div>
        <div
          className="worker-draft-scroll-region"
          tabIndex={0}
          aria-label="Worker setup form"
          onKeyDown={handleScrollableRegionKeyDown}
        >
          <div className="worker-draft-form-grid">
            <label className="form-field form-field-wide">
              <span>Worker name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label className="form-field form-field-wide">
              <span>Identity and scope</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                required
              />
            </label>
            <label className="form-field form-field-wide">
              <span>Setup notes</span>
              <textarea
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="Optional behavior notes, operating boundaries, or approval expectations."
              />
            </label>
            <p className="form-grid-help">
              The worker starts unassigned. Install workflows and assign a
              device after reviewing its identity and scope.
            </p>
            {error ? (
              <p className="inline-error">
                {productizeWorkerFacingText(error)}
              </p>
            ) : null}
          </div>
        </div>
        <div className="modal-footer">
          <button
            className="ghost-button large"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="primary-button large"
            type="submit"
            disabled={isSubmitting}
          >
            <SvgIcon name="plus" />
            {isSubmitting ? "Creating..." : "Create worker"}
          </button>
        </div>
      </form>
    </div>
  );
}

type WorkerChannelWizardStep =
  "choose" | "configure" | "qr" | "discover" | "switch" | "complete";

function ChannelQrPreview({ payload }: { payload: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    setRenderError(null);
    void renderChannelQrDataUrl(payload)
      .then((value) => {
        if (active) setDataUrl(value);
      })
      .catch(() => {
        if (active) {
          setRenderError("The QR image could not be rendered.");
        }
      });
    return () => {
      active = false;
    };
  }, [payload, renderAttempt]);

  if (dataUrl) {
    return (
      <img
        className="channel-qr-image"
        src={dataUrl}
        alt="Channel pairing QR"
      />
    );
  }
  if (renderError) {
    return (
      <div className="channel-qr-render-error" role="alert">
        <SvgIcon name="activity" />
        <strong>{renderError}</strong>
        <button
          type="button"
          className="text-button"
          onClick={() => setRenderAttempt((value) => value + 1)}
        >
          Render again
        </button>
      </div>
    );
  }
  return (
    <div className="channel-qr-placeholder" aria-label="Preparing QR code" />
  );
}

/**
 * EN: Presents channel setup failures without exposing internal runtime names.
 * 中文: 以产品化文案展示渠道连接失败，不暴露内部运行时名称。
 * @param value raw runtime or UI error.
 * @param language active display language.
 * @returns localized user-facing error message.
 */
function channelSetupDisplayError(
  value: string,
  language: AppLanguage,
): string {
  const productized = productizeWorkerFacingText(value);
  if (language !== "zh") {
    return productized;
  }
  if (/out of date|latest OysterWorkflow build/iu.test(productized)) {
    return "当前 AI Worker 运行组件版本过旧，无法启动二维码连接。请安装最新版 OysterWorkflow 后重试。";
  }
  if (/did not produce a connection code/iu.test(productized)) {
    return "二维码连接进程没有生成连接码。请重试，或重新启动 OysterWorkflow。";
  }
  if (/stopped before it produced a connection code/iu.test(productized)) {
    return "二维码连接进程在生成连接码前已停止，请重试。";
  }
  return `连接失败：${productized}`;
}

function WorkerChannelSetupDialog({
  language,
  worker,
  productState,
  onCancel,
  onStateChange,
}: {
  language: AppLanguage;
  worker: ProductWorker | null;
  productState: ProductStateSnapshot | null;
  onCancel: () => void;
  onStateChange: (state: ProductStateSnapshot) => void | Promise<void>;
}) {
  const currentChannel =
    worker?.config.channel ?? defaultUiWorkerChannelConfig();
  const initialConnection = (productState?.channelConnections ?? []).find(
    (item) =>
      item.workerId === worker?.id && item.platform === currentChannel.platform,
  );
  const initialBinding = (productState?.channelBindings ?? []).find(
    (item) =>
      item.workerId === worker?.id &&
      item.connectionId === initialConnection?.id &&
      item.status === "bound",
  );
  const connectionCanDiscover =
    initialConnection?.status === "connecting" ||
    initialConnection?.status === "connected";
  const [step, setStep] = useState<WorkerChannelWizardStep>(
    initialConnection?.status === "connected" && initialBinding
      ? "complete"
      : connectionCanDiscover
        ? "discover"
        : "choose",
  );
  const [channelPlatform, setChannelPlatform] =
    useState<ProductWorkerChannelPlatform>(currentChannel.platform);
  const [accessMode] = useState<ProductWorkerChannelAccessMode>(
    currentChannel.accessMode === "disabled"
      ? "allowlist"
      : currentChannel.accessMode,
  );
  const [allowedUsersText, setAllowedUsersText] = useState(
    currentChannel.allowedUsers.join(", "),
  );
  const [credentialValues, setCredentialValues] = useState<
    Record<string, string>
  >({});
  const [whatsappMode, setWhatsappMode] = useState<"bot" | "self-chat">(
    "self-chat",
  );
  const [connection, setConnection] = useState<ProductChannelConnection | null>(
    initialConnection ?? null,
  );
  const [setup, setSetup] = useState<ProductChannelSetup | null>(null);
  const [peers, setPeers] = useState<ProductChannelPeer[]>([]);
  const [selectedPeerKey, setSelectedPeerKey] = useState("");
  const [manualConversationId, setManualConversationId] = useState("");
  const [deliveryConfirmed, setDeliveryConfirmed] = useState(false);
  const [pairingCode, setPairingCode] = useState("");
  const [pairingApproval, setPairingApproval] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [isApprovingPairing, setIsApprovingPairing] = useState(false);
  const [slackManifestCopied, setSlackManifestCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedChannel =
    WORKER_CHANNEL_OPTIONS.find(
      (option) => option.platform === channelPlatform,
    ) ?? WORKER_CHANNEL_OPTIONS[0];
  const credentialFields = WORKER_CHANNEL_CREDENTIAL_FIELDS[channelPlatform];
  const canReuseCredentials =
    currentChannel.platform === channelPlatform &&
    currentChannel.configuredFields.length > 0;
  const workerSessions = (productState?.runs ?? [])
    .filter(
      (run) =>
        run.workerId === worker?.id &&
        run.kind === "worker_session" &&
        Boolean(run.hermesSessionId),
    )
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  const [selectedSessionId, setSelectedSessionId] = useState(
    initialBinding?.hermesSessionId ?? workerSessions[0]?.hermesSessionId ?? "",
  );

  const activeWorker = worker;
  const activeWorkerId = activeWorker?.id ?? "";

  useSettledPolling({
    enabled:
      step === "qr" &&
      Boolean(setup) &&
      !isTerminalChannelSetupStatus(setup?.status),
    intervalMs: 1_500,
    restartKey: `${activeWorkerId}:${setup?.id ?? "none"}:${setup?.status ?? "idle"}:${step}`,
    poll: async ({ isCurrent }) => {
      const setupId = setup?.id;
      if (!setupId) {
        return;
      }
      try {
        const response = await readProductWorkerChannelSetup({
          workerId: activeWorkerId,
          setupId,
        });
        if (!isCurrent()) {
          return;
        }
        await onStateChange(response.state);
        if (!isCurrent()) {
          return;
        }
        setSetup((current) => {
          if (
            current?.id !== setupId ||
            isTerminalChannelSetupStatus(current.status)
          ) {
            return current;
          }
          return response.setup;
        });
        setConnection(response.connection);
        if (response.setup.status === "connected") {
          setStep("discover");
        } else if (response.setup.status === "failed") {
          setError(response.setup.lastError ?? "Channel pairing failed.");
        }
      } catch (pollError) {
        if (isCurrent()) {
          setError(toErrorMessage(pollError));
        }
      }
    },
  });

  if (!activeWorker) {
    return null;
  }

  async function closeDialog() {
    if (setup && !["connected", "failed", "cancelled"].includes(setup.status)) {
      try {
        const response = await cancelProductWorkerChannelSetup({
          workerId: activeWorkerId,
          setupId: setup.id,
        });
        await onStateChange(response.state);
      } catch {
        // Closing the dialog remains available if cancellation races process exit.
      }
    }
    onCancel();
  }

  async function saveWithoutChannel() {
    const response = await configureProductWorkerChannel({
      workerId: activeWorkerId,
      channel: { platform: "none", accessMode: "disabled" },
    });
    await onStateChange(response.state);
    onCancel();
  }

  async function connectTokenChannel() {
    const missingCredentials =
      credentialFields.some((field) => !credentialValues[field.key]?.trim()) &&
      !canReuseCredentials;
    if (missingCredentials) {
      setError("Enter the required app credentials to continue.");
      return;
    }
    const selectedCredentials = selectedChannelCredentials(
      credentialFields,
      credentialValues,
    );
    const credentialIssues = validateProductWorkerChannelCredentials(
      channelPlatform,
      selectedCredentials,
    );
    if (credentialIssues.length > 0) {
      setError(credentialIssues[0].message);
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const configured = await configureProductWorkerChannel({
        workerId: activeWorkerId,
        channel: {
          platform: channelPlatform,
          accessMode,
          allowedUsers: parseChannelList(allowedUsersText),
          credentials: selectedCredentials,
        },
      });
      await onStateChange(configured.state);
      const tested = await testProductWorkerChannel(activeWorkerId);
      await onStateChange(tested.state);
      const nextConnection = tested.state.channelConnections.find(
        (item) =>
          item.workerId === activeWorkerId && item.platform === channelPlatform,
      );
      setConnection(nextConnection ?? null);
      if (
        !nextConnection ||
        !["connecting", "connected"].includes(nextConnection.status)
      ) {
        setError(
          tested.channel.lastError ??
            "The gateway has not reported a live connection yet. Try again.",
        );
        return;
      }
      setStep("discover");
    } catch (connectError) {
      setError(toErrorMessage(connectError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function beginQrSetup() {
    if (channelPlatform !== "weixin" && channelPlatform !== "whatsapp") {
      return;
    }
    const allowedUsers =
      channelPlatform === "whatsapp" && whatsappMode === "bot"
        ? parseChannelList(allowedUsersText)
        : [];
    if (
      channelPlatform === "whatsapp" &&
      whatsappMode === "bot" &&
      allowedUsers.length === 0
    ) {
      setError("Add at least one allowed phone number for the bot account.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await beginProductWorkerChannelSetup({
        workerId: activeWorkerId,
        setup: {
          platform: channelPlatform,
          mode: channelPlatform === "whatsapp" ? whatsappMode : undefined,
          allowedUsers,
        },
      });
      await onStateChange(response.state);
      setSetup(response.setup);
      setConnection(response.connection);
      setStep("qr");
    } catch (setupError) {
      setError(toErrorMessage(setupError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copySlackManifest() {
    setError(null);
    try {
      await navigator.clipboard.writeText(buildProductSlackAppManifest());
      setSlackManifestCopied(true);
    } catch (copyError) {
      setError(toErrorMessage(copyError));
    }
  }

  async function openSlackAppCreator() {
    setError(null);
    try {
      await openExternalUrl(PRODUCT_SLACK_APP_CREATOR_URL);
    } catch (openError) {
      setError(toErrorMessage(openError));
    }
  }

  async function cancelCurrentQrSetup() {
    if (setup && !["connected", "failed", "cancelled"].includes(setup.status)) {
      const response = await cancelProductWorkerChannelSetup({
        workerId: activeWorkerId,
        setupId: setup.id,
      });
      await onStateChange(response.state);
    }
    setSetup(null);
    setConnection(null);
  }

  async function returnToChannelChoice() {
    setIsSubmitting(true);
    setError(null);
    try {
      await cancelCurrentQrSetup();
      setStep("choose");
    } catch (cancelError) {
      setError(toErrorMessage(cancelError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function retryQrSetup() {
    setIsSubmitting(true);
    setError(null);
    try {
      await cancelCurrentQrSetup();
    } catch (cancelError) {
      setError(toErrorMessage(cancelError));
      setIsSubmitting(false);
      return;
    }
    setIsSubmitting(false);
    await beginQrSetup();
  }

  async function refreshPeers() {
    if (!connection) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await listProductWorkerChannelPeers({
        workerId: activeWorkerId,
        connectionId: connection.id,
      });
      setPeers(response.peers);
      if (response.peers.length > 0 && !selectedPeerKey) {
        setSelectedPeerKey(channelPeerKey(response.peers[0]));
      }
    } catch (peerError) {
      setError(toErrorMessage(peerError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function approvePairingCode() {
    if (!connection) return;
    const normalizedCode = pairingCode.trim().toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/u.test(normalizedCode)) {
      setPairingError("Enter the 8-character code Slack sent you.");
      return;
    }
    setIsApprovingPairing(true);
    setPairingError(null);
    setPairingApproval(null);
    try {
      const response = await approveProductWorkerChannelPairing({
        workerId: activeWorkerId,
        pairing: {
          connectionId: connection.id,
          code: normalizedCode,
        },
      });
      await onStateChange(response.state);
      setPairingCode("");
      setPairingApproval(
        response.approval.userName || response.approval.userId,
      );
    } catch (approvalError) {
      setPairingError(toErrorMessage(approvalError));
    } finally {
      setIsApprovingPairing(false);
    }
  }

  async function bindSelectedConversation() {
    if (!connection) return;
    const selectedPeer = peers.find(
      (peer) => channelPeerKey(peer) === selectedPeerKey,
    );
    const conversationId =
      selectedPeer?.conversationId ?? manualConversationId.trim();
    if (!conversationId) {
      setError("Send a message to the connected account, then refresh.");
      return;
    }
    if (!selectedSessionId) {
      setError(
        "Start this AI worker first so there is an AI worker session to bind.",
      );
      return;
    }
    if (!deliveryConfirmed) {
      setError("Confirm that you received the worker reply before binding.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await bindProductWorkerChannel({
        workerId: activeWorkerId,
        binding: {
          connectionId: connection.id,
          conversationId,
          threadId: selectedPeer?.threadId ?? null,
          conversationType: selectedPeer?.conversationType ?? null,
          conversationLabel:
            selectedPeer?.senderId ?? selectedPeer?.conversationType ?? null,
          hermesSessionId: selectedSessionId,
          deliveryConfirmed: true,
        },
      });
      await onStateChange(response.state);
      setStep("complete");
    } catch (bindError) {
      setError(toErrorMessage(bindError));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function switchMessageApp() {
    if (!connection) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await disconnectProductWorkerChannel({
        workerId: activeWorkerId,
        connectionId: connection.id,
      });
      await onStateChange(response.state);
      setConnection(null);
      setSetup(null);
      setPeers([]);
      setSelectedPeerKey("");
      setManualConversationId("");
      setDeliveryConfirmed(false);
      setPairingCode("");
      setPairingApproval(null);
      setChannelPlatform("none");
      setStep("choose");
    } catch (disconnectError) {
      setError(toErrorMessage(disconnectError));
    } finally {
      setIsSubmitting(false);
    }
  }

  const qrInstruction =
    channelPlatform === "whatsapp"
      ? "Open WhatsApp → Settings → Linked Devices → Link a Device."
      : "Open WeChat and scan this code, then confirm on your phone.";
  const qrSetupError = step === "qr" ? (setup?.lastError ?? error) : null;
  const qrStatusLabel = qrSetupError
    ? "Connection code unavailable"
    : setup?.status === "authorizing"
      ? "Waiting for phone confirmation"
      : setup?.status === "awaiting_scan" && setup.qrPayload
        ? "Ready to scan"
        : setup?.status === "installing"
          ? "Preparing secure connector"
          : "Creating a secure code";

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="worker-channel-setup-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close message channel setup"
        onClick={() => void closeDialog()}
      />
      <div className="worker-draft-dialog channel-wizard-dialog">
        <div className="modal-header channel-wizard-header">
          <div>
            <p className="channel-dialog-context">
              <span className="channel-dialog-label">Message channels</span> /{" "}
              {activeWorker.name}
            </p>
            <h2 id="worker-channel-setup-title">
              {step === "switch"
                ? "Switch message app"
                : step === "complete"
                  ? `Manage ${selectedChannel.label}`
                  : "Connect a message channel"}
            </h2>
            <span>
              {step === "switch"
                ? `Disconnect ${selectedChannel.label} before choosing another app.`
                : step === "complete"
                  ? `This account is connected and bound to ${activeWorker.name}.`
                  : "Link an account first. You will choose the conversation and AI worker session after it is verified."}
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={() => void closeDialog()}
          >
            <SvgIcon name="close" />
          </button>
        </div>

        {step !== "complete" && step !== "switch" ? (
          <div className="channel-wizard-progress" aria-label="Setup progress">
            {["Connect", "Verify", "Bind"].map((label, index) => {
              const activeIndex =
                step === "choose" || step === "configure" || step === "qr"
                  ? 0
                  : 1;
              return (
                <span
                  key={label}
                  className={`${index < activeIndex ? "is-complete" : ""} ${
                    index === activeIndex ? "is-active" : ""
                  }`}
                  aria-current={index === activeIndex ? "step" : undefined}
                >
                  <i>
                    {index < activeIndex ? <SvgIcon name="check" /> : index + 1}
                  </i>
                  {label}
                </span>
              );
            })}
          </div>
        ) : null}

        <div className="worker-draft-form-grid channel-wizard-body">
          {step === "choose" ? (
            <section className="channel-choose-stage form-field-wide">
              <div className="channel-step-heading">
                <h3>Choose where messages arrive</h3>
                <p>
                  Each account stays on this computer. Connecting it does not
                  bind every conversation to the worker.
                </p>
              </div>
              <div
                className="channel-picker channel-wizard-picker"
                role="radiogroup"
              >
                {WORKER_CHANNEL_OPTIONS.map((option) => (
                  <button
                    key={option.platform}
                    type="button"
                    className={`channel-option ${option.platform === "none" ? "is-skip" : ""} ${
                      channelPlatform === option.platform ? "is-selected" : ""
                    }`}
                    role="radio"
                    aria-checked={channelPlatform === option.platform}
                    onClick={() => {
                      setChannelPlatform(option.platform);
                      setAllowedUsersText(
                        option.platform === currentChannel.platform
                          ? currentChannel.allowedUsers.join(", ")
                          : "",
                      );
                      setError(null);
                    }}
                  >
                    <span className="channel-option-icon">
                      {option.iconUrl ? (
                        <img src={option.iconUrl} alt="" />
                      ) : (
                        <SvgIcon name="chat" />
                      )}
                    </span>
                    <span>
                      <strong>{option.label}</strong>
                      <small>{option.summary}</small>
                    </span>
                    <span className="channel-option-check" aria-hidden="true">
                      {channelPlatform === option.platform ? (
                        <SvgIcon name="check" />
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              {channelPlatform === "weixin" ? (
                <p className="channel-context-note">
                  WeChat connects an iLink bot identity. It does not sign in to
                  or control your personal WeChat account.
                </p>
              ) : null}
              {channelPlatform === "whatsapp" ? (
                <>
                  <div className="channel-mode-choice">
                    <button
                      type="button"
                      className={
                        whatsappMode === "self-chat" ? "is-selected" : ""
                      }
                      onClick={() => setWhatsappMode("self-chat")}
                    >
                      <strong>My number</strong>
                      <small>Message yourself for the fastest setup.</small>
                    </button>
                    <button
                      type="button"
                      className={whatsappMode === "bot" ? "is-selected" : ""}
                      onClick={() => setWhatsappMode("bot")}
                    >
                      <strong>Bot number</strong>
                      <small>Use a separate WhatsApp or Business number.</small>
                    </button>
                  </div>
                  {whatsappMode === "bot" ? (
                    <label className="form-field channel-bot-allowlist">
                      <span>Allowed phone numbers</span>
                      <input
                        value={allowedUsersText}
                        onChange={(event) =>
                          setAllowedUsersText(event.target.value)
                        }
                        placeholder="15551234567, 15557654321"
                      />
                      <small>
                        Only these numbers can ask the worker to act.
                      </small>
                    </label>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {step === "configure" ? (
            <section className="channel-setup-panel form-field-wide">
              <div className="channel-setup-head">
                <span className="channel-option-icon">
                  {selectedChannel.iconUrl ? (
                    <img src={selectedChannel.iconUrl} alt="" />
                  ) : null}
                </span>
                <div>
                  <strong>Connect {selectedChannel.label}</strong>
                  <small>
                    {channelPlatform === "slack"
                      ? "Create a Socket Mode app, then paste its xoxb bot token and xapp app token."
                      : "Create a bot with BotFather, then paste the bot token here."}
                  </small>
                </div>
              </div>
              {channelPlatform === "slack" ? (
                <div className="slack-setup-guide">
                  <div className="slack-setup-guide-head">
                    <div>
                      <strong>Create the right Slack bot</strong>
                      <small>
                        Use an app manifest so Socket Mode, message events, App
                        Home, and bot permissions are configured together.
                      </small>
                    </div>
                    <div className="slack-setup-actions">
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void openSlackAppCreator()}
                      >
                        <SvgIcon name="arrowRight" size={16} />
                        Open Slack app creator
                      </button>
                      <button
                        className="ghost-button"
                        type="button"
                        onClick={() => void copySlackManifest()}
                      >
                        <SvgIcon
                          name={slackManifestCopied ? "check" : "download"}
                          size={16}
                        />
                        {slackManifestCopied
                          ? "Manifest copied"
                          : "Copy app manifest"}
                      </button>
                    </div>
                  </div>
                  <ol className="slack-setup-steps">
                    <li>
                      <span>1</span>
                      <p>
                        <strong>Create from an app manifest</strong>
                        <small>
                          Choose your Slack workspace, paste the copied JSON,
                          then create or update the app.
                        </small>
                      </p>
                    </li>
                    <li>
                      <span>2</span>
                      <p>
                        <strong>Create the xapp token</strong>
                        <small>
                          Basic Information - App-Level Tokens - Generate Token
                          and Scopes. Add connections:write.
                        </small>
                      </p>
                    </li>
                    <li>
                      <span>3</span>
                      <p>
                        <strong>Install the app for the xoxb token</strong>
                        <small>
                          Install App - Install to Workspace. Copy the Bot User
                          OAuth Token after Slack authorizes it.
                        </small>
                      </p>
                    </li>
                    <li>
                      <span>4</span>
                      <p>
                        <strong>Paste both tokens below</strong>
                        <small>
                          App ID, Client Secret, Signing Secret, and
                          Verification Token are not accepted here.
                        </small>
                      </p>
                    </li>
                  </ol>
                </div>
              ) : null}
              <div className="channel-credential-grid">
                {credentialFields.map((field) => (
                  <label className="form-field" key={field.key}>
                    <span>{field.label}</span>
                    <input
                      type={field.secret ? "password" : "text"}
                      autoComplete="new-password"
                      placeholder={
                        field.key === "SLACK_BOT_TOKEN"
                          ? "xoxb-..."
                          : field.key === "SLACK_APP_TOKEN"
                            ? "xapp-..."
                            : undefined
                      }
                      value={credentialValues[field.key] ?? ""}
                      onChange={(event) =>
                        setCredentialValues((current) => ({
                          ...current,
                          [field.key]: event.target.value,
                        }))
                      }
                    />
                    {field.key === "SLACK_BOT_TOKEN" ? (
                      <small>Bot User OAuth Token from Install App.</small>
                    ) : field.key === "SLACK_APP_TOKEN" ? (
                      <small>
                        App-level token with connections:write from Basic
                        Information.
                      </small>
                    ) : null}
                  </label>
                ))}
                <label className="form-field form-field-wide">
                  <span>Who can message this worker?</span>
                  <input
                    value={allowedUsersText}
                    onChange={(event) =>
                      setAllowedUsersText(event.target.value)
                    }
                    placeholder="User IDs or handles, separated by commas"
                  />
                  <small>
                    Leave blank only for a private engineering canary.
                  </small>
                </label>
              </div>
            </section>
          ) : null}

          {step === "qr" ? (
            <section
              className={`channel-qr-stage form-field-wide ${
                qrSetupError ? "is-error" : ""
              }`}
              aria-live="polite"
            >
              {qrSetupError ? (
                <div className="channel-qr-failure" role="alert">
                  <span>
                    <SvgIcon name="activity" />
                  </span>
                  <strong>Could not create a connection code</strong>
                  <small>
                    {channelSetupDisplayError(qrSetupError, language)}
                  </small>
                </div>
              ) : setup?.qrPayload ? (
                <ChannelQrPreview payload={setup.qrPayload} />
              ) : (
                <div
                  className="channel-qr-placeholder"
                  aria-label="Preparing QR code"
                >
                  <span />
                  <small>Preparing secure connection</small>
                </div>
              )}
              <div className="channel-qr-copy">
                <span
                  className={`channel-qr-status ${qrSetupError ? "is-error" : ""}`}
                >
                  <i /> {qrStatusLabel}
                </span>
                <div className="channel-qr-title">
                  <span className="channel-option-icon">
                    {selectedChannel.iconUrl ? (
                      <img src={selectedChannel.iconUrl} alt="" />
                    ) : null}
                  </span>
                  <h3>{selectedChannel.label}</h3>
                </div>
                <p>{qrInstruction}</p>
                <small>
                  The code is temporary. Credentials remain on this computer,
                  and OysterWorkflow stores only connection status.
                </small>
                {qrSetupError ? (
                  <button
                    className="secondary-button channel-retry-button"
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void retryQrSetup()}
                  >
                    <SvgIcon name="activity" />
                    {isSubmitting ? "Trying again..." : "Try again"}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {step === "discover" ? (
            <section className="channel-discovery-stage form-field-wide">
              <div className="channel-discovery-intro">
                <span className="channel-option-icon">
                  {selectedChannel.iconUrl ? (
                    <img src={selectedChannel.iconUrl} alt="" />
                  ) : null}
                </span>
                <div>
                  <p className="section-kicker">Account linked</p>
                  <h3>Send one message to {selectedChannel.label}</h3>
                  <p>
                    Send “hello” from the conversation you want to control this
                    worker. Oyster will discover it without asking for a chat
                    ID.
                  </p>
                </div>
              </div>
              {channelPlatform === "slack" ? (
                <div className="channel-pairing-approval">
                  <div>
                    <strong>Got a pairing code?</strong>
                    <small>
                      Paste the 8-character code Slack sent you. Oyster approves
                      this user on this computer.
                    </small>
                  </div>
                  <label>
                    <span>Pairing code</span>
                    <input
                      value={pairingCode}
                      maxLength={8}
                      autoCapitalize="characters"
                      autoComplete="one-time-code"
                      placeholder="AB12CDEF"
                      onChange={(event) => {
                        setPairingCode(
                          event.target.value
                            .toUpperCase()
                            .replace(/[^A-Z2-9]/gu, ""),
                        );
                        setPairingError(null);
                        setPairingApproval(null);
                      }}
                    />
                  </label>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={isApprovingPairing || pairingCode.length !== 8}
                    onClick={() => void approvePairingCode()}
                  >
                    {isApprovingPairing ? "Approving..." : "Approve code"}
                  </button>
                  {pairingApproval ? (
                    <p className="channel-pairing-success" role="status">
                      Access approved for {pairingApproval}. Send one new
                      message, then refresh.
                    </p>
                  ) : null}
                  {pairingError ? (
                    <p className="channel-pairing-error" role="alert">
                      {pairingError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              <button
                className="secondary-button"
                type="button"
                onClick={() => void refreshPeers()}
                disabled={isSubmitting}
              >
                <SvgIcon name="activity" />
                {isSubmitting ? "Looking..." : "Refresh messages"}
              </button>
              {peers.length > 0 ? (
                <div className="channel-peer-list" role="radiogroup">
                  {peers.map((peer) => {
                    const peerKey = channelPeerKey(peer);
                    return (
                      <button
                        key={peerKey}
                        type="button"
                        role="radio"
                        aria-checked={selectedPeerKey === peerKey}
                        className={
                          selectedPeerKey === peerKey ? "is-selected" : ""
                        }
                        onClick={() => setSelectedPeerKey(peerKey)}
                      >
                        <SvgIcon name={peer.bound ? "check" : "chat"} />
                        <span>
                          <strong>
                            {peer.senderId ?? peer.conversationType}
                          </strong>
                          <small>
                            Seen {formatRelativeTimestamp(peer.discoveredAt)}
                            {peer.bound ? " · already bound" : ""}
                          </small>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="channel-empty-state">
                  No message seen yet. Keep this window open and try refresh.
                </p>
              )}
              <details className="channel-advanced-binding">
                <summary>Advanced: enter a conversation ID</summary>
                <input
                  value={manualConversationId}
                  onChange={(event) =>
                    setManualConversationId(event.target.value)
                  }
                  placeholder="Conversation ID"
                />
              </details>
              <label className="channel-delivery-confirmation">
                <input
                  type="checkbox"
                  checked={deliveryConfirmed}
                  onChange={(event) =>
                    setDeliveryConfirmed(event.target.checked)
                  }
                />
                <span>
                  <strong>I received the worker's reply</strong>
                  <small>
                    This confirms inbound and outbound delivery both work.
                  </small>
                </span>
              </label>
              <label className="form-field form-field-wide">
                <span>Bind to AI worker session</span>
                <select
                  value={selectedSessionId}
                  onChange={(event) => setSelectedSessionId(event.target.value)}
                >
                  {workerSessions.length === 0 ? (
                    <option value="">
                      Start the worker to create a session
                    </option>
                  ) : null}
                  {workerSessions.map((run) => (
                    <option key={run.id} value={run.hermesSessionId ?? ""}>
                      {run.hermesSessionId} ·{" "}
                      {formatRelativeTimestamp(run.startedAt)}
                    </option>
                  ))}
                </select>
                <small>
                  New messages in this conversation will resume this exact
                  session.
                </small>
              </label>
            </section>
          ) : null}

          {step === "complete" ? (
            <section className="channel-complete-stage form-field-wide">
              <span className="channel-complete-icon">
                <SvgIcon name="check" />
              </span>
              <p className="section-kicker">Connected</p>
              <h3>Messages are ready</h3>
              <p>
                {`New messages in the bound conversation resume AI worker session ${selectedSessionId}.`}
              </p>
              <div className="channel-management-actions">
                <button
                  className="channel-management-action"
                  type="button"
                  aria-label="Change conversation"
                  onClick={() => setStep("discover")}
                >
                  <span>
                    <strong>Change conversation</strong>
                    <small>{`Keep this ${selectedChannel.label} app and bind a different conversation.`}</small>
                  </span>
                  <SvgIcon name="arrowRight" />
                </button>
                <button
                  className="channel-management-action is-destructive"
                  type="button"
                  aria-label="Switch app"
                  onClick={() => setStep("switch")}
                >
                  <span>
                    <strong>Switch app</strong>
                    <small>{`Disconnect ${selectedChannel.label} and choose another message app.`}</small>
                  </span>
                  <SvgIcon name="arrowRight" />
                </button>
              </div>
            </section>
          ) : null}

          {step === "switch" ? (
            <section className="channel-switch-stage form-field-wide">
              <span className="channel-switch-icon">
                <SvgIcon name="chat" />
              </span>
              <p className="section-kicker">Disconnect current app</p>
              <h3>{`Switch away from ${selectedChannel.label}?`}</h3>
              <p>{`${selectedChannel.label} will be disconnected from this AI worker. Existing message routing will stop until another app is connected and bound.`}</p>
            </section>
          ) : null}

          {error && step !== "qr" ? (
            <p className="inline-error form-field-wide" role="alert">
              {channelSetupDisplayError(error, language)}
            </p>
          ) : null}
        </div>

        <div className="modal-footer">
          {step !== "complete" ? (
            <button
              className="ghost-button large"
              type="button"
              onClick={() => {
                if (step === "configure") setStep("choose");
                else if (step === "qr") void returnToChannelChoice();
                else if (step === "switch") setStep("complete");
                else void closeDialog();
              }}
              disabled={isSubmitting}
            >
              {step === "configure" || step === "qr" ? "Back" : "Cancel"}
            </button>
          ) : (
            <span />
          )}
          {step === "choose" ? (
            <button
              className="primary-button large"
              type="button"
              disabled={isSubmitting}
              onClick={() => {
                if (channelPlatform === "none") void saveWithoutChannel();
                else if (selectedChannel.setupMethod === "qr")
                  void beginQrSetup();
                else setStep("configure");
              }}
            >
              Continue
            </button>
          ) : null}
          {step === "configure" ? (
            <button
              className="primary-button large"
              type="button"
              disabled={isSubmitting}
              onClick={() => void connectTokenChannel()}
            >
              {isSubmitting ? "Connecting..." : "Connect and verify"}
            </button>
          ) : null}
          {step === "discover" ? (
            <button
              className="primary-button large"
              type="button"
              disabled={isSubmitting || !deliveryConfirmed}
              onClick={() => void bindSelectedConversation()}
            >
              <SvgIcon name="check" />
              {isSubmitting ? "Binding..." : "Bind conversation"}
            </button>
          ) : null}
          {step === "switch" ? (
            <button
              className="primary-button danger large"
              type="button"
              disabled={isSubmitting}
              onClick={() => void switchMessageApp()}
            >
              {isSubmitting
                ? "Disconnecting..."
                : `Disconnect ${selectedChannel.label}`}
            </button>
          ) : null}
          {step === "complete" ? (
            <button
              className="primary-button large"
              type="button"
              onClick={onCancel}
            >
              Done
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DeviceAssignDialog({
  devices: deviceItems,
  workers: workerItems,
  initialDeviceId,
  initialWorkerId,
  onCancel,
  onAssign,
}: {
  devices: Device[];
  workers: Worker[];
  initialDeviceId: string;
  initialWorkerId?: string;
  onCancel: () => void;
  onAssign: (input: { workerId: string; deviceId: string }) => void;
}) {
  const [deviceId, setDeviceId] = useState(initialDeviceId);
  const [workerId, setWorkerId] = useState(
    initialWorkerId ?? workerItems[0]?.id ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const selectedDevice =
    deviceItems.find((device) => device.id === deviceId) ?? deviceItems[0];
  const selectedWorker =
    workerItems.find((worker) => worker.id === workerId) ?? workerItems[0];

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedDevice || !selectedWorker) {
      setError("Choose both a worker and a trusted computer.");
      return;
    }
    onAssign({ workerId: selectedWorker.id, deviceId: selectedDevice.id });
  }

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="device-assign-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Cancel assign device"
        onClick={onCancel}
      />
      <form className="device-assign-dialog" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="section-kicker">Device assignment</p>
            <h2 id="device-assign-title">Assign device</h2>
            <span>
              Connect a worker to a trusted computer before starting local
              automation.
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={onCancel}
          >
            <SvgIcon name="close" />
          </button>
        </div>
        <div className="device-assign-form-grid">
          <label className="form-field">
            <span>AI worker</span>
            <select
              value={workerId}
              onChange={(event) => setWorkerId(event.target.value)}
              required
            >
              {workerItems.map((worker) => (
                <option key={worker.id} value={worker.id}>
                  {worker.name}
                </option>
              ))}
            </select>
          </label>
          <label className="form-field">
            <span>Trusted computer</span>
            <select
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              required
            >
              {deviceItems.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                </option>
              ))}
            </select>
          </label>
          <div className="device-assignment-preview form-field-wide">
            <div>
              <span>Current device status</span>
              <strong>{selectedDevice?.status ?? "No device selected"}</strong>
              <small>{selectedDevice?.heartbeat ?? "Choose a device"}</small>
            </div>
            <div>
              <span>Worker status</span>
              <strong>{selectedWorker?.status ?? "No worker selected"}</strong>
              <small>{selectedWorker?.heartbeat ?? "Choose a worker"}</small>
            </div>
          </div>
          <p className="form-grid-help">
            Saving updates the local product database and the deploy target used
            when this worker starts installed workflows.
          </p>
          {error ? (
            <p className="inline-error">{productizeWorkerFacingText(error)}</p>
          ) : null}
        </div>
        <div className="modal-footer">
          <button
            className="ghost-button large"
            type="button"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button className="primary-button large" type="submit">
            <SvgIcon name="device" />
            Save assignment
          </button>
        </div>
      </form>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-card side-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const WORKER_APPLICATIONS_COPY: Record<
  AppLanguage,
  {
    title: string;
    chromeDetail: string;
    channelTitle: string;
    channelMissingDetail: string;
    channelConfiguredDetail: string;
    channelConnectedDetail: string;
    llmTitle: string;
    llmMissingDetail: string;
    llmUnavailableDetail: string;
    loadingDetail: string;
    missingDetail: string;
    checkLabel: string;
    setupAndCheckLabel: string;
    reconnectLabel: string;
    checkingLabel: string;
    configureLabel: string;
    manageLabel: string;
    statusLabels: Record<ProductCapabilityProviderStatus, string>;
    channelStatusLabels: {
      notConfigured: string;
      configured: string;
      connected: string;
      failed: string;
      testing: string;
    };
  }
> = {
  en: {
    title: "Connections",
    chromeDetail: "Signed-in browser workflows",
    channelTitle: "Message channel",
    channelMissingDetail: "Choose the message app this AI worker should use",
    channelConfiguredDetail: "Finish verification and bind a conversation",
    channelConnectedDetail: "Messages route directly to this AI worker",
    llmTitle: "LLM provider",
    llmMissingDetail: "Model connection has not been checked",
    llmUnavailableDetail: "Model connection could not be reached",
    loadingDetail: "Loading connection status",
    missingDetail: "Chrome capability is unavailable",
    checkLabel: "Check",
    setupAndCheckLabel: "Set up & check",
    reconnectLabel: "Reconnect",
    checkingLabel: "Checking",
    configureLabel: "Connect",
    manageLabel: "Manage",
    statusLabels: {
      not_checked: "Not checked",
      checking: "Checking",
      ready: "Ready",
      unavailable: "Needs attention",
    },
    channelStatusLabels: {
      notConfigured: "Not connected",
      configured: "Setup incomplete",
      connected: "Connected",
      failed: "Needs attention",
      testing: "Checking",
    },
  },
  zh: {
    title: "连接",
    chromeDetail: "已登录浏览器工作流",
    channelTitle: "消息渠道",
    channelMissingDetail: "选择这个 AI Worker 要使用的消息应用",
    channelConfiguredDetail: "完成验证并绑定一个对话",
    channelConnectedDetail: "消息会直接发送给这个 AI Worker",
    llmTitle: "LLM 提供方",
    llmMissingDetail: "尚未检测模型连接",
    llmUnavailableDetail: "模型连接不可用",
    loadingDetail: "正在加载连接状态",
    missingDetail: "Chrome 功能不可用",
    checkLabel: "检测",
    setupAndCheckLabel: "设置并检测",
    reconnectLabel: "重新连接",
    checkingLabel: "检测中",
    configureLabel: "连接",
    manageLabel: "管理",
    statusLabels: {
      not_checked: "未检测",
      checking: "检测中",
      ready: "可用",
      unavailable: "需要处理",
    },
    channelStatusLabels: {
      notConfigured: "未连接",
      configured: "设置未完成",
      connected: "已连接",
      failed: "需要处理",
      testing: "检测中",
    },
  },
};

function WorkerApplicationsPanel(input: {
  language: AppLanguage;
  provider: ProductCapabilityProvider | null;
  channel: ProductWorkerChannelConfig | null;
  hermes: ProductHermesStatus | null;
  isLoading: boolean;
  isChecking: boolean;
  isCheckingLlm: boolean;
  errorMessage: string | null;
  llmErrorMessage: string | null;
  onCheck: () => void | Promise<void>;
  onOpenChannel: () => void;
  onCheckLlm: () => void | Promise<void>;
}) {
  const copy = WORKER_APPLICATIONS_COPY[input.language];
  const effectiveChromeChecking =
    input.isChecking || input.provider?.status === "checking";
  const chromeStatus: ProductCapabilityProviderStatus = effectiveChromeChecking
    ? "checking"
    : (input.provider?.status ?? "not_checked");
  const chromeDetail = input.isLoading
    ? copy.loadingDetail
    : input.provider
      ? (formatChromeCapabilityDetail(
          input.provider,
          input.language,
          input.errorMessage,
        ) ?? copy.chromeDetail)
      : copy.missingDetail;
  const channel = input.channel;
  const activeChannel =
    channel &&
    channel.platform !== "none" &&
    channel.status !== "not_configured"
      ? channel
      : null;
  const channelTone = workerChannelStatusTone(activeChannel);
  const channelStatusLabel = !activeChannel
    ? copy.channelStatusLabels.notConfigured
    : activeChannel.status === "connected"
      ? copy.channelStatusLabels.connected
      : activeChannel.status === "failed"
        ? copy.channelStatusLabels.failed
        : activeChannel.status === "testing"
          ? copy.channelStatusLabels.testing
          : copy.channelStatusLabels.configured;
  const channelDetail = input.isLoading
    ? copy.loadingDetail
    : activeChannel?.lastError
      ? productizeWorkerFacingText(activeChannel.lastError)
      : activeChannel?.status === "connected"
        ? copy.channelConnectedDetail
        : activeChannel
          ? copy.channelConfiguredDetail
          : copy.channelMissingDetail;
  const llmStatus = hermesProviderCapabilityStatus(
    input.hermes,
    input.isCheckingLlm,
  );
  const llmDetail = input.isLoading
    ? copy.loadingDetail
    : input.hermes
      ? formatHermesProviderDetail({
          hermes: input.hermes,
          status: llmStatus,
          fallback: copy.llmUnavailableDetail,
          errorMessage: input.llmErrorMessage,
        })
      : (productizeOptionalWorkerFacingText(input.llmErrorMessage) ??
        copy.llmMissingDetail);

  return (
    <Panel title={copy.title}>
      <WorkerApplicationRow
        iconName="device"
        title={input.provider?.label ?? "Chrome"}
        detail={chromeDetail}
        status={chromeStatus}
        statusLabel={copy.statusLabels[chromeStatus]}
        isChecking={effectiveChromeChecking}
        isDisabled={
          input.isLoading || effectiveChromeChecking || !input.provider
        }
        actionLabel={
          chromeStatus === "ready"
            ? copy.checkLabel
            : isChromeWindowBindingFailure(input.provider?.lastError)
              ? copy.reconnectLabel
              : copy.setupAndCheckLabel
        }
        busyLabel={copy.checkingLabel}
        onAction={input.onCheck}
      />
      <WorkerApplicationRow
        iconName="chat"
        iconUrl={
          activeChannel ? workerChannelIconUrl(activeChannel.platform) : null
        }
        title={activeChannel ? activeChannel.label : copy.channelTitle}
        detail={channelDetail}
        tone={channelTone}
        statusLabel={channelStatusLabel}
        isChecking={activeChannel?.status === "testing"}
        isDisabled={input.isLoading}
        actionLabel={activeChannel ? copy.manageLabel : copy.configureLabel}
        busyLabel={copy.checkingLabel}
        onAction={input.onOpenChannel}
      />
      <WorkerApplicationRow
        iconName="network"
        title={copy.llmTitle}
        detail={llmDetail}
        status={llmStatus}
        statusLabel={copy.statusLabels[llmStatus]}
        isChecking={input.isCheckingLlm}
        isDisabled={input.isLoading || input.isCheckingLlm}
        actionLabel={copy.checkLabel}
        busyLabel={copy.checkingLabel}
        onAction={input.onCheckLlm}
      />
      {input.errorMessage ? (
        <p className="worker-application-error">
          {productizeWorkerFacingText(input.errorMessage)}
        </p>
      ) : null}
      {input.llmErrorMessage ? (
        <p className="worker-application-error">
          {productizeWorkerFacingText(input.llmErrorMessage)}
        </p>
      ) : null}
    </Panel>
  );
}

function productizeOptionalWorkerFacingText(
  value: string | null | undefined,
): string | null {
  return value ? productizeWorkerFacingText(value) : null;
}

function WorkerApplicationRow(input: {
  iconName: IconName;
  iconUrl?: string | null;
  title: string;
  detail: string;
  status?: ProductCapabilityProviderStatus;
  tone?: Tone;
  statusLabel: string;
  isChecking: boolean;
  isDisabled: boolean;
  actionLabel: string;
  busyLabel: string;
  onAction: () => void | Promise<void>;
}) {
  const tone =
    input.tone ?? capabilityStatusTone(input.status ?? "not_checked");
  return (
    <div className={`worker-application-row tone-${tone}`}>
      <span className="summary-icon">
        {input.iconUrl ? (
          <img src={input.iconUrl} alt="" />
        ) : (
          <SvgIcon name={input.iconName} />
        )}
      </span>
      <div className="worker-application-copy">
        <div className="worker-application-title-row">
          <strong>{input.title}</strong>
          <span className={`worker-application-status tone-${tone}`}>
            <StatusDot tone={tone} />
            {input.statusLabel}
          </span>
        </div>
        <small title={input.detail}>{input.detail}</small>
      </div>
      <button
        className="ghost-button compact worker-application-check"
        type="button"
        disabled={input.isDisabled}
        aria-busy={input.isChecking}
        onClick={input.onAction}
      >
        {input.isChecking ? input.busyLabel : input.actionLabel}
      </button>
    </div>
  );
}

function hermesProviderCapabilityStatus(
  hermes: ProductHermesStatus | null,
  isChecking: boolean,
): ProductCapabilityProviderStatus {
  if (isChecking) {
    return "checking";
  }
  if (!hermes) {
    return "not_checked";
  }
  if (isHermesProviderReady(hermes)) {
    return "ready";
  }
  if (
    !hermes.available ||
    hermes.providerHealth.status === "degraded" ||
    hermes.lastError
  ) {
    return "unavailable";
  }
  return "not_checked";
}

function isHermesProviderReady(hermes: ProductHermesStatus | null): boolean {
  return Boolean(
    hermes?.available &&
    hermes.providerHealth.status !== "degraded" &&
    !hermes.lastError,
  );
}

function formatHermesProviderDetail(input: {
  hermes: ProductHermesStatus;
  status: ProductCapabilityProviderStatus;
  fallback: string;
  errorMessage: string | null;
}): string {
  if (input.errorMessage) {
    return productizeWorkerFacingText(input.errorMessage);
  }
  if (input.status === "unavailable") {
    return productizeWorkerFacingText(
      input.hermes.providerHealth.message ??
        input.hermes.lastError ??
        input.fallback,
    );
  }
  const provider =
    input.hermes.provider ?? input.hermes.providerHealth.provider ?? "Provider";
  const model = input.hermes.model ?? input.hermes.providerHealth.model;
  return model ? `${provider} / ${model}` : provider;
}

function capabilityStatusTone(status: ProductCapabilityProviderStatus): Tone {
  if (status === "ready") {
    return "ready";
  }
  if (status === "checking") {
    return "working";
  }
  if (status === "unavailable") {
    return "warning";
  }
  return "idle";
}

interface ReadinessItem {
  label: string;
  value: string;
  tone: Tone;
}

function ActivityTimeline({ items }: { items: ActivityTimelineItem[] }) {
  return (
    <div className="activity-list">
      {items.map((activity) => {
        return (
          <div
            key={activity.id}
            className={`activity-row tone-${activity.tone}`}
          >
            <span className="activity-dot" />
            <span className="activity-copy">
              <strong>{activity.label}</strong>
              <small>{activity.detail}</small>
            </span>
            {activity.timestamp ? (
              <time>{formatClockTime(activity.timestamp)}</time>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ReadinessList({ items }: { items: ReadinessItem[] }) {
  return (
    <div className="readiness-list">
      {items.map((item) => (
        <div key={item.label} className={`readiness-row tone-${item.tone}`}>
          <StatusDot tone={item.tone} />
          <span>
            <strong>{item.label}</strong>
            <small>{item.value}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function activityToneForText(activity: string): Tone {
  const text = activity.toLowerCase();
  if (
    text.includes("missing") ||
    text.includes("needed") ||
    text.includes("pending") ||
    text.includes("required")
  ) {
    return "warning";
  }
  if (
    text.includes("recording") ||
    text.includes("capture active") ||
    text.includes("working")
  ) {
    return "working";
  }
  if (
    text.includes("assigned") ||
    text.includes("approved") ||
    text.includes("configured") ||
    text.includes("deployed") ||
    text.includes("prepared") ||
    text.includes("passed") ||
    text.includes("can start")
  ) {
    return "ready";
  }
  return "idle";
}

function buildWorkerActivityItems(
  worker: Worker,
  productState: ProductStateSnapshot | null,
): ActivityTimelineItem[] {
  if (!productState) {
    return fallbackWorkerActivityItems(worker);
  }

  const runItems = productState.runs
    .filter((run) => run.workerId === worker.id)
    .map((run): ActivityTimelineItem => ({
      id: `activity-run-${run.id}`,
      label: run.workflowTitle,
      detail:
        (run.errorMessage
          ? productizeWorkerFacingText(run.errorMessage)
          : null) ??
        `${productRunStatusLabel(run.status)}: ${productRunDetail(run)}`,
      tone: productRunTone(run.status),
      timestamp: run.endedAt ?? run.startedAt,
    }));
  const commandItems = productState.commands
    .filter((command) => command.workerId === worker.id)
    .map((command): ActivityTimelineItem => ({
      id: `activity-command-${command.id}`,
      label: "Command received",
      detail: command.command,
      tone: command.status === "accepted" ? "idle" : "danger",
      timestamp: command.createdAt,
    }));
  const eventItems = productState.runEvents
    .filter((event) => event.workerId === worker.id)
    .map((event): ActivityTimelineItem => ({
      id: `activity-event-${event.id}`,
      label: productizeWorkerFacingText(event.status),
      detail: productizeWorkerFacingText(event.body),
      tone: runEventTone(event),
      timestamp: event.createdAt,
    }));
  const items = [...runItems, ...commandItems, ...eventItems].sort(
    (left, right) => {
      const leftTime = left.timestamp ? Date.parse(left.timestamp) : 0;
      const rightTime = right.timestamp ? Date.parse(right.timestamp) : 0;
      return rightTime - leftTime;
    },
  );

  return items.length > 0
    ? items.slice(0, 8)
    : fallbackWorkerActivityItems(worker);
}

function fallbackWorkerActivityItems(worker: Worker): ActivityTimelineItem[] {
  return worker.activities.map((activity, index) => ({
    id: `activity-${worker.id}-${index}`,
    label: activity,
    detail: "Current worker setup state",
    tone: activityToneForText(activity),
    timestamp: null,
  }));
}

function WorkerAvatar({
  worker,
  size = "default",
}: {
  worker: Worker;
  size?: "default" | "large";
}) {
  return (
    <span className={`ai-worker-avatar ${size === "large" ? "is-large" : ""}`}>
      <img src={worker.avatarUrl} alt="" />
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`status-dot tone-${tone}`} aria-hidden="true" />;
}

function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return <span className={`status-pill tone-${tone}`}>{children}</span>;
}

function deviceTone(status: Device["status"]): Tone {
  if (status === "Available now") {
    return "ready";
  }
  if (status === "Idle today") {
    return "idle";
  }
  return "danger";
}

function deviceCode(name: string) {
  if (name.includes("MacBook")) {
    return "MBP";
  }
  if (name.includes("mini")) {
    return "MINI";
  }
  return "FIN";
}

function buildAgentWorkflowStages(workflowLabel: string): AgentWorkflowStage[] {
  return [
    {
      status: "Thinking",
      body: `I am interpreting the command against ${workflowLabel}, checking the saved workflow boundaries, and planning the first safe screen action.`,
      delayMs: 5800,
    },
    {
      status: "Opening workspace",
      body: "Opening the assigned app or website and checking that the visible state matches the installed workflow.",
      delayMs: 13200,
    },
    {
      status: "Reading context",
      body: "Reading the current screen for the key fields, constraints, and evidence needed before taking the next action.",
      delayMs: 22200,
    },
    {
      status: "Checking evidence",
      body: "Comparing visible details against the workflow instructions so the next step is based on observed evidence.",
      delayMs: 31800,
    },
    {
      status: "Cross-checking",
      body: "Opening supporting sources when the workflow calls for verification, then comparing them with the visible task context.",
      delayMs: 42000,
    },
    {
      status: "Preparing output",
      body: "Drafting the next result in the format expected by the installed workflow.",
      delayMs: 53600,
    },
    {
      status: "Checking boundary",
      body: "Pausing before any external or irreversible action if the workflow requires human review.",
      delayMs: 66800,
    },
    {
      status: "Finalizing",
      body: "Recording the visible result and the next recommended action without inventing missing facts.",
      delayMs: 80400,
    },
  ];
}

const AGENT_THREAD_BOTTOM_THRESHOLD_PX = 64;

/**
 * EN: Checks whether the Agent thread is close enough to the newest message.
 * 中文: 判断 Agent 消息线程是否足够接近最新消息位置。
 * @param node scrollable Agent thread element.
 * @returns true when auto-following new messages should remain enabled.
 */
function isAgentThreadNearBottom(node: HTMLElement): boolean {
  return (
    node.scrollHeight - node.scrollTop - node.clientHeight <=
    AGENT_THREAD_BOTTOM_THRESHOLD_PX
  );
}

/**
 * EN: Moves the Agent thread to the newest message with a graceful fallback.
 * 中文: 将 Agent 消息线程移动到最新消息，并兼容不支持 scrollTo 的环境。
 * @param node scrollable Agent thread element.
 * @returns nothing.
 */
function scrollAgentThreadToLatest(node: HTMLElement): void {
  if (typeof node.scrollTo === "function") {
    node.scrollTo({
      top: node.scrollHeight,
      behavior: "smooth",
    });
    return;
  }
  node.scrollTop = node.scrollHeight;
}

function WorkerAgentPanel({
  worker,
  isWorkerRunning,
  isWorkerProcessing,
  isCommandReady,
  hasWorkerExecutionStarted,
  deployedWorkflowTitle,
  runEvents,
  onSendCommand,
}: {
  worker: Worker;
  isWorkerRunning: boolean;
  isWorkerProcessing: boolean;
  isCommandReady: boolean;
  hasWorkerExecutionStarted: boolean;
  deployedWorkflowTitle: string | null;
  runEvents?: ProductRunEvent[];
  onSendCommand?: (command: string) => Promise<void>;
}) {
  const usesRealEvents = Boolean(runEvents);
  const agentRunEvents = useMemo(
    () => selectProductAgentConversationEvents(runEvents ?? []),
    [runEvents],
  );
  const hasRealEvents = agentRunEvents.length > 0;
  const showLiveThread = isWorkerRunning || hasRealEvents;
  const workflowLabel =
    deployedWorkflowTitle ?? "Extract action items from customer meeting";
  const agentStages = useMemo(
    () => buildAgentWorkflowStages(workflowLabel),
    [workflowLabel],
  );
  const [visibleStageCount, setVisibleStageCount] = useState(0);
  const [agentCommand, setAgentCommand] = useState<string | null>(null);
  const [pendingRealCommand, setPendingRealCommand] = useState<string | null>(
    null,
  );
  const [composerValue, setComposerValue] = useState("");
  const [showProcessingIndicator, setShowProcessingIndicator] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const shouldFollowLatestRef = useRef(true);
  const forceNextLatestScrollRef = useRef(false);
  const wasLiveThreadRef = useRef(false);
  const isSendingRealCommand = Boolean(pendingRealCommand);
  const canAttachContext = false;

  useEffect(() => {
    if (!isWorkerRunning) {
      setAgentCommand(null);
      setPendingRealCommand(null);
      setComposerValue("");
      setVisibleStageCount(0);
      setShowProcessingIndicator(false);
    }
  }, [isWorkerRunning]);

  useEffect(() => {
    if (usesRealEvents || !isWorkerProcessing || !agentCommand) {
      setVisibleStageCount(0);
      setShowProcessingIndicator(false);
      return;
    }

    setVisibleStageCount(0);
    setShowProcessingIndicator(false);
    const processingTimer = window.setTimeout(
      () => setShowProcessingIndicator(true),
      3200,
    );
    const timers = agentStages.map((stage, index) =>
      window.setTimeout(() => setVisibleStageCount(index + 1), stage.delayMs),
    );

    return () => {
      window.clearTimeout(processingTimer);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [agentCommand, agentStages, isWorkerProcessing, usesRealEvents]);

  useEffect(() => {
    if (!showLiveThread) {
      shouldFollowLatestRef.current = true;
      wasLiveThreadRef.current = false;
      return;
    }

    const node = threadRef.current;
    if (!node) {
      return;
    }

    const shouldForceLatest =
      forceNextLatestScrollRef.current || !wasLiveThreadRef.current;
    forceNextLatestScrollRef.current = false;
    wasLiveThreadRef.current = true;

    if (!shouldForceLatest && !shouldFollowLatestRef.current) {
      return;
    }

    scrollAgentThreadToLatest(node);
    shouldFollowLatestRef.current = true;
  }, [
    agentCommand,
    isWorkerProcessing,
    isWorkerRunning,
    runEvents,
    showLiveThread,
    pendingRealCommand,
    showProcessingIndicator,
    visibleStageCount,
  ]);

  function handleThreadScroll() {
    const node = threadRef.current;
    if (!node) {
      return;
    }
    shouldFollowLatestRef.current = isAgentThreadNearBottom(node);
  }

  const visibleStages = agentStages.slice(0, visibleStageCount);
  const nextStage =
    agentCommand && isWorkerProcessing && showProcessingIndicator
      ? agentStages[visibleStageCount]
      : null;
  const hasPendingRealCommandEvent = Boolean(
    pendingRealCommand &&
    agentRunEvents.some(
      (event) =>
        event.source === "user" &&
        event.body.trim() === pendingRealCommand.trim(),
    ),
  );

  async function handleAgentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isWorkerRunning || !isCommandReady) {
      return;
    }

    const command = composerValue.trim();
    if (!command) {
      return;
    }

    setComposerValue("");
    forceNextLatestScrollRef.current = true;
    if (usesRealEvents && onSendCommand) {
      setPendingRealCommand(command);
      try {
        await onSendCommand(command);
      } finally {
        setPendingRealCommand(null);
      }
      return;
    }

    setAgentCommand(command);
  }

  return (
    <section
      className="worker-agent-panel"
      aria-label={`${worker.name} agent`}
      aria-busy={isWorkerProcessing || isSendingRealCommand}
    >
      <div
        ref={threadRef}
        className={`agent-thread ${showLiveThread ? "is-live" : ""}`}
        onScroll={handleThreadScroll}
      >
        {showLiveThread ? (
          <>
            {usesRealEvents ? (
              <>
                {hasRealEvents ? (
                  agentRunEvents.map((event) =>
                    event.source === "user" ? (
                      <AgentUserMessage key={event.id} body={event.body} />
                    ) : isProductSystemAgentEvent(event) ? (
                      <AgentSystemMessage
                        key={event.id}
                        status={productizeWorkerFacingText(event.status)}
                        body={productizeWorkerFacingText(event.body)}
                      />
                    ) : (
                      <AgentMessage
                        key={event.id}
                        worker={worker}
                        status={productizeWorkerFacingText(event.status)}
                        body={productizeWorkerFacingText(event.body)}
                      />
                    ),
                  )
                ) : (
                  <AgentMessage
                    worker={worker}
                    status="AI worker initializing"
                    body={`${worker.name} is initializing on the assigned computer.`}
                  />
                )}
                {pendingRealCommand ? (
                  <>
                    {hasPendingRealCommandEvent ? null : (
                      <AgentUserMessage body={pendingRealCommand} />
                    )}
                    <AgentProcessingRow
                      worker={worker}
                      status="AI worker working"
                    />
                  </>
                ) : usesRealEvents && isWorkerProcessing && !isCommandReady ? (
                  <AgentProcessingRow
                    worker={worker}
                    status={
                      hasWorkerExecutionStarted
                        ? "AI worker working"
                        : "AI worker initializing"
                    }
                  />
                ) : null}
              </>
            ) : (
              <>
                <AgentMessage
                  worker={worker}
                  status="Initialized"
                  body={`${worker.name} Initialized`}
                />
                {agentCommand ? <AgentUserMessage body={agentCommand} /> : null}
                {visibleStages.map((stage) => (
                  <AgentMessage
                    key={stage.status}
                    worker={worker}
                    status={stage.status}
                    body={stage.body}
                  />
                ))}
                {nextStage ? (
                  <AgentProcessingRow
                    worker={worker}
                    status={nextStage.status}
                  />
                ) : null}
              </>
            )}
          </>
        ) : (
          <AgentMessage
            worker={worker}
            status="Worker not started"
            body="Start worker to prepare an AI worker session before sending live commands."
          />
        )}
      </div>

      <form className="agent-composer" onSubmit={handleAgentSubmit}>
        <button
          className="composer-icon-button"
          type="button"
          aria-label="Attach context"
          disabled={
            !canAttachContext ||
            !isWorkerRunning ||
            !isCommandReady ||
            isSendingRealCommand
          }
          title="Context attachments are not available until the command protocol supports them."
        >
          <SvgIcon name="plus" size={18} />
        </button>
        <input
          aria-label={`Message ${worker.name}`}
          value={composerValue}
          disabled={!isWorkerRunning || !isCommandReady || isSendingRealCommand}
          onChange={(event) => setComposerValue(event.target.value)}
          placeholder={
            isSendingRealCommand
              ? "AI worker is processing the command..."
              : isWorkerRunning
                ? isCommandReady
                  ? agentCommand
                    ? `Message ${worker.name}...`
                    : "Tell the AI worker what to do next"
                  : hasWorkerExecutionStarted
                    ? "AI worker is working on the workflow..."
                    : "Waiting for AI worker to finish initializing..."
                : "Run a workflow to send live commands"
          }
        />
        <button
          className="composer-send-button"
          type="submit"
          disabled={
            !isWorkerRunning ||
            !isCommandReady ||
            isSendingRealCommand ||
            !composerValue.trim()
          }
          aria-label="Send message"
        >
          <SvgIcon name="arrowRight" size={18} />
        </button>
      </form>
    </section>
  );
}

function AgentMessage({
  worker,
  status,
  body,
}: {
  worker: Worker;
  status: string;
  body: string;
}) {
  const tone = agentMessageTone(status);
  return (
    <div className="agent-message is-agent">
      <img className="agent-speaker-avatar" src={worker.avatarUrl} alt="" />
      <div className={`agent-message-body tone-${tone}`}>
        <div className="agent-message-meta">
          <strong>{worker.name}</strong>
          <span>{status}</span>
        </div>
        <p>{body}</p>
      </div>
    </div>
  );
}

function AgentUserMessage({ body }: { body: string }) {
  return (
    <div className="agent-message is-user">
      <div className="agent-message-body">
        <div className="agent-message-meta">
          <strong>Alex</strong>
          <span>Command</span>
        </div>
        <p>{body}</p>
      </div>
    </div>
  );
}

function AgentSystemMessage({
  status,
  body,
}: {
  status: string;
  body: string;
}) {
  const tone = agentMessageTone(status);
  return (
    <div className="agent-message is-system">
      <div className={`agent-message-body tone-${tone}`}>
        <div className="agent-message-meta">
          <strong>OysterWorkflow</strong>
          <span>{status}</span>
        </div>
        <p>{body}</p>
      </div>
    </div>
  );
}

function AgentProcessingRow({
  worker,
  status,
}: {
  worker: Worker;
  status: string;
}) {
  return (
    <div className="agent-message is-agent is-processing">
      <img className="agent-speaker-avatar" src={worker.avatarUrl} alt="" />
      <div className="agent-message-body is-processing">
        <div className="agent-message-meta">
          <strong>{worker.name}</strong>
          <span>{status}</span>
        </div>
        <p>Worker is running the next step...</p>
        <span className="agent-progress-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
    </div>
  );
}

function WorkerInstalledWorkflowsPanel({
  workflows,
  installedCount,
  totalCount,
  searchQuery,
  statusFilter,
  activeRunInstalledWorkflowId,
  activeRunStatus,
  hasActiveRun,
  onWorkflowAction,
  page,
  pageCount,
  pageSize,
  onSearchQueryChange,
  onStatusFilterChange,
  onPageChange,
  isLoading,
}: {
  workflows: InstalledWorkflow[];
  installedCount: number;
  totalCount: number;
  searchQuery: string;
  statusFilter: InstalledWorkflowStatusFilter;
  activeRunInstalledWorkflowId: string | null;
  activeRunStatus: ProductRun["status"] | null;
  hasActiveRun: boolean;
  onWorkflowAction: (workflow: InstalledWorkflow, action: string) => void;
  page: number;
  pageCount: number;
  pageSize: number;
  onSearchQueryChange: (query: string) => void;
  onStatusFilterChange: (status: InstalledWorkflowStatusFilter) => void;
  onPageChange: (page: number) => void;
  isLoading: boolean;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const handlePageChange = (nextPage: number) => {
    onPageChange(nextPage);
    window.requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ block: "start" });
    });
  };

  if (isLoading) {
    return <InstalledWorkflowLoadingPanel />;
  }

  if (installedCount === 0) {
    return (
      <section className="installed-workflows-panel is-empty">
        <div>
          <h3>No installed workflows</h3>
          <p>
            Install a workflow from the Workflows page to give this worker a
            repeatable capability.
          </p>
        </div>
      </section>
    );
  }

  const visibleStart = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const visibleEnd = Math.min(totalCount, visibleStart + workflows.length - 1);
  const pageNumbers = Array.from(
    { length: pageCount },
    (_, index) => index + 1,
  );
  const statusOptions: InstalledWorkflowStatusFilter[] = [
    "All",
    "Enabled",
    "Paused",
  ];

  return (
    <section
      ref={panelRef}
      className="installed-workflows-panel"
      aria-label="Installed workflows"
    >
      <div className="installed-workflows-header">
        <div>
          <h3>Installed workflows</h3>
          <p>
            Manage the capabilities this worker can run on assigned devices.
          </p>
        </div>
        <div className="workflow-list-controls" aria-label="Workflow filters">
          <label>
            <span>Search</span>
            <input
              value={searchQuery}
              placeholder="Search workflows"
              aria-label="Search workflows"
              onChange={(event) => onSearchQueryChange(event.target.value)}
            />
          </label>
          <label>
            <span>Status</span>
            <select
              aria-label="Filter workflow status"
              value={statusFilter}
              onChange={(event) =>
                onStatusFilterChange(
                  event.target.value as InstalledWorkflowStatusFilter,
                )
              }
            >
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status === "All" ? "All statuses" : status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {workflows.length > 0 ? (
        <div className="installed-workflow-list" role="list">
          {workflows.map((workflow) => {
            const isCurrentThisWorkflow =
              activeRunInstalledWorkflowId === workflow.id;
            const isRunningThisWorkflow =
              isCurrentThisWorkflow && activeRunStatus === "running";
            const hasOtherActiveRun = hasActiveRun && !isCurrentThisWorkflow;
            const executeDisabled =
              !isCurrentThisWorkflow &&
              (workflow.status !== "Enabled" || hasOtherActiveRun);
            const executeLabel = isRunningThisWorkflow
              ? `Pause ${workflow.name}`
              : isCurrentThisWorkflow
                ? `Resume ${workflow.name}`
                : `Run ${workflow.name}`;
            const executeTitle = isRunningThisWorkflow
              ? `Pause ${workflow.name}`
              : isCurrentThisWorkflow
                ? `Resume ${workflow.name}`
                : workflow.status !== "Enabled"
                  ? `Enable ${workflow.name} before running`
                  : hasOtherActiveRun
                    ? "Pause the active workflow before starting another one"
                    : `Run ${workflow.name}`;

            return (
              <article
                key={workflow.id}
                className={`installed-workflow-row tone-${installedWorkflowTone(
                  workflow.status,
                )} ${isCurrentThisWorkflow ? "is-running" : ""}`}
                role="listitem"
              >
                <div className="installed-workflow-main">
                  <div className="installed-workflow-title-row">
                    <h4>{workflow.name}</h4>
                    <StatusPill tone={installedWorkflowTone(workflow.status)}>
                      {workflow.status}
                    </StatusPill>
                  </div>
                  <p>{workflow.description}</p>
                  <InstalledWorkflowAppList apps={workflow.apps} />
                </div>

                <div className="installed-workflow-metrics">
                  <Metric label="Runs" value={String(workflow.runs)} />
                  <Metric label="Success" value={String(workflow.successes)} />
                  <Metric label="Last run" value={workflow.lastRun} />
                </div>

                <div
                  className="installed-workflow-actions"
                  aria-label={`${workflow.name} actions`}
                >
                  <button
                    type="button"
                    className={`workflow-execute-button ${
                      isRunningThisWorkflow ? "is-running" : ""
                    }`}
                    aria-label={executeLabel}
                    aria-pressed={isRunningThisWorkflow}
                    title={executeTitle}
                    disabled={executeDisabled}
                    onClick={() => onWorkflowAction(workflow, "Run")}
                  >
                    <SvgIcon
                      name={isRunningThisWorkflow ? "pause" : "play"}
                      size={18}
                    />
                    <span className="sr-only">{executeLabel}</span>
                  </button>
                  <div className="installed-workflow-secondary-actions">
                    {installedWorkflowActions(workflow).map((action) => {
                      const actionLabel =
                        action === "Remove"
                          ? `Remove ${workflow.name}`
                          : `${action} ${workflow.name}`;
                      return (
                        <button
                          key={action}
                          type="button"
                          className={`icon-action-button ${
                            action === "Remove" ? "danger-action-button" : ""
                          }`}
                          aria-label={actionLabel}
                          title={actionLabel}
                          onClick={() => onWorkflowAction(workflow, action)}
                        >
                          <SvgIcon
                            name={installedWorkflowActionIcon(action)}
                            size={action === "Remove" ? 16 : 15}
                          />
                          <span className="sr-only">{action}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="installed-workflow-filter-empty">
          <strong>No matching workflows</strong>
          <span>
            Adjust the search or status filter to see installed capabilities.
          </span>
        </div>
      )}
      {totalCount > workflows.length ? (
        <nav
          className="installed-workflow-pagination"
          aria-label="Installed workflow pages"
        >
          <span>
            Showing {visibleStart}-{visibleEnd} of {totalCount} matching
            workflows
          </span>
          <div className="pagination-buttons">
            <button
              type="button"
              disabled={page === 1}
              onClick={() => handlePageChange(Math.max(1, page - 1))}
            >
              Previous
            </button>
            {pageNumbers.map((pageNumber) => (
              <button
                key={pageNumber}
                type="button"
                className={pageNumber === page ? "is-active" : ""}
                aria-current={pageNumber === page ? "page" : undefined}
                onClick={() => handlePageChange(pageNumber)}
              >
                {pageNumber}
              </button>
            ))}
            <button
              type="button"
              disabled={page === pageCount}
              onClick={() => handlePageChange(Math.min(pageCount, page + 1))}
            >
              Next
            </button>
          </div>
        </nav>
      ) : null}
    </section>
  );
}

function InstalledWorkflowLoadingPanel() {
  return (
    <section
      className="installed-workflows-panel is-loading"
      aria-busy="true"
      aria-label="Installed workflows"
    >
      <div className="installed-workflows-header">
        <div>
          <h3>Installed workflows</h3>
          <p>Loading installed workflows...</p>
        </div>
      </div>
      <div className="installed-workflow-list" role="list">
        {[0, 1, 2].map((item) => (
          <article
            key={item}
            className="installed-workflow-row installed-workflow-skeleton"
            role="listitem"
          >
            <div className="installed-workflow-main">
              <span className="skeleton-line skeleton-title" />
              <span className="skeleton-line skeleton-body" />
              <span className="skeleton-pill-row">
                <span className="skeleton-pill" />
                <span className="skeleton-pill" />
                <span className="skeleton-pill" />
              </span>
            </div>
            <div className="installed-workflow-metrics">
              <span className="skeleton-metric" />
              <span className="skeleton-metric" />
              <span className="skeleton-metric" />
            </div>
            <div className="installed-workflow-actions">
              <span className="skeleton-action" />
              <span className="skeleton-icon-row">
                <span className="skeleton-icon" />
                <span className="skeleton-icon" />
                <span className="skeleton-icon" />
              </span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function InstalledWorkflowAppList({ apps }: { apps: string[] }) {
  return (
    <div className="installed-app-list" aria-label="Workflow apps">
      {apps.map((app) => {
        const identity = resolveWorkflowApp(app);
        return (
          <span key={`${identity.id}-${app}`}>
            <img src={identity.icon} alt="" />
            {identity.label}
          </span>
        );
      })}
    </div>
  );
}

function InstalledWorkflowRunHistoryDialog({
  workflow,
  productState,
  onClose,
}: {
  workflow: InstalledWorkflow;
  productState: ProductStateSnapshot;
  onClose: () => void;
}) {
  const runs = useMemo(
    () =>
      productState.runs
        .filter((run) => run.installedWorkflowId === workflow.id)
        .sort(
          (left, right) =>
            Date.parse(right.startedAt) - Date.parse(left.startedAt),
        ),
    [productState.runs, workflow.id],
  );
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    runs[0]?.id ?? null,
  );
  const selectedRun =
    runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null;
  const events = selectedRun
    ? productState.runEvents
        .filter((event) => event.runId === selectedRun.id)
        .sort(
          (left, right) =>
            Date.parse(left.createdAt) - Date.parse(right.createdAt),
        )
    : [];
  useEffect(() => {
    setSelectedRunId(runs[0]?.id ?? null);
  }, [runs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="run-history-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close run history"
        onClick={onClose}
      />
      <section className="run-history-modal">
        <header className="modal-header">
          <div>
            <p className="section-kicker">Installed workflow runs</p>
            <h2 id="run-history-title">{workflow.name}</h2>
            <span>{workflow.description}</span>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <SvgIcon name="close" />
          </button>
        </header>

        <div className="run-history-summary" aria-label="Run summary">
          <Metric label="Runs" value={String(workflow.runs)} />
          <Metric label="Success" value={String(workflow.successes)} />
          <Metric label="Last run" value={workflow.lastRun} />
          <Metric label="Device" value={workflow.device} />
        </div>

        <div className="run-history-grid">
          <aside className="run-history-list" aria-label="Workflow runs">
            {runs.length > 0 ? (
              runs.map((run) => {
                const tone = productRunTone(run.status);
                return (
                  <button
                    key={run.id}
                    type="button"
                    className={run.id === selectedRun?.id ? "is-selected" : ""}
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <StatusDot tone={tone} />
                    <span>
                      <strong>{productRunStatusLabel(run.status)}</strong>
                      <small>{formatRunHistoryTimestamp(run)}</small>
                    </span>
                    <b>{formatRunDuration(run)}</b>
                  </button>
                );
              })
            ) : (
              <div className="run-history-empty">
                <strong>No detailed runs yet</strong>
                <span>
                  This workflow has aggregate history, but detailed run records
                  will start after the next local execution.
                </span>
              </div>
            )}
          </aside>

          <div className="run-history-detail">
            {selectedRun ? (
              <>
                <div className="run-history-detail-head">
                  <StatusPill tone={productRunTone(selectedRun.status)}>
                    {productRunStatusLabel(selectedRun.status)}
                  </StatusPill>
                  <span>{selectedRun.id}</span>
                </div>
                <div className="run-history-detail-grid">
                  <Metric
                    label="Started"
                    value={formatAbsoluteTimestamp(selectedRun.startedAt)}
                  />
                  <Metric
                    label="Ended"
                    value={
                      selectedRun.endedAt
                        ? formatAbsoluteTimestamp(selectedRun.endedAt)
                        : "Still active"
                    }
                  />
                  <Metric
                    label="AI worker session"
                    value={selectedRun.hermesSessionId ?? "Not recorded"}
                  />
                </div>
                {selectedRun.errorMessage ? (
                  <div className="run-history-error">
                    {productizeWorkerFacingText(selectedRun.errorMessage)}
                  </div>
                ) : null}
                <RunHistorySection
                  title="Run events"
                  emptyText="No detailed step events were recorded for this run."
                >
                  {events.map((event) => (
                    <RunEventRow key={event.id} event={event} />
                  ))}
                </RunHistorySection>
              </>
            ) : (
              <div className="run-history-empty is-detail">
                <strong>No run selected</strong>
                <span>
                  Select a run after this workflow has executed on a local
                  device.
                </span>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function RunHistorySection({
  title,
  emptyText,
  children,
}: {
  title: string;
  emptyText: string;
  children: ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const hasItems = items.some(Boolean);
  return (
    <section className="run-history-section">
      <h3>{title}</h3>
      {hasItems ? (
        <div className="run-history-section-list">{children}</div>
      ) : (
        <p>{emptyText}</p>
      )}
    </section>
  );
}

function RunEventRow({ event }: { event: ProductRunEvent }) {
  return (
    <div className="run-history-event-row">
      <StatusDot tone={runEventTone(event)} />
      <span>
        <strong>{productizeWorkerFacingText(event.status)}</strong>
        <small>{productizeWorkerFacingText(event.body)}</small>
      </span>
      <time>{formatClockTime(event.createdAt)}</time>
    </div>
  );
}

function productRunTone(status: ProductRun["status"]): Tone {
  const toneMap: Record<ProductRun["status"], Tone> = {
    queued: "idle",
    running: "working",
    waiting_for_user: "warning",
    blocked: "danger",
    succeeded: "ready",
    failed: "danger",
    cancelled: "idle",
    paused: "warning",
  };
  return toneMap[status];
}

function productRunStatusLabel(status: ProductRun["status"]): string {
  const labelMap: Record<ProductRun["status"], string> = {
    queued: "Queued",
    running: "Running",
    waiting_for_user: "Waiting for user",
    blocked: "Blocked",
    succeeded: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    paused: "Paused",
  };
  return labelMap[status];
}

function runEventTone(event: ProductRunEvent): Tone {
  const status = event.status.toLowerCase();
  if (/failed|error|blocked|denied|setup failed/u.test(status)) {
    return "danger";
  }
  if (/approval|waiting|needs|queued/u.test(status)) {
    return "warning";
  }
  if (event.source === "user") {
    return "idle";
  }
  if (event.source === "hermes" || event.source === "executor") {
    return "working";
  }
  return "ready";
}

function agentMessageTone(status: string): Tone {
  const normalized = status.toLowerCase();
  if (/failed|error|blocked|denied|setup failed/u.test(normalized)) {
    return "danger";
  }
  if (/approval|waiting|needs|queued/u.test(normalized)) {
    return "warning";
  }
  if (/started|response|selected|running|processing/u.test(normalized)) {
    return "working";
  }
  return "ready";
}

function formatRunHistoryTimestamp(run: ProductRun): string {
  if (run.command) {
    return run.command;
  }
  return formatProductRunTimestamp(run);
}

function formatRunDuration(run: ProductRun): string {
  if (run.status === "running" || run.status === "queued") {
    return "Live";
  }
  if (!run.endedAt) {
    return "--";
  }
  const durationMs = Date.parse(run.endedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "--";
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatAbsoluteTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function formatClockTime(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function InstalledWorkflowSidebar({
  worker,
  isWorkerRunning,
  recentRuns,
}: {
  worker: Worker;
  isWorkerRunning: boolean;
  recentRuns: WorkflowRunEvent[];
}) {
  const visibleRecentRuns = Array.from(
    new Map(recentRuns.map((run) => [run.id, run])).values(),
  );
  return (
    <>
      <Panel title="Recent workflow runs">
        {visibleRecentRuns.length > 0 ? (
          <div className="workflow-run-list">
            {visibleRecentRuns.map((run) => (
              <div key={run.id} className={`workflow-run-row tone-${run.tone}`}>
                <StatusDot tone={run.tone} />
                <span>
                  <strong>{run.workflowName}</strong>
                  <small>
                    {run.status}: {run.detail}
                  </small>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="side-empty-state">
            Runs will appear after this worker has an installed workflow and its
            Run button is pressed.
          </p>
        )}
      </Panel>

      <Panel title="Runtime health">
        <ReadinessList
          items={[
            {
              label: "Heartbeat",
              value: worker.heartbeat,
              tone: worker.device === "Unassigned" ? "idle" : "ready",
            },
            {
              label: "Idle policy",
              value: isWorkerRunning ? "Watching queue" : "Think when idle",
              tone: isWorkerRunning ? "working" : "idle",
            },
            {
              label: "Approval policy",
              value: "Allow all",
              tone: "ready",
            },
          ]}
        />
      </Panel>
    </>
  );
}

function AccountUtilityDialog({
  panel,
  accountIdentity,
  workspaceName,
  notifications,
  onClose,
  onOpenAccountSettings,
}: {
  panel: AccountUtilityPanel;
  accountIdentity: AccountDisplayIdentity;
  workspaceName: string;
  notifications: AccountNotification[];
  onClose: () => void;
  onOpenAccountSettings: () => void;
}) {
  const isNotifications = panel === "notifications";
  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-utility-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label={`Close ${isNotifications ? "notifications" : "help"}`}
        onClick={onClose}
      />
      <section className="account-utility-dialog">
        <div className="modal-header">
          <div>
            <p className="section-kicker">
              {isNotifications ? "Workspace status" : "Operator help"}
            </p>
            <h2 id="account-utility-title">
              {isNotifications ? "Notifications" : "Help"}
            </h2>
            <span>
              {isNotifications
                ? `${workspaceName} is signed in as ${
                    accountIdentity.email || accountIdentity.name
                  }.`
                : "Use these shortcuts while presenting or testing the local product."}
            </span>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            <SvgIcon name="close" />
          </button>
        </div>

        {isNotifications ? (
          <div className="account-utility-body">
            <div className="notification-list" aria-label="Notifications list">
              {notifications.map((notification) => (
                <article
                  key={notification.id}
                  className={`notification-item tone-${notification.tone}`}
                >
                  <StatusDot tone={notification.tone} />
                  <div>
                    <div className="notification-title-row">
                      <strong>{notification.title}</strong>
                      <span>{notification.meta}</span>
                    </div>
                    <p>{notification.body}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : (
          <div className="account-utility-body help-grid">
            <article>
              <strong>Demo path</strong>
              <p>
                Train a worker, review the detected workflow, deploy it to Sales
                AI Worker, then run it from Installed workflows.
              </p>
            </article>
            <article>
              <strong>Local data</strong>
              <p>
                Worker, workflow, run, device, and approval state are backed by
                the local product database.
              </p>
            </article>
            <article>
              <strong>Runtime policy</strong>
              <p>AI worker progress uses the normal run event history.</p>
            </article>
            <article>
              <strong>Device assignment</strong>
              <p>
                Assign device controls where an AI worker can run installed
                workflows.
              </p>
            </article>
          </div>
        )}

        <div className="modal-footer">
          <button
            className="ghost-button large"
            type="button"
            onClick={onClose}
          >
            Close
          </button>
          <button
            className="primary-button large"
            type="button"
            onClick={onOpenAccountSettings}
          >
            <SvgIcon name="gear" />
            Account settings
          </button>
        </div>
      </section>
    </div>
  );
}

function AccountSetupDialog({
  account,
  cloudEmail,
  cloudDisplayName,
  workspaceName,
  canClose,
  onCancel,
  onSave,
  onSignOut,
}: {
  account: ProductAccount | null;
  cloudEmail: string | null;
  cloudDisplayName: string | null;
  workspaceName: string;
  canClose: boolean;
  onCancel: () => void;
  onSave: (input: {
    name: string;
    email: string;
    workspaceName: string;
  }) => Promise<void>;
  onSignOut: () => Promise<void>;
}) {
  const [name, setName] = useState(cloudDisplayName ?? account?.name ?? "");
  const [email, setEmail] = useState(cloudEmail ?? account?.email ?? "");
  const [workspace, setWorkspace] = useState(workspaceName);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setName(cloudDisplayName ?? account?.name ?? "");
    setEmail(cloudEmail ?? account?.email ?? "");
    setWorkspace(workspaceName);
  }, [account, cloudDisplayName, cloudEmail, workspaceName]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        name,
        email,
        workspaceName: workspace,
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      className="modal-layer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-setup-title"
    >
      <button
        className="modal-backdrop"
        type="button"
        aria-label="Close account setup"
        onClick={canClose ? onCancel : undefined}
      />
      <form className="account-setup-dialog" onSubmit={handleSubmit}>
        <div className="modal-header">
          <div>
            <p className="section-kicker">Workspace profile</p>
            <h2 id="account-setup-title">Account settings</h2>
            <span>
              Signed in as {cloudEmail ?? account?.email}. Profile details are
              stored with this local workspace.
            </span>
          </div>
          {canClose ? (
            <button
              className="icon-button"
              type="button"
              aria-label="Close"
              onClick={onCancel}
            >
              <SvgIcon name="close" />
            </button>
          ) : null}
        </div>
        <div className="account-form-grid">
          <label className="form-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <label className="form-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label className="form-field form-field-wide">
            <span>Workspace</span>
            <input
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
              required
            />
          </label>
        </div>
        <div className="modal-footer">
          {canClose ? (
            <button
              className="ghost-button large"
              type="button"
              onClick={() => void onSignOut()}
            >
              Sign out
            </button>
          ) : null}
          {canClose ? (
            <button
              className="ghost-button large"
              type="button"
              onClick={onCancel}
            >
              Cancel
            </button>
          ) : null}
          <button
            className="primary-button large"
            type="submit"
            disabled={isSaving}
          >
            <SvgIcon name="check" />
            {isSaving ? "Saving..." : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkerConfigPanel({
  language,
  worker,
  productWorker,
  hermes,
  onSave,
  onDelete,
}: {
  language: AppLanguage;
  worker: Worker;
  productWorker: ProductWorker | null;
  hermes: ProductHermesStatus | null;
  onSave: (config: ProductWorkerConfigInput) => Promise<void>;
  onDelete: () => void;
}) {
  const t = (english: string, chinese: string) =>
    language === "zh" ? chinese : english;
  const config = productWorker?.config ?? {
    identityScope: `${worker.name} follows Alex's operating style and only acts inside the assigned workspace.`,
    runtimeProfile: "Local AI worker runtime",
    toolAccess: [
      "browser control",
      "desktop automation",
      "mail",
      "chat",
      "crm",
    ],
    memoryContext: "Local workspace memory and installed workflow context",
    approvalPolicy: "allow_all" as const,
    heartbeatPolicy:
      "Check runtime health while idle and recover failed steps with a logged diagnosis.",
    hermesAgentReference: defaultHermesProfileReference(worker.id, worker.name),
    channel: defaultUiWorkerChannelConfig(),
  };
  const [identityScope, setIdentityScope] = useState(config.identityScope);
  const [memoryContext, setMemoryContext] = useState(config.memoryContext);
  const [heartbeatPolicy, setHeartbeatPolicy] = useState(
    config.heartbeatPolicy,
  );
  const [isSaving, setIsSaving] = useState(false);
  const computerControlLabel = hermes?.computerUseReady
    ? "Computer control ready"
    : (hermes?.computerUseSummary ?? "Computer control needs setup");

  useEffect(() => {
    setIdentityScope(config.identityScope);
    setMemoryContext(config.memoryContext);
    setHeartbeatPolicy(config.heartbeatPolicy);
  }, [config.heartbeatPolicy, config.identityScope, config.memoryContext]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSaving(true);
    try {
      await onSave({
        identityScope,
        runtimeProfile: config.runtimeProfile,
        toolAccess: config.toolAccess,
        memoryContext,
        approvalPolicy: "allow_all",
        heartbeatPolicy,
        hermesAgentReference: config.hermesAgentReference,
        channel: config.channel,
      });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form className="worker-config-form" onSubmit={handleSubmit}>
      <section className="config-status-strip">
        <div>
          <span>Computer control</span>
          <strong>{computerControlLabel}</strong>
        </div>
        <div>
          <span>Can use</span>
          <strong>Browser, files, screen reading, and workflow skills</strong>
        </div>
        <div>
          <span>Setup</span>
          <strong>Managed automatically by OysterWorkflow</strong>
        </div>
        <div>
          <span>Action policy</span>
          <strong>Allowed and logged</strong>
        </div>
      </section>
      <div className="worker-config-grid">
        <label className="form-field form-field-wide">
          <span>What this worker should handle</span>
          <textarea
            value={identityScope}
            onChange={(event) => setIdentityScope(event.target.value)}
            rows={3}
            required
          />
        </label>
        <label className="form-field form-field-wide">
          <span>Memory and context</span>
          <textarea
            value={memoryContext}
            onChange={(event) => setMemoryContext(event.target.value)}
            rows={2}
            required
          />
        </label>
        <label className="form-field form-field-wide">
          <span>Recovery behavior</span>
          <textarea
            value={heartbeatPolicy}
            onChange={(event) => setHeartbeatPolicy(event.target.value)}
            rows={2}
            required
          />
        </label>
      </div>
      <div className="config-footer">
        <span>
          OysterWorkflow manages the AI runtime, tools, and local profile
          automatically. Worker progress appears in run events.
        </span>
        <button
          className="primary-button large"
          type="submit"
          disabled={isSaving}
        >
          <SvgIcon name="check" />
          {isSaving ? "Saving setup..." : "Save worker config"}
        </button>
      </div>
      <section
        className="worker-danger-zone"
        aria-labelledby="worker-danger-title"
      >
        <div>
          <strong id="worker-danger-title">
            {t("Delete this AI worker", "删除此 AI Worker")}
          </strong>
          <span>
            {t(
              "Remove its device assignment, installed workflows, and message routing. Run history is kept for audit.",
              "移除设备分配、已安装工作流和消息路由。运行历史将保留用于审计。",
            )}
          </span>
        </div>
        <button
          className="ghost-button danger-action-button"
          type="button"
          onClick={onDelete}
        >
          <SvgIcon name="trash" size={18} />
          {t("Delete AI worker", "删除 AI Worker")}
        </button>
      </section>
    </form>
  );
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

function WorkerActivityPanel({
  worker,
  productState,
}: {
  worker: Worker;
  productState: ProductStateSnapshot | null;
}) {
  const activityItems = buildWorkerActivityItems(worker, productState);
  return (
    <section
      className="worker-activity-panel"
      aria-label={`${worker.name} activity`}
    >
      <div>
        <h3>Worker timeline</h3>
        <ActivityTimeline items={activityItems} />
      </div>
      <div className="worker-activity-metrics">
        <Metric label="Availability" value={worker.heartbeat} />
        <Metric label="Device" value={worker.device} />
        <Metric label="Approval mode" value="Allow all" />
      </div>
    </section>
  );
}

function SvgIcon({ name, size = 22 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "activity":
      return (
        <svg {...common}>
          <path d="M4 12h3l2-6 4 12 2-6h5" />
        </svg>
      );
    case "archive":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M5 7l1 13h12l1-13" />
          <path d="M8 4h8l1 3H7l1-3Z" />
          <path d="M9 11h6" />
        </svg>
      );
    case "arrowRight":
      return (
        <svg {...common}>
          <path d="M5 12h14" />
          <path d="M13 6l6 6-6 6" />
        </svg>
      );
    case "bell":
      return (
        <svg {...common}>
          <path d="M6 9a6 6 0 0 1 12 0c0 7 3 6 3 8H3c0-2 3-1 3-8Z" />
          <path d="M9.5 20a3 3 0 0 0 5 0" />
        </svg>
      );
    case "briefcase":
      return (
        <svg {...common}>
          <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
          <path d="M4 7h16v12H4z" />
          <path d="M4 12h16" />
          <path d="M10 12v2h4v-2" />
        </svg>
      );
    case "chat":
      return (
        <svg {...common}>
          <path d="M5 5h14v10H9l-4 4V5Z" />
          <path d="M8 9h8" />
          <path d="M8 12h5" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 7v5l3 2" />
        </svg>
      );
    case "close":
      return (
        <svg {...common}>
          <path d="M6 6l12 12" />
          <path d="M18 6 6 18" />
        </svg>
      );
    case "cube":
      return (
        <svg {...common}>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
          <path d="m4 7.5 8 4.5 8-4.5" />
          <path d="M12 12v9" />
        </svg>
      );
    case "device":
      return (
        <svg {...common}>
          <path d="M5 5h14v10H5z" />
          <path d="M8 19h8" />
          <path d="M12 15v4" />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path d="M12 4v10" />
          <path d="m8 10 4 4 4-4" />
          <path d="M5 20h14" />
        </svg>
      );
    case "expand":
      return (
        <svg {...common}>
          <path d="M8 4H4v4" />
          <path d="M4 4l6 6" />
          <path d="M16 20h4v-4" />
          <path d="m14 14 6 6" />
          <path d="M20 8V4h-4" />
          <path d="m14 10 6-6" />
          <path d="M4 16v4h4" />
          <path d="m4 20 6-6" />
        </svg>
      );
    case "filter":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M7 12h10" />
          <path d="M10 17h4" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          <path d="M4 12h2" />
          <path d="M18 12h2" />
          <path d="M12 4v2" />
          <path d="M12 18v2" />
          <path d="m6.5 6.5 1.4 1.4" />
          <path d="m16.1 16.1 1.4 1.4" />
          <path d="m17.5 6.5-1.4 1.4" />
          <path d="m7.9 16.1-1.4 1.4" />
        </svg>
      );
    case "help":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
          <path d="M9.7 9a2.5 2.5 0 0 1 4.8 1c0 1.7-2.2 2-2.2 3.5" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "heartbeat":
      return (
        <svg {...common}>
          <path d="M4 13h3l2-5 4 9 2-4h5" />
          <path d="M12 21C6 17 3 13 3 8a4 4 0 0 1 7-2.6A4 4 0 0 1 17 8" />
        </svg>
      );
    case "home":
      return (
        <svg {...common}>
          <path d="m4 11 8-7 8 7" />
          <path d="M6 10v10h12V10" />
        </svg>
      );
    case "mail":
      return (
        <svg {...common}>
          <path d="M4 6h16v12H4z" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      );
    case "megaphone":
      return (
        <svg {...common}>
          <path d="M4 13V9h4l9-4v12l-9-4H4Z" />
          <path d="M8 13l2 6" />
          <path d="M19 9a3 3 0 0 1 0 4" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="6.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle
            cx="17.5"
            cy="12"
            r="1.35"
            fill="currentColor"
            stroke="none"
          />
        </svg>
      );
    case "network":
      return (
        <svg {...common}>
          <path d="M12 5v5" />
          <path d="M6 19v-5h12v5" />
          <circle cx="12" cy="4" r="2" />
          <circle cx="6" cy="20" r="2" />
          <circle cx="18" cy="20" r="2" />
        </svg>
      );
    case "pause":
      return (
        <svg {...common}>
          <path d="M9 6v12" />
          <path d="M15 6v12" />
        </svg>
      );
    case "play":
      return (
        <svg {...common}>
          <path d="m8 5 11 7-11 7V5Z" />
        </svg>
      );
    case "power":
      return (
        <svg {...common}>
          <path d="M12 3v9" />
          <path d="M7.1 6.8a7 7 0 1 0 9.8 0" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 5 6v6c0 5 3 8 7 9 4-1 7-4 7-9V6l-7-3Z" />
          <path d="m9 12 2 2 4-5" />
        </svg>
      );
    case "stop":
      return (
        <svg {...common}>
          <path d="M7 7h10v10H7z" />
        </svg>
      );
    case "target":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v4" />
          <path d="M22 12h-4" />
          <path d="m18 6-6 6" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M6 7l1 14h10l1-14" />
          <path d="M9 7V4h6v3" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M12 20V10" />
          <path d="m8 14 4-4 4 4" />
          <path d="M5 4h14" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M5 21a7 7 0 0 1 14 0" />
        </svg>
      );
    case "voice":
      return (
        <svg {...common}>
          <path d="M12 4v16" />
          <path d="M8 8v8" />
          <path d="M16 8v8" />
          <path d="M4 11v2" />
          <path d="M20 11v2" />
        </svg>
      );
    default:
      return null;
  }
}

export default App;

import type {
  LabSessionRecordingConfig,
  LabSession,
  LabWorkflowGenerationProgress,
  OpenClawSkill,
  SessionListResponse,
  SessionResponse,
  WorkflowCandidate,
} from "../../src/lab-api/api-contracts.js";
import { selectPreferredWorkflowCandidate } from "../../src/lab-api/workflow-selection.js";
import { resolveWorkflowApp, resolveWorkflowApps } from "./app-icon-registry";
import { runtimeJsonRequest } from "./runtime-request";

export type DemoWorkflowPhase =
  "captured" | "generating" | "generated" | "failed" | "demo";

export interface DemoWorkflowStats {
  uiEvents: number | null;
  ocrObservations: number | null;
  voiceNotes: number | null;
  duration: string;
  decisionPoints: number | null;
}

export interface DemoWorkflowAsset {
  label: string;
  value: string;
}

export interface DemoWorkflowStep {
  id: string;
  title: string;
  type: "Decision" | "Action" | "Approval";
  app: string;
  body: string;
  hints: string;
  assets: DemoWorkflowAsset[];
  approval: string;
}

export interface DemoWorkflowSummary {
  id: string;
  title: string;
  code: string;
  status: string;
  tone: "ready" | "warning" | "idle" | "working" | "danger";
  confidence: number | null;
  description: string;
  icon: string;
  detectedAt: string;
  stats: DemoWorkflowStats;
  steps: DemoWorkflowStep[];
  connectedApps: string[];
  phase: DemoWorkflowPhase;
  sessionId: string | null;
  workflowId: string | null;
  workflowPath: string | null;
  skillPath: string | null;
  graphPath?: string | null;
  candidatePath?: string | null;
  mergeProposalPath?: string | null;
  sourceType: "demo" | "runtime";
  skill: OpenClawSkill | null;
  candidate: WorkflowCandidate | null;
  errorMessage?: string | null;
  generationProgress?: LabWorkflowGenerationProgress | null;
  workflowCandidates?: WorkflowCandidate[];
  requiresWorkflowSelection?: boolean;
}

export interface GenerateWorkflowProgress {
  workflowId: string;
  progress: LabWorkflowGenerationProgress;
}

export interface StepPatch {
  title: string;
  app: string;
  body: string;
  hints: string;
  assets: DemoWorkflowAsset[];
}

/**
 * EN: Lists recent Runtime sessions that can become demo workflows.
 * 中文: 读取真实 Runtime session，用于填充 demo 的 workflow 列表。
 * @returns Runtime sessions sorted by the backend.
 */
export async function fetchRuntimeSessions(): Promise<LabSession[]> {
  const response =
    await runtimeJsonRequest<SessionListResponse>("/api/sessions");
  return response.sessions;
}

/**
 * EN: Reads one Runtime session so the UI can poll persisted generation stages.
 * 中文: 读取单个 Runtime session，用于轮询后端持久化的真实生成阶段。
 * @param sessionId Runtime session id.
 * @returns latest persisted session.
 */
export async function fetchRuntimeSession(
  sessionId: string,
): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}`,
  );
  return response.session;
}

/**
 * EN: Reads the active recorder session, if any.
 * 中文: 读取当前真实录制状态。
 * @returns active session or null.
 */
export async function fetchActiveRecorderSession(): Promise<LabSession | null> {
  const response = await runtimeJsonRequest<{
    activeSession: LabSession | null;
  }>("/api/recorder/state");
  return response.activeSession;
}

/**
 * EN: Starts the real desktop recorder through the existing Runtime.
 * 中文: 通过现有 Runtime 启动真实录制。
 * @returns created recording session.
 */
export async function startRuntimeTraining(
  config: Partial<LabSessionRecordingConfig> = {},
): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    "/api/recorder/start",
    {
      method: "POST",
      body: JSON.stringify(config),
    },
  );
  return response.session;
}

/**
 * EN: Stops the real desktop recorder and lets Runtime ingest the capture.
 * 中文: 停止真实录制，并等待 Runtime 完成 ingest。
 * @returns session with ingest summary.
 */
export async function stopRuntimeTraining(): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    "/api/recorder/stop",
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    { timeoutMs: 180_000 },
  );
  return response.session;
}

/**
 * EN: Runs workflow discovery for one captured Runtime session.
 * 中文: 对一次真实 capture 运行工作流发现。
 * @param sessionId Runtime session id.
 * @returns updated session.
 */
export async function discoverRuntimeWorkflow(
  sessionId: string,
): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/workflow-discovery`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
    { timeoutMs: 600_000 },
  );
  return response.session;
}

/**
 * EN: Extracts editable workflow logic from one discovered workflow candidate.
 * 中文: 从发现出的 workflow candidate 生成可编辑的 workflow logic。
 * @param input selected workflow metadata.
 * @returns updated session with a base skill artifact.
 */
export async function extractRuntimeWorkflowLogic(input: {
  sessionId: string;
  workflowPath: string;
  workflowId: string;
}): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/skill-extraction`,
    {
      method: "POST",
      body: JSON.stringify({
        workflowPath: input.workflowPath,
        workflowId: input.workflowId,
      }),
    },
    { timeoutMs: 600_000 },
  );
  return response.session;
}

/**
 * EN: Persists edits to one generated workflow skill through Runtime.
 * 中文: 通过 Runtime 保存 workflow logic 的编辑结果。
 * @param input skill artifact update.
 * @returns updated session.
 */
export async function saveRuntimeWorkflowSkill(input: {
  sessionId: string;
  skillPath: string;
  skill: OpenClawSkill;
}): Promise<LabSession> {
  const response = await runtimeJsonRequest<SessionResponse>(
    `/api/sessions/${encodeURIComponent(input.sessionId)}/skill-artifact`,
    {
      method: "POST",
      body: JSON.stringify({
        sourceType: "base",
        skillPath: input.skillPath,
        skill: input.skill,
      }),
    },
  );
  return response.session;
}

/**
 * EN: Converts Runtime sessions into workflows while preserving the real generation lifecycle.
 * 中文: 把真实 session 转成 demo workflow，并保留“统计先出现、logic 后生成”的真实状态。
 * @param sessions Runtime sessions.
 * @returns workflows suitable for the demo UI.
 */
export function workflowsFromRuntimeSessions(
  sessions: LabSession[],
): DemoWorkflowSummary[] {
  return sessions
    .filter((session) => session.ingest.summary || isRecordingLike(session))
    .sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    )
    .map((session, index) => workflowFromRuntimeSession(session, index));
}

/**
 * EN: Builds a generated workflow after discovery/extraction has completed.
 * 中文: 在 discovery/extraction 完成后构建可展示的 workflow。
 * @param session updated Runtime session.
 * @param fallbackId UI workflow id to preserve selection when possible.
 * @returns generated workflow.
 */
export function workflowFromGeneratedSession(
  session: LabSession,
  fallbackId: string,
): DemoWorkflowSummary {
  const workflow = workflowFromRuntimeSession(session, 0);
  return {
    ...workflow,
    id: fallbackId,
  };
}

/**
 * EN: Selects the best workflow candidate after discovery.
 * 中文: 从发现结果里选择最适合生成 logic 的候选 workflow。
 * @param session Runtime session.
 * @returns candidate or null.
 */
export function selectWorkflowCandidate(
  session: Pick<LabSession, "selection" | "workflowDiscovery">,
): WorkflowCandidate | null {
  const selectedId = session.selection.workflowId;
  const candidates = session.workflowDiscovery.workflowCandidates;
  return (
    candidates.find((candidate) => candidate.workflowId === selectedId) ??
    selectPreferredWorkflowCandidate(candidates) ??
    null
  );
}

/**
 * EN: Applies a single step edit to a structured agent skill while preserving its artifact contract.
 * 中文: 在保持 skill.json 契约不变的前提下更新单个步骤。
 * @param skill original skill.
 * @param stepId demo step id.
 * @param patch edited fields.
 * @returns updated skill.
 */
export function updateSkillStep(
  skill: OpenClawSkill,
  stepId: string,
  patch: StepPatch,
): OpenClawSkill {
  return {
    ...skill,
    steps: skill.steps.map((step, index) =>
      buildStepId(step.step, index) === stepId
        ? {
            ...step,
            instruction: patch.title.trim(),
            operationApp: patch.app.trim() || "Unknown app",
            intent: patch.body.trim(),
            hints: parseHints(patch.hints),
          }
        : step,
    ),
  };
}

function workflowFromRuntimeSession(
  session: LabSession,
  index: number,
): DemoWorkflowSummary {
  const artifact = selectBaseSkillArtifact(session);
  const candidate =
    selectCandidateForArtifact(session, artifact?.workflowId ?? null) ??
    selectWorkflowCandidate(session);
  const generated = Boolean(artifact?.skill);
  const workflowCandidates = session.workflowDiscovery.workflowCandidates;
  const requiresWorkflowSelection =
    !generated &&
    workflowCandidates.length > 1 &&
    session.selection.workflowId === null &&
    Boolean(session.workflowDiscovery.latestPath);
  const stats = statsFromSession(session, artifact?.skill ?? null);
  const title = generated
    ? artifact?.skill.skillName ||
      candidate?.name ||
      displaySessionName(session)
    : displaySessionName(session);
  const connectedApps = generated ? appsFromSkill(artifact?.skill ?? null) : [];
  const confidence = generated
    ? normalizeConfidence(candidate?.confidence)
    : null;
  const phase = resolveWorkflowPhase(session, generated);

  return {
    id: `runtime-${session.sessionId}`,
    title,
    code: workflowCode(session, index),
    status: isRecordingLike(session)
      ? "Training"
      : requiresWorkflowSelection
        ? "Selection needed"
        : statusForPhase(phase),
    tone: isRecordingLike(session)
      ? "working"
      : requiresWorkflowSelection
        ? "warning"
        : toneForPhase(phase),
    confidence,
    description: generated
      ? candidate?.description ||
        artifact?.skill.shortDescription ||
        artifact?.skill.description ||
        "Workflow draft is ready for review."
      : descriptionForCapturedSession(session),
    icon: generated ? "target" : "archive",
    detectedAt: detectedAt(session),
    stats,
    steps: generated ? stepsFromSkill(artifact!.skill) : [],
    connectedApps,
    phase,
    sessionId: session.sessionId,
    workflowId: artifact?.workflowId ?? candidate?.workflowId ?? null,
    workflowPath:
      artifact?.workflowPath ?? session.selection.workflowPath ?? null,
    skillPath: artifact?.skillPath ?? null,
    graphPath: artifact?.summary?.output.workflowGraphPath ?? null,
    candidatePath: artifact?.summary?.output.workflowCandidatePath ?? null,
    mergeProposalPath:
      artifact?.summary?.output.workflowMergeProposalPath ?? null,
    sourceType: "runtime",
    skill: artifact?.skill ?? null,
    candidate: generated ? candidate : null,
    errorMessage: session.error?.message ?? null,
    generationProgress: session.generationProgress,
    workflowCandidates,
    requiresWorkflowSelection,
  };
}

function selectBaseSkillArtifact(session: LabSession) {
  const selectedId = session.selection.workflowId;
  return (
    session.skillExtraction.artifacts.find(
      (artifact) => artifact.workflowId === selectedId,
    ) ??
    session.skillExtraction.artifacts[0] ??
    (session.skillExtraction.skill && session.skillExtraction.skillPath
      ? {
          workflowId: session.selection.workflowId,
          workflowPath: session.selection.workflowPath,
          latestOutDir: session.skillExtraction.latestOutDir ?? "",
          skillPath: session.skillExtraction.skillPath,
          summaryPath: session.skillExtraction.summaryPath ?? "",
          skill: session.skillExtraction.skill,
          summary: session.skillExtraction.summary,
        }
      : null)
  );
}

function selectCandidateForArtifact(
  session: LabSession,
  workflowId: string | null,
): WorkflowCandidate | null {
  if (!workflowId) {
    return null;
  }
  return (
    session.workflowDiscovery.workflowCandidates.find(
      (candidate) => candidate.workflowId === workflowId,
    ) ?? null
  );
}

function statsFromSession(
  session: LabSession,
  skill: OpenClawSkill | null,
): DemoWorkflowStats {
  const summary = session.ingest.summary;
  return {
    uiEvents: summary?.fetch.rawUiEventsCount ?? null,
    ocrObservations: summary?.fetch.rawOcrCount ?? null,
    voiceNotes: summary?.fetch.rawAudioCount ?? null,
    duration: formatDuration(
      summary?.timeWindow.observed.durationMs ??
        summary?.timeWindow.requested.durationMs ??
        durationBetween(
          session.recordingWindow.startedAt,
          session.recordingWindow.requestedStopAt ??
            session.screenpipe.recording.stoppedAt,
        ),
    ),
    decisionPoints: skill ? estimateDecisionPoints(skill) : null,
  };
}

function stepsFromSkill(skill: OpenClawSkill): DemoWorkflowStep[] {
  return skill.steps.map((step, index) => {
    const app = resolveWorkflowApp([
      step.instruction ?? "",
      step.intent ?? "",
      ...step.hints.filter(Boolean),
      step.operationApp ?? "",
      skill.goal ?? "",
      skill.shortDescription ?? "",
    ]);
    return {
      id: buildStepId(step.step, index),
      title: step.instruction || `Step ${index + 1}`,
      type: classifyStep(step.instruction, step.intent, step.hints),
      app: app.label,
      body: step.intent || "No step details are available yet.",
      hints:
        step.hints.length > 0
          ? step.hints.join("\n")
          : "No guidance has been added for this step.",
      assets: assetsForSkillStep(skill, step),
      approval: approvalForStep(step.instruction, step.intent, step.hints),
    };
  });
}

/**
 * EN: Picks the skill assets that are most relevant to one generated step.
 * 中文: 为单个生成步骤挑选最相关的 skill assets，供 demo 详情页展示。
 * @param skill Generated agent skill that owns the assets.
 * @param step Generated agent skill step that is being rendered.
 * @returns Step-scoped assets for the UI.
 */
function assetsForSkillStep(
  skill: OpenClawSkill,
  step: OpenClawSkill["steps"][number],
): DemoWorkflowAsset[] {
  const stepText = [
    step.instruction,
    step.intent,
    step.operationApp,
    ...step.hints,
  ]
    .join(" ")
    .toLowerCase();

  return skill.assets
    .map((asset) => ({
      asset,
      score: scoreAssetForStep(asset, stepText),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 4)
    .map(({ asset }) => ({
      label: asset.name,
      value: stringifyAssetValue(asset.value),
    }));
}

/**
 * EN: Scores whether an asset belongs with the current step text.
 * 中文: 根据步骤文本判断 asset 与当前步骤的关联强度。
 * @param asset Skill asset candidate.
 * @param stepText Lowercase searchable step text.
 * @returns Relevance score; zero means no match.
 */
function scoreAssetForStep(
  asset: OpenClawSkill["assets"][number],
  stepText: string,
): number {
  const assetText = `${asset.name} ${stringifyAssetValue(asset.value)} ${
    asset.notes ?? ""
  }`.toLowerCase();
  let score = 0;
  const rules: Array<{ step: string[]; asset: string[]; weight: number }> = [
    {
      step: ["outlook", "inbox", "email", "reply", "draft"],
      asset: ["outlook", "mailbox", "inquiry", "signature", "reply"],
      weight: 5,
    },
    {
      step: ["linkedin"],
      asset: ["linkedin"],
      weight: 5,
    },
    {
      step: ["website", "official", "company", "google", "search"],
      asset: ["website", "engel", "company", "google"],
      weight: 4,
    },
    {
      step: ["wechat", "engineer", "technical"],
      asset: ["wechat", "engineer", "internal team"],
      weight: 5,
    },
    {
      step: ["onedrive", "clients", "case", "study", "similar"],
      asset: [
        "onedrive",
        "clients",
        "case",
        "semiconductor",
        "silicon carbide",
      ],
      weight: 5,
    },
  ];

  for (const rule of rules) {
    if (
      rule.step.some((token) => stepText.includes(token)) &&
      rule.asset.some((token) => assetText.includes(token))
    ) {
      score += rule.weight;
    }
  }

  const operationTokens = stepText
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 3);
  for (const token of operationTokens) {
    if (assetText.includes(token)) {
      score += 1;
    }
  }

  return score;
}

function appsFromSkill(skill: OpenClawSkill | null): string[] {
  if (!skill) {
    return [];
  }
  const chunks = [
    skill.skillName,
    skill.shortDescription ?? "",
    skill.description ?? "",
    skill.goal ?? "",
    ...skill.evidence.appsSeen,
    ...skill.evidence.windowsSeen,
    ...skill.assets.flatMap((asset) => [
      asset.name,
      asset.notes ?? "",
      stringifyAssetValue(asset.value),
    ]),
    ...skill.steps.flatMap((step) => [
      step.operationApp ?? "",
      step.instruction ?? "",
      step.intent ?? "",
      ...step.hints.filter(Boolean),
    ]),
  ];
  return resolveWorkflowApps(chunks)
    .map((app) => app.label)
    .slice(0, 8);
}

function stringifyAssetValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.join(" ");
  }
  if (value && typeof value === "object") {
    return Object.values(value).join(" ");
  }
  return typeof value === "string" ? value : "";
}

function classifyStep(
  instruction: string,
  intent: string,
  hints: string[],
): DemoWorkflowStep["type"] {
  const text = `${instruction} ${intent} ${hints.join(" ")}`.toLowerCase();
  if (text.includes("approval") || text.includes("confirm")) {
    return "Approval";
  }
  if (
    text.includes("decide") ||
    text.includes("judge") ||
    text.includes("check") ||
    text.includes("determine") ||
    text.includes("validate")
  ) {
    return "Decision";
  }
  return "Action";
}

function approvalForStep(
  instruction: string,
  intent: string,
  hints: string[],
): string {
  const text = `${instruction} ${intent} ${hints.join(" ")}`.toLowerCase();
  if (text.includes("send") || text.includes("external")) {
    return "Human review required";
  }
  if (text.includes("confirm") || text.includes("pricing")) {
    return "Human review recommended";
  }
  return "No approval required";
}

function estimateDecisionPoints(skill: OpenClawSkill): number {
  return skill.steps.filter(
    (step) =>
      classifyStep(step.instruction, step.intent, step.hints) !== "Action",
  ).length;
}

function resolveWorkflowPhase(
  session: LabSession,
  generated: boolean,
): DemoWorkflowPhase {
  if (session.status === "failed" || session.status === "interrupted") {
    return "failed";
  }
  if (
    session.status === "workflow-discovering" ||
    session.status === "skill-extracting"
  ) {
    return "generating";
  }
  if (generated) {
    return "generated";
  }
  return "captured";
}

function isRecordingLike(session: LabSession): boolean {
  return (
    session.status === "recording" ||
    session.status === "starting" ||
    session.status === "stopping" ||
    session.status === "ingesting" ||
    session.status === "booting-query-mode"
  );
}

function statusForPhase(phase: DemoWorkflowPhase): string {
  switch (phase) {
    case "captured":
      return "Captured";
    case "generating":
      return "Analyzing";
    case "generated":
      return "Installable";
    case "failed":
      return "Review needed";
    case "demo":
      return "Installable";
  }
}

function toneForPhase(phase: DemoWorkflowPhase): DemoWorkflowSummary["tone"] {
  switch (phase) {
    case "captured":
      return "idle";
    case "generating":
      return "working";
    case "generated":
    case "demo":
      return "ready";
    case "failed":
      return "danger";
  }
}

function descriptionForCapturedSession(session: LabSession): string {
  if (session.error?.message) {
    return session.error.message;
  }
  if (isRecordingLike(session)) {
    return "Training is still recording. Stop training to prepare a review.";
  }
  if (!session.ingest.summary) {
    return "The capture is not ready for review yet.";
  }
  return "Capture is ready. Analyze it to build an editable workflow.";
}

function displaySessionName(session: LabSession): string {
  const name = session.sessionName?.trim();
  if (name) {
    return name;
  }
  if (isRecordingLike(session)) {
    return "Active training capture";
  }
  return "Captured training session";
}

function detectedAt(session: LabSession): string {
  const timestamp =
    session.recordingWindow.requestedStopAt ??
    session.screenpipe.recording.stoppedAt ??
    session.recordingWindow.startedAt ??
    session.createdAt;
  return `Captured on ${formatTimestamp(timestamp)}`;
}

function workflowCode(session: LabSession, index: number): string {
  const match = session.sessionId.match(/(\d{4})(?:-[^-]+)?$/);
  if (match) {
    return `WF-${match[1]}`;
  }
  return `WF-${String(1100 + index).padStart(4, "0")}`;
}

function normalizeConfidence(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

function formatTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "--";
  }
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function durationBetween(
  startedAt: string | null,
  endedAt: string | null,
): number | null {
  if (!startedAt || !endedAt) {
    return null;
  }
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }
  return end - start;
}

function buildStepId(stepNumber: number, index: number): string {
  return `step-${Number.isFinite(stepNumber) ? stepNumber : index + 1}`;
}

function parseHints(value: string): string[] {
  return value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

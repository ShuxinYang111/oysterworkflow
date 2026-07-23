import type {
  GeneralizedSkillVariantSummary,
  IngestSummary,
  LlmInvocationSummary,
  OpenClawSkill,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../types/contracts.js";
import {
  LLM_CALL_PROFILE_KEYS,
  type LlmCallProfileKey,
} from "../llm/call-profiles.js";

export type {
  GeneralizedSkillVariantSummary,
  IngestSummary,
  LlmInvocationSummary,
  OpenClawSkill,
  SkillExtractionSummary,
  WorkflowCandidate,
} from "../types/contracts.js";

export const LAB_SESSION_SCHEMA_VERSION = "recording-session-v1";
export const LAB_SESSION_STATUS = [
  "idle",
  "starting",
  "recording",
  "stopping",
  "booting-query-mode",
  "ingesting",
  "ready",
  "interrupted",
  "workflow-discovering",
  "skill-extracting",
  "generalizing",
  "planner-optimizing",
  "failed",
] as const;

export type LabSessionStatus = (typeof LAB_SESSION_STATUS)[number];
export type LabProcessState = "idle" | "starting" | "running" | "stopped";

export const LAB_WORKFLOW_GENERATION_STAGES = [
  "analyzing-recording",
  "discovering-workflow",
  "building-skill",
  "building-workflow-graph",
] as const;
export type LabWorkflowGenerationStage =
  (typeof LAB_WORKFLOW_GENERATION_STAGES)[number];

export interface LabWorkflowGenerationStageTiming {
  startedAt: string | null;
  completedAt: string | null;
}

export interface LabWorkflowGenerationProgress {
  currentStage: LabWorkflowGenerationStage | null;
  failedStage: LabWorkflowGenerationStage | null;
  failedAt: string | null;
  completedAt: string | null;
  stages: Record<LabWorkflowGenerationStage, LabWorkflowGenerationStageTiming>;
}

export type LabArtifactKind =
  | "ingest-summary"
  | "workflow"
  | "skill"
  | "skill-summary"
  | "generalization-summary"
  | "planner-skill"
  | "planner-summary";

export const LAB_SCREENPIPE_LANGUAGES = [
  "english",
  "chinese",
  "german",
  "spanish",
  "russian",
  "korean",
  "french",
  "japanese",
  "portuguese",
  "turkish",
  "polish",
  "catalan",
  "dutch",
  "arabic",
  "swedish",
  "italian",
  "indonesian",
  "hindi",
  "finnish",
  "hebrew",
  "ukrainian",
  "greek",
  "malay",
  "czech",
  "romanian",
  "danish",
  "hungarian",
  "norwegian",
  "thai",
  "urdu",
  "croatian",
  "bulgarian",
  "lithuanian",
  "latin",
  "malayalam",
  "welsh",
  "slovak",
  "persian",
  "latvian",
  "bengali",
  "serbian",
  "azerbaijani",
  "slovenian",
  "estonian",
  "macedonian",
  "nepali",
  "mongolian",
  "bosnian",
  "kazakh",
  "albanian",
  "swahili",
  "galician",
  "marathi",
  "punjabi",
  "sinhala",
  "khmer",
  "afrikaans",
  "belarusian",
  "gujarati",
  "amharic",
  "yiddish",
  "lao",
  "uzbek",
  "faroese",
  "pashto",
  "maltese",
  "sanskrit",
  "luxembourgish",
  "myanmar",
  "tibetan",
  "tagalog",
  "assamese",
  "tatar",
  "hausa",
  "javanese",
] as const;
export type LabScreenpipeLanguage = (typeof LAB_SCREENPIPE_LANGUAGES)[number];
export const RECORDER_LANGUAGE_PRIORITY_SLOT_COUNT = 3;
export const DEFAULT_RECORDING_OCR_LANGUAGE_PRIORITY = [
  "chinese",
  "english",
] as const satisfies readonly LabScreenpipeLanguage[];
export const DEFAULT_RECORDING_ENABLE_AUDIO = false;

export interface LabSessionRecordingConfig {
  ocrLanguagePriority: LabScreenpipeLanguage[];
  enableAudio: boolean;
}

export interface WorkflowArtifact {
  schemaVersion: "openclaw-workflow-discovery-v1";
  generatedAt: string;
  runId: string;
  episodeId: string;
  generationGuidance?: string;
  source: {
    runDir: string;
    startTs: string;
    endTs: string;
  };
  workflowCandidates: WorkflowCandidate[];
  llm?: LlmInvocationSummary;
  warnings: string[];
}

export interface LabSessionPaths {
  sessionDir: string;
  dataDir: string;
  ingestOutDir: string;
  workflowDir: string;
  skillDir: string;
  generalizationDir: string;
  plannerOptimizationDir: string;
  sessionPath: string;
  recordingLogPath: string;
  queryLogPath: string;
}

export interface LabProcessSnapshot {
  state: LabProcessState;
  pid: number | null;
  port: number | null;
  workdir: string;
  command: string[];
  logPath: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  exitCode: number | null;
}

export interface LabSessionError {
  message: string;
  stack?: string;
}

export interface LabSessionIngestState {
  latestRunId: string | null;
  latestRunDir: string | null;
  summaryPath: string | null;
  summary: IngestSummary | null;
}

export interface LabSessionWorkflowState {
  latestPath: string | null;
  workflowCandidates: WorkflowCandidate[];
}

export interface LabSessionBaseSkillArtifact {
  workflowId: string | null;
  workflowPath: string | null;
  latestOutDir: string;
  skillPath: string;
  summaryPath: string;
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
}

export interface LabSessionSkillState {
  latestOutDir: string | null;
  skillPath: string | null;
  summaryPath: string | null;
  skill: OpenClawSkill | null;
  summary: SkillExtractionSummary | null;
  artifacts: LabSessionBaseSkillArtifact[];
}

export interface LabGeneralizationVariantArtifact {
  summary: GeneralizedSkillVariantSummary;
  skill: OpenClawSkill;
}

export interface LabGeneralizationSummary {
  schemaVersion: "lab-generalization-summary-v1";
  generatedAt: string;
  sourceSkillPath: string;
  sourceSummaryPath: string;
  selectedWorkflowId: string | null;
  predictedScenariosPath: string | null;
  scenarioCount: number;
  variants: GeneralizedSkillVariantSummary[];
  variantArtifacts: LabGeneralizationVariantArtifact[];
  llm?: LlmInvocationSummary;
  warnings: string[];
}

export interface LabSessionGeneralizationState {
  latestOutDir: string | null;
  summaryPath: string | null;
  summary: LabGeneralizationSummary | null;
  artifacts: LabSessionGeneralizationArtifact[];
}

export interface LabSessionGeneralizationArtifact {
  sourceSkillPath: string;
  sourceSummaryPath: string;
  selectedWorkflowId: string | null;
  latestOutDir: string;
  summaryPath: string;
  summary: LabGeneralizationSummary;
}

export type PlannerOptimizationSourceType = "base" | "generalized";

export interface LabPlannerOptimizationSummary {
  schemaVersion: "lab-planner-optimization-summary-v1";
  generatedAt: string;
  sourceType: PlannerOptimizationSourceType;
  sourceSkillPath: string;
  sourceSkillId: string;
  sourceSkillName: string;
  selectedWorkflowId?: string | null;
  output: {
    outDir: string;
    skillPath: string;
    summaryPath: string;
    workflowGraphPath?: string;
    workflowMarkdownPath?: string;
    workflowRevisionsDir?: string;
  };
  llm?: LlmInvocationSummary;
  warnings: string[];
}

export interface LabSessionPlannerOptimizationState {
  latestOutDir: string | null;
  skillPath: string | null;
  summaryPath: string | null;
  skill: OpenClawSkill | null;
  summary: LabPlannerOptimizationSummary | null;
}

export interface LabSessionSelection {
  workflowId: string | null;
  workflowPath: string | null;
}

export interface LabSession {
  schemaVersion: typeof LAB_SESSION_SCHEMA_VERSION;
  sessionId: string;
  sessionName: string | null;
  createdAt: string;
  updatedAt: string;
  status: LabSessionStatus;
  paths: LabSessionPaths;
  recordingConfig: LabSessionRecordingConfig;
  screenpipe: {
    recordingDataBaseUrl: string | null;
    recording: LabProcessSnapshot;
    queryMode: LabProcessSnapshot;
  };
  recordingWindow: {
    startedAt: string | null;
    requestedStopAt: string | null;
    scheduledStopAt: string | null;
    autoStopMinutes: number | null;
  };
  generationProgress: LabWorkflowGenerationProgress;
  ingest: LabSessionIngestState;
  selection: LabSessionSelection;
  workflowDiscovery: LabSessionWorkflowState;
  skillExtraction: LabSessionSkillState;
  generalization: LabSessionGeneralizationState;
  plannerOptimization: LabSessionPlannerOptimizationState;
  warnings: string[];
  error: LabSessionError | null;
}

export interface RecorderStateResponse {
  activeSession: LabSession | null;
}

export const RECORDER_PERMISSION_KINDS = [
  "screen-recording",
  "accessibility",
  "input-monitoring",
  "microphone",
] as const;
export type RecorderPermissionKind = (typeof RECORDER_PERMISSION_KINDS)[number];
export const RECORDER_PERMISSION_STATES = [
  "granted",
  "missing",
  "unknown",
] as const;
export type RecorderPermissionState =
  (typeof RECORDER_PERMISSION_STATES)[number];
export type RecorderPermissionCheckSource =
  "host-app" | "screenpipe-probe" | "existing-recorder" | "not-needed";

export interface RecorderPermissionItem {
  kind: RecorderPermissionKind;
  label: string;
  description: string;
  state: RecorderPermissionState;
  detail: string;
}

export interface RecorderPermissionsResponse {
  checkedAt: string;
  allGranted: boolean;
  canStartRecording: boolean;
  source: RecorderPermissionCheckSource;
  items: RecorderPermissionItem[];
  summary: string;
}

export const RECORDER_BOOTSTRAP_STAGES = [
  "idle",
  "preparing",
  "ready",
  "failed",
] as const;
export type RecorderBootstrapStage = (typeof RECORDER_BOOTSTRAP_STAGES)[number];

export interface RecorderBootstrapResponse {
  startedAt: string;
  completedAt: string;
  stage: RecorderBootstrapStage;
  ready: boolean;
  summary: string;
  logPath: string | null;
}

export interface SessionListResponse {
  sessions: LabSession[];
}

export interface SessionResponse {
  session: LabSession;
}

export interface ArtifactResponse<T = unknown> {
  kind: LabArtifactKind;
  path: string;
  data: T;
}

export type LabLlmWireApi = "responses" | "chat-completions";
export type LabLlmClientProfile = "default" | "openai-js" | "codex-desktop";
export type LabLlmAuthMode = "direct" | "env" | "none";
export const LAB_LLM_RESPONSE_TIMEOUT_MODES = ["fixed", "idle"] as const;
export type LabLlmResponseTimeoutMode =
  (typeof LAB_LLM_RESPONSE_TIMEOUT_MODES)[number];
export const LAB_LLM_DEFAULT_RESPONSE_READ_TIMEOUT_MS = 90_000;
export const LAB_LLM_CALL_PROFILE_KEYS = LLM_CALL_PROFILE_KEYS;
export type LabLlmCallProfileKey = LlmCallProfileKey;

export interface LabLlmCallProfile {
  reasoningEffort: string | null;
  responseReadTimeoutMs: number | null;
}

export interface LabLlmCallProfileUpdateInput {
  reasoningEffort?: string | null;
  responseReadTimeoutMs?: number | null;
}

export type LabLlmCallProfiles = Record<
  LabLlmCallProfileKey,
  LabLlmCallProfile
>;

export type LabLlmCallProfilesUpdateInput = Partial<
  Record<LabLlmCallProfileKey, LabLlmCallProfileUpdateInput>
>;

export interface LabLlmConfig {
  provider: string | null;
  baseUrl: string;
  model: string;
  wireApi: LabLlmWireApi;
  reasoningEffort: string | null;
  responseReadTimeoutMs: number;
  responseTimeoutMode: LabLlmResponseTimeoutMode;
  callProfiles: LabLlmCallProfiles;
  clientProfile: LabLlmClientProfile | null;
  authMode: LabLlmAuthMode;
  apiKeyEnv: string | null;
  hasStoredApiKey: boolean;
  hasResolvedApiKey: boolean;
}

export interface LabLlmConfigUpdateInput {
  provider?: string | null;
  baseUrl: string;
  model: string;
  wireApi: LabLlmWireApi;
  reasoningEffort?: string | null;
  responseReadTimeoutMs?: number | null;
  responseTimeoutMode?: LabLlmResponseTimeoutMode | null;
  callProfiles?: LabLlmCallProfilesUpdateInput | null;
  clientProfile?: LabLlmClientProfile | null;
  authMode: LabLlmAuthMode;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
}

export interface LlmConfigResponse {
  path: string;
  config: LabLlmConfig;
}

export interface LabLlmModelsInput {
  baseUrl: string;
  authMode: LabLlmAuthMode;
  apiKey?: string | null;
  apiKeyEnv?: string | null;
}

export interface LlmModelsResponse {
  endpoint: string;
  models: string[];
}

export interface LabSkillManagerConfig {
  skillPath: string | null;
  updatedAt: string | null;
}

export type LabSkillManagerAgentFamily =
  | "openclaw"
  | "workbuddy"
  | "codebuddy"
  | "qoder"
  | "qoderwork"
  | "qwen"
  | "lingma"
  | "comate"
  | "codeartsdoer"
  | "iflow"
  | "trae"
  | "codex"
  | "claude"
  | "hermes";

export interface SkillManagerPathCandidate {
  id: string;
  label: string;
  agentFamily: LabSkillManagerAgentFamily;
  path: string;
  exists: boolean;
}

export type LabOpenClawInstallSourceType =
  "base" | "generalized" | "planner-optimized";

export type LabOpenClawPersonalSkillSourceType =
  "generated-managed" | "generated-unmanaged" | "manual-personal";

export interface LabOpenClawMissingRequirements {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
}

export interface LabOpenClawExportMarkerSummary {
  installName: string;
  installDir: string;
  generatedAt: string;
  sourceSkillPath: string;
  sourceSummaryPath: string | null;
  originalSkillName: string;
  skillId: string;
}

export interface LabOpenClawPersonalSkill {
  name: string;
  description: string;
  baseDir: string;
  filePath: string;
  sourceType: LabOpenClawPersonalSkillSourceType;
  eligible: boolean | null;
  disabled: boolean | null;
  missing: LabOpenClawMissingRequirements;
  marker: LabOpenClawExportMarkerSummary | null;
}

export interface LabManagedSkill {
  name: string;
  description: string;
  baseDir: string;
  filePath: string;
  sourceType: LabOpenClawPersonalSkillSourceType;
  marker: LabOpenClawExportMarkerSummary | null;
}

export interface LabOpenClawInstallResult {
  sourceType: LabOpenClawInstallSourceType;
  sourceSkillPath: string;
  installName: string;
  installDir: string;
  skillMdPath: string;
  validation: {
    skill: {
      ok: true;
      skillId: string;
      stepsCount: number;
      whenToUseCount: number;
      prerequisitesCount: number;
      successCriteriaCount: number;
    };
  };
}

export interface LabSkillManagerExportResult {
  sourceType: LabOpenClawInstallSourceType;
  sourceSkillPath: string;
  installName: string;
  installDir: string;
  skillMdPath: string;
  validation: {
    skill: {
      ok: true;
      skillId: string;
      stepsCount: number;
      whenToUseCount: number;
      prerequisitesCount: number;
      successCriteriaCount: number;
    };
  };
}

export interface LabOpenClawUninstallResult {
  installName: string;
  installDir: string;
  removed: true;
  sourceType: LabOpenClawPersonalSkillSourceType;
}

export interface OpenClawSkillsResponse {
  skills: LabOpenClawPersonalSkill[];
}

export interface OpenClawInstallResponse {
  result: LabOpenClawInstallResult;
}

export interface OpenClawUninstallResponse {
  result: LabOpenClawUninstallResult;
}

export interface SkillManagerConfigResponse {
  path: string;
  config: LabSkillManagerConfig;
}

export interface SkillManagerPathCandidatesResponse {
  candidates: SkillManagerPathCandidate[];
}

export interface SkillManagerSkillsResponse {
  skills: LabManagedSkill[];
}

export interface SkillManagerExportResponse {
  result: LabSkillManagerExportResult;
}

export interface SkillManagerUninstallResponse {
  result: LabOpenClawUninstallResult;
}

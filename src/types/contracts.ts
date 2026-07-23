export const UI_EVENT_TYPES = [
  "click",
  "move",
  "scroll",
  "key",
  "text",
  "app_switch",
  "window_focus",
  "clipboard",
] as const;
export type UiEventType = (typeof UI_EVENT_TYPES)[number];
export type EventType = UiEventType | "ocr" | "audio";
export interface RawRef {
  file: string;
  line: number;
}
export type NormalizedSource =
  | "ui-events"
  | "search-ocr"
  | "search-audio"
  | "search-input"
  | "search-ui"
  | "search-accessibility";
export interface NormalizedEvent {
  id: string;
  source: NormalizedSource;
  tsIso: string;
  tsMs: number;
  spanStartTsIso?: string | null;
  spanStartTsMs?: number | null;
  spanEndTsIso?: string | null;
  spanEndTsMs?: number | null;
  appName: string | null;
  windowName: string | null;
  eventType: EventType;
  textContent: string | null;
  x: number | null;
  y: number | null;
  keyCode: number | null;
  modifiers: number | null;
  browserUrl: string | null;
  frameId: number | null;
  deviceName?: string | null;
  speakerName?: string | null;
  rawRef: RawRef;
}
export interface Episode {
  id: string;
  runId: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  eventsCount: number;
  events: NormalizedEvent[];
}
export interface ScreenpipeCapabilityMatrix {
  healthAvailable: boolean;
  uiEventsEndpoint: boolean;
  searchAudioContentType: boolean;
  searchInputContentType: boolean;
  searchAccessibilityContentType: boolean;
  searchUiContentType: boolean;
  searchAllContentType: boolean;
  chosenUiEventSource:
    | "ui-events"
    | "search-input"
    | "search-accessibility"
    | "search-ui"
    | "search-all"
    | "search-combined"
    | "none";
}
export interface SegmenterConfig {
  idleGapMs: number;
  appSwitchSplitGapMs: number;
  maxEpisodeMs: number;
  version: "segmenter_v1";
}
// EN: Skill execution mode (autonomous only for now).
export type SkillExecutionMode = "autonomous";
// EN: Candidate workflow emitted by the workflow-discovery stage.
export interface WorkflowCandidate {
  workflowId: string;
  name: string;
  description: string;
  goal: string;
  priority: number;
  confidence?: number;
  startEventId: string;
  endEventId: string;
  startTs: string;
  endTs: string;
  eventCount: number;
  whyThisWorkflow?: string;
}
export interface RunManifest {
  runId: string;
  createdAt: string;
  status: "running" | "success" | "failed";
  args: {
    from: string;
    to: string;
    apps: string[] | "*";
    out: string;
    baseUrl: string;
  };
  paths: {
    runDir: string;
    rawUiEvents: string;
    rawOcr: string;
    rawAudio: string;
    normalizedEvents: string;
    episodes: string;
    summary: string;
  };
  capabilities: ScreenpipeCapabilityMatrix | null;
  segmenter: SegmenterConfig;
  warnings: string[];
  error: {
    message: string;
    stack?: string;
  } | null;
}
export interface IngestSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  timeWindow: {
    requested: {
      startTs: string;
      endTs: string;
      durationMs: number;
    };
    observed: {
      startTs: string | null;
      endTs: string | null;
      durationMs: number;
    };
  };
  fetch: {
    ocrPages: number;
    audioPages: number;
    uiPages: number;
    rawOcrCount: number;
    rawAudioCount: number;
    rawUiEventsCount: number;
  };
  transform: {
    normalizedCount: number;
    dedupedCount: number;
    droppedDuplicates: number;
  };
  episodes: {
    count: number;
    avgDurationMs: number;
    medianDurationMs: number;
  };
  warnings: string[];
}
export interface PaginationInfo {
  limit: number;
  offset: number;
  total: number;
}
export interface SearchResponse {
  data: Array<{ type: string; content: Record<string, unknown> }>;
  pagination: PaginationInfo;
}
export interface UiEventsResponse {
  data: Array<Record<string, unknown>>;
  pagination: PaginationInfo;
}
export interface FrameOcrTextPosition {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}
export interface FrameOcrResponse {
  frame_id?: number;
  text?: string;
  text_positions?: FrameOcrTextPosition[];
  [key: string]: unknown;
}
export interface HealthResponse {
  status?: string;
  status_code?: number;
  frame_status?: string;
  audio_status?: string;
  message?: string;
  [key: string]: unknown;
}
export interface RawEventWithRef {
  source: NormalizedSource;
  rawRef: RawRef;
  payload: Record<string, unknown>;
}
export interface OpenClawSkillStep {
  step: number;
  instruction: string;
  intent: string;
  operationApp: string;
  hints: string[];
  /** Stable IDs into the owning skill's top-level references catalog. */
  referenceRefs?: string[];
}
export type OpenClawSkillReferenceValue =
  string | string[] | Record<string, string>;
export interface OpenClawSkillReference {
  id: string;
  name: string;
  value: OpenClawSkillReferenceValue;
  notes?: string;
}
export type CandidateWorkflowNode =
  | {
      id: string;
      type: "action";
      title: string;
      objective: string;
      act: string[];
      operationApp: string;
      hints: string[];
      referenceRefs?: string[];
    }
  | {
      id: string;
      type: "decision";
      title: string;
      decision: string;
      hints: string[];
      referenceRefs?: string[];
    }
  | {
      id: string;
      type: "wait";
      title: string;
      waitFor: string;
      resumeCondition: string;
      hints: string[];
      referenceRefs?: string[];
    }
  | {
      id: string;
      type: "terminal";
      title: string;
      outcome: string;
      summary: string;
      hints: string[];
      referenceRefs?: string[];
    };
export type CandidateWorkflowTransition =
  | {
      id: string;
      from: string;
      to: string;
      type: "default";
    }
  | {
      id: string;
      from: string;
      to: string;
      type: "conditional";
      when: string;
    }
  | {
      id: string;
      from: string;
      to: string;
      type: "retry";
      when: string;
      maxAttempts: number;
    }
  | {
      id: string;
      from: string;
      to: string;
      type: "resume";
      when: string;
    };
export interface CandidateWorkflow {
  schemaVersion: "oyster-workflow-candidate-v2";
  candidateId: string;
  skillId: string;
  name: string;
  goal: string;
  entryNodeId: string;
  nodes: CandidateWorkflowNode[];
  transitions: CandidateWorkflowTransition[];
  /** Immutable catalog copied from Call 2; nodes bind to entries by ID. */
  references?: OpenClawSkillReference[];
}
export interface WorkflowFamilyCard {
  workflowId: string;
  name: string;
  goal: string;
  whenToUse: string[];
  outline: string[];
  terminalOutcomes: string[];
  apps: string[];
}
export interface WorkflowFamilyMatch {
  schemaVersion: "oyster-workflow-family-match-v1";
  candidateId: string;
  decision: "match" | "new_family" | "uncertain";
  matchedWorkflowId: string | null;
}
export type WorkflowMergeMappingDisposition =
  "reuse" | "adjust" | "add" | "merge" | "split";
export interface WorkflowMergeNodeMapping {
  candidateNodeId: string;
  mergedNodeIds: string[];
  disposition: WorkflowMergeMappingDisposition;
}
export interface WorkflowMergeTransitionMapping {
  candidateTransitionId: string;
  mergedTransitionIds: string[];
  disposition: WorkflowMergeMappingDisposition;
}
export interface WorkflowMergeProposal {
  schemaVersion: "oyster-workflow-merge-proposal-v1";
  proposalId: string;
  candidateId: string;
  baseWorkflowId: string;
  baseRevisionId: string;
  result: "merge" | "no_change" | "incompatible";
  mergedGraph: OysterWorkflowGraphDraftV2 | null;
  nodeMappings: WorkflowMergeNodeMapping[];
  transitionMappings: WorkflowMergeTransitionMapping[];
  proposalHash: string;
  createdAt: string;
}
export type WorkflowGraphNodeType = "action" | "decision" | "wait" | "terminal";
export type WorkflowGraphTransitionType =
  "default" | "conditional" | "retry" | "resume";
export interface WorkflowGraphSourceRef {
  kind: "skill" | "skill-step" | "episode";
  ref: string;
  label?: string;
}
interface WorkflowGraphNodeBase {
  id: string;
  type: WorkflowGraphNodeType;
  title: string;
  hints: string[];
  sourceRefs: WorkflowGraphSourceRef[];
  /** Stable IDs into the owning graph's top-level references catalog. */
  referenceRefs?: string[];
}
export interface WorkflowGraphActionNode extends WorkflowGraphNodeBase {
  type: "action";
  objective: string;
  act: string[];
  operationApp: string;
}
export interface WorkflowGraphDecisionNode extends WorkflowGraphNodeBase {
  type: "decision";
  decision: string;
}
export interface WorkflowGraphWaitNode extends WorkflowGraphNodeBase {
  type: "wait";
  waitFor: string;
  resumeCondition: string;
}
export interface WorkflowGraphTerminalNode extends WorkflowGraphNodeBase {
  type: "terminal";
  outcome: "completed" | "stopped" | "rejected" | "failed";
  summary: string;
}
export type WorkflowGraphNodeV2 =
  | WorkflowGraphActionNode
  | WorkflowGraphDecisionNode
  | WorkflowGraphWaitNode
  | WorkflowGraphTerminalNode;
export interface LegacyWorkflowGraphActionNodeV1 extends WorkflowGraphNodeBase {
  type: "action";
  objective: string;
  observe: string[];
  act: string[];
  verify: string[];
  operationApp: string;
}
export interface LegacyWorkflowGraphDecisionNodeV1 extends WorkflowGraphNodeBase {
  type: "decision";
  decision: string;
  observe: string[];
}
export type LegacyWorkflowGraphNodeV1 =
  | LegacyWorkflowGraphActionNodeV1
  | LegacyWorkflowGraphDecisionNodeV1
  | WorkflowGraphWaitNode
  | WorkflowGraphTerminalNode;
export type WorkflowGraphNode = WorkflowGraphNodeV2 | LegacyWorkflowGraphNodeV1;
interface WorkflowGraphTransitionBase {
  id: string;
  from: string;
  to: string;
  type: WorkflowGraphTransitionType;
  sourceRefs: WorkflowGraphSourceRef[];
}
export interface WorkflowGraphDefaultTransition extends WorkflowGraphTransitionBase {
  type: "default";
}
export interface WorkflowGraphConditionalTransition extends WorkflowGraphTransitionBase {
  type: "conditional";
  when: string;
  priority?: number;
}
export interface WorkflowGraphRetryTransition extends WorkflowGraphTransitionBase {
  type: "retry";
  when: string;
  maxAttempts: number;
}
export interface WorkflowGraphResumeTransition extends WorkflowGraphTransitionBase {
  type: "resume";
  when: string;
}
export type WorkflowGraphTransition =
  | WorkflowGraphDefaultTransition
  | WorkflowGraphConditionalTransition
  | WorkflowGraphRetryTransition
  | WorkflowGraphResumeTransition;
export interface WorkflowGraphRevision {
  number: number;
  revisionId: string;
  previousRevisionId: string | null;
  contentHash: string;
  createdAt: string;
}
interface OysterWorkflowGraphBase {
  workflowId: string;
  name: string;
  goal: string;
  entryNodeId: string;
  transitions: WorkflowGraphTransition[];
  /** Reference values are stored once and attached to nodes by ID. */
  references?: OpenClawSkillReference[];
  revision: WorkflowGraphRevision;
  source: {
    skillId: string;
    skillSchemaVersion: OpenClawSkill["schemaVersion"];
    skillGeneratedAt: string;
    promptSet: string | null;
    runId: string;
    runDir: string;
    episodeId: string;
  };
}
export interface LegacyOysterWorkflowGraphV1 extends OysterWorkflowGraphBase {
  schemaVersion: "oyster-workflow-graph-v1";
  nodes: LegacyWorkflowGraphNodeV1[];
}
export interface OysterWorkflowGraphV2 extends OysterWorkflowGraphBase {
  schemaVersion: "oyster-workflow-graph-v2";
  nodes: WorkflowGraphNodeV2[];
}
export type OysterWorkflowGraph =
  LegacyOysterWorkflowGraphV1 | OysterWorkflowGraphV2;
export type LegacyOysterWorkflowGraphDraftV1 = Omit<
  LegacyOysterWorkflowGraphV1,
  "revision"
>;
export type OysterWorkflowGraphDraftV2 = Omit<
  OysterWorkflowGraphV2,
  "revision"
>;
export type OysterWorkflowGraphDraft =
  LegacyOysterWorkflowGraphDraftV1 | OysterWorkflowGraphDraftV2;
export interface OpenClawSkillField {
  name: string;
  description: string;
  required?: boolean;
}
export type OpenClawSkillAssetValue = OpenClawSkillReferenceValue;
export interface OpenClawSkillAsset {
  name: string;
  value: OpenClawSkillAssetValue;
  notes?: string;
}
export interface OpenClawSkill {
  schemaVersion: "openclaw-skill-v1";
  promptSet: string | null;
  skillId: string;
  skillName: string;
  generatedAt: string;
  source: {
    runId: string;
    runDir: string;
    episodeId: string;
    startTs: string;
    endTs: string;
  };
  executionMode?: SkillExecutionMode;
  shortDescription?: string;
  description: string;
  goal: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputs: OpenClawSkillField[];
  outputs: OpenClawSkillField[];
  prerequisites: string[];
  steps: OpenClawSkillStep[];
  successCriteria: string[];
  failureModes: string[];
  fallback: string[];
  examples: string[];
  tags: string[];
  assets: OpenClawSkillAsset[];
  /** Case material used for inspection, comparison, or imitation. */
  references?: OpenClawSkillReference[];
  evidence: {
    totalEvents: number;
    anchorEvents: number;
    ocrEvents: number;
    appsSeen: string[];
    windowsSeen: string[];
  };
}
export interface LlmInvocationSummary {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalReactionTimeMs: number;
}
export interface PredictedReuseScenario {
  scenarioId: string;
  nextUseHypothesis: string;
}
export interface GeneralizedSkillVariantSummary {
  schemaVersion: "openclaw-generalized-skill-summary-v1";
  generatedAt: string;
  sourceSkillId: string;
  scenarioId: string;
  nextUseHypothesis: string;
  skillId: string;
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
export interface SkillGeneralizationSummary {
  predictedScenariosPath: string | null;
  scenarioCount: number;
  variants: GeneralizedSkillVariantSummary[];
  llm?: LlmInvocationSummary;
  warnings: string[];
}
export interface SkillExtractionSummary {
  runId: string;
  episodeId: string;
  skillId: string;
  generatedAt: string;
  generationGuidance?: string;
  sourceEvents: number;
  stepsCount: number;
  workflowCandidates?: WorkflowCandidate[];
  selectedWorkflowId?: string | null;
  selectedWorkflowPriority?: number | null;
  llm?: LlmInvocationSummary;
  generalization?: SkillGeneralizationSummary;
  output: {
    outDir: string;
    skillPath: string;
    summaryPath: string;
    workflowCandidatePath?: string;
    workflowFamilyMatchPath?: string;
    workflowMergeProposalPath?: string;
    workflowGraphPath?: string;
    workflowMarkdownPath?: string;
    workflowRevisionsDir?: string;
  };
  warnings: string[];
}
export interface SkillQualityDimension {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
}
export interface SkillQualityReport {
  schemaVersion: "openclaw-quality-v1";
  evaluatedAt: string;
  runId: string;
  episodeId: string;
  skillId: string;
  score: number;
  threshold: number;
  verdict: "usable" | "needs-improvement" | "poor";
  dimensions: SkillQualityDimension[];
  strengths: string[];
  issues: string[];
  improvements: string[];
  details: {
    warningsCount: number;
    stepsCount: number;
    genericStepCount: number;
    contextAnchoredStepCount: number;
    dominantApp: string | null;
    dominantAppStepCoverage: number;
    selectedWorkflowId?: string | null;
    selectedWorkflowPriority?: number | null;
    closureScore?: number;
    parameterHintCount?: number;
    parameterizationScore?: number;
    noiseRatio?: number;
    noiseScore?: number;
  };
}

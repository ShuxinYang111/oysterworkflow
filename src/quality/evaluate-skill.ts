import type {
  OpenClawSkill,
  OpenClawSkillAsset,
  OpenClawSkillField,
  OpenClawSkillStep,
  SkillExtractionSummary,
  SkillQualityDimension,
  SkillQualityReport,
} from "../types/contracts.js";

const DEFAULT_QUALITY_THRESHOLD = 70;
const AUXILIARY_CONTEXT_PATTERN = /terminal|screenpipe|codex|console|logs?/i;
const GENERIC_STEP_PATTERNS = [
  "click the corresponding control",
  "perform the corresponding action to advance the task",
  "minimum viable path",
  "perform the corresponding action",
  "click the target control",
  "advance the task",
  "open the target application and navigate to the page where the task should be completed",
  "establish the execution context",
];

/**
 * EN: Input options for skill quality evaluation.
 */
export interface EvaluateSkillQualityInput {
  skill: OpenClawSkill;
  summary: SkillExtractionSummary;
  threshold?: number;
  now?: Date;
}

/**
 * EN: Scores skill quality with deterministic rules, emphasizing closure, parameterization, and noise control.
 * @param input evaluation input (skill/assets/summary/threshold).
 * @returns quality report.
 */
export function evaluateSkillQuality(
  input: EvaluateSkillQualityInput,
): SkillQualityReport {
  const threshold = Number.isFinite(input.threshold)
    ? Math.max(1, Math.min(100, input.threshold ?? 0))
    : DEFAULT_QUALITY_THRESHOLD;
  const evaluatedAt = (input.now ?? new Date()).toISOString();
  const warnings = input.summary.warnings ?? [];
  const steps = input.skill.steps ?? [];
  const genericStepCount = steps.filter((step) =>
    isGenericStep(step.instruction, step.intent),
  ).length;
  const contextAnchoredStepCount = countContextAnchoredSteps(steps);
  const dominantApp = pickDominantApp(input.skill, steps);
  const dominantAppSteps = dominantApp
    ? steps.filter(
        (step) =>
          normalizeText(step.operationApp) === normalizeText(dominantApp),
      ).length
    : 0;
  const dominantAppStepCoverage =
    steps.length === 0 ? 0 : dominantAppSteps / steps.length;
  const closureDimension = scoreClosureCompleteness(input.skill, steps);
  const parameterizationDimension = scoreParameterization(input.skill, steps);
  const focusDimension = scoreTaskFocus(
    input.skill,
    steps,
    dominantApp,
    dominantAppStepCoverage,
  );
  const dimensions: SkillQualityDimension[] = [
    scoreLlmStability(warnings.length),
    scoreStepSpecificity(steps.length, genericStepCount),
    scoreContextAnchoring(steps.length, contextAnchoredStepCount),
    closureDimension,
    parameterizationDimension,
    focusDimension,
    scoreGoalClarity(input.skill.goal),
  ];

  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  const strengths = dimensions
    .filter((item) => item.score >= item.maxScore * 0.75)
    .map((item) => `${item.name}: ${item.reason}`);
  const issues = dimensions
    .filter((item) => item.score < item.maxScore * 0.6)
    .map((item) => `${item.name}: ${item.reason}`);
  const improvements = buildImprovements({
    genericStepCount,
    stepsCount: steps.length,
    contextAnchoredStepCount,
    closureScore: closureDimension.score,
    parameterizationScore: parameterizationDimension.score,
    focusScore: focusDimension.score,
    threshold,
    score,
  });

  const verdict =
    score >= threshold
      ? "usable"
      : score >= Math.max(40, threshold - 20)
        ? "needs-improvement"
        : "poor";

  return {
    schemaVersion: "openclaw-quality-v1",
    evaluatedAt,
    runId: input.summary.runId,
    episodeId: input.summary.episodeId,
    skillId: input.summary.skillId,
    score,
    threshold,
    verdict,
    dimensions,
    strengths,
    issues,
    improvements,
    details: {
      warningsCount: warnings.length,
      stepsCount: steps.length,
      genericStepCount,
      contextAnchoredStepCount,
      dominantApp,
      dominantAppStepCoverage,
      closureScore: closureDimension.score,
      parameterHintCount: countParameterSignals(input.skill, steps),
      parameterizationScore: parameterizationDimension.score,
      noiseRatio: computeFocusLossRatio(
        input.skill,
        steps,
        dominantApp,
        dominantAppStepCoverage,
      ),
      noiseScore: focusDimension.score,
    },
  };
}

function isGenericStep(instruction: string, intent: string): boolean {
  const text =
    `${normalizeText(instruction)} ${normalizeText(intent)}`.toLowerCase();
  if (text.length < 8) {
    return true;
  }
  return GENERIC_STEP_PATTERNS.some((pattern) =>
    text.includes(pattern.toLowerCase()),
  );
}

function scoreLlmStability(warningsCount: number): SkillQualityDimension {
  const maxScore = 10;
  const score = Math.max(0, maxScore - Math.min(4, warningsCount));
  return {
    name: "LLM Stability",
    score,
    maxScore,
    reason:
      warningsCount > 0
        ? `${warningsCount} warnings were recorded, which suggests the output still needs more robustness.`
        : "No extra warnings were recorded, and the output looks stable.",
  };
}

function scoreStepSpecificity(
  stepsCount: number,
  genericStepCount: number,
): SkillQualityDimension {
  const maxScore = 15;
  if (stepsCount === 0) {
    return {
      name: "Step Specificity",
      score: 0,
      maxScore,
      reason: "No steps were generated.",
    };
  }

  const genericRatio = genericStepCount / stepsCount;
  const countPenalty = stepsCount < 2 ? 5 : stepsCount > 12 ? 4 : 0;
  const genericPenalty = Math.round(genericRatio * 10);
  return {
    name: "Step Specificity",
    score: Math.max(0, maxScore - countPenalty - genericPenalty),
    maxScore,
    reason:
      genericStepCount === 0
        ? "The steps map cleanly to mid-granularity actions."
        : `${genericStepCount}/${stepsCount} steps are still too template-like.`,
  };
}

function countContextAnchoredSteps(steps: OpenClawSkillStep[]): number {
  return steps.filter((step) => {
    const hasOperationApp = normalizeText(step.operationApp).length > 0;
    const hasHints = step.hints.some((hint) => normalizeText(hint).length > 0);
    return hasOperationApp || hasHints;
  }).length;
}

function scoreContextAnchoring(
  stepsCount: number,
  contextAnchoredStepCount: number,
): SkillQualityDimension {
  const maxScore = 10;
  if (stepsCount === 0) {
    return {
      name: "Context Anchoring",
      score: 0,
      maxScore,
      reason: "There are no steps to evaluate for context anchoring.",
    };
  }

  const coverage = contextAnchoredStepCount / stepsCount;
  let score = maxScore;
  if (coverage < 0.8) {
    score -= 5;
  } else if (coverage < 1) {
    score -= 2;
  }
  return {
    name: "Context Anchoring",
    score: Math.max(0, score),
    maxScore,
    reason: `${contextAnchoredStepCount} steps include context anchors, for a coverage ratio of ${coverage.toFixed(2)}.`,
  };
}

function scoreClosureCompleteness(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
): SkillQualityDimension {
  const maxScore = 25;
  if (steps.length === 0) {
    return {
      name: "Closure Completeness",
      score: 0,
      maxScore,
      reason: "There are no steps to evaluate for closure.",
    };
  }

  let score = 0;
  const concreteCriteriaCount = skill.successCriteria.filter(
    (item) =>
      normalizeText(item).length >= 8 &&
      !/complete the task|complete the workflow|task completed|done|success/i.test(
        item,
      ),
  ).length;
  if (skill.successCriteria.length > 0) {
    score += 10;
  }
  if (steps.length >= 2) {
    score += 4;
  }
  if (
    !isGenericStep(
      steps[steps.length - 1]?.instruction ?? "",
      steps[steps.length - 1]?.intent ?? "",
    )
  ) {
    score += 5;
  }
  score += Math.min(6, concreteCriteriaCount * 2 + 2);

  return {
    name: "Closure Completeness",
    score: Math.min(maxScore, score),
    maxScore,
    reason:
      concreteCriteriaCount > 0
        ? `${skill.successCriteria.length} success criteria were found, including ${concreteCriteriaCount} concrete ones.`
        : "The success criteria are still too vague, so the closure is hard to verify.",
  };
}

function scoreParameterization(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
): SkillQualityDimension {
  const maxScore = 15;
  const signalCount = countParameterSignals(skill, steps);
  const score = Math.min(maxScore, signalCount * 2 + (signalCount > 0 ? 3 : 0));
  return {
    name: "Parameterization Potential",
    score,
    maxScore,
    reason:
      signalCount > 0
        ? `${signalCount} reusable parameter signals were detected.`
        : "The skill lacks reusable parameter signals and may overfit to the current trace.",
  };
}

function scoreTaskFocus(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
  dominantApp: string | null,
  dominantAppStepCoverage: number,
): SkillQualityDimension {
  const maxScore = 15;
  if (steps.length === 0) {
    return {
      name: "Task Focus",
      score: 0,
      maxScore,
      reason: "There are no steps.",
    };
  }

  const focusLossRatio = computeFocusLossRatio(
    skill,
    steps,
    dominantApp,
    dominantAppStepCoverage,
  );
  const score = Math.max(0, Math.round((1 - focusLossRatio) * maxScore));
  return {
    name: "Task Focus",
    score,
    maxScore,
    reason: `The estimated ratio of steps that drift from the observed context is ${focusLossRatio.toFixed(2)}.`,
  };
}

function scoreGoalClarity(goal: string): SkillQualityDimension {
  const maxScore = 5;
  const normalizedGoal = normalizeText(goal);
  if (normalizedGoal.length < 8) {
    return {
      name: "Goal Clarity",
      score: 1,
      maxScore,
      reason: "The goal description is too short.",
    };
  }
  const isGeneric = /reusable|related task|workflow|operation task/i.test(
    normalizedGoal,
  );
  return {
    name: "Goal Clarity",
    score: isGeneric ? 3 : 5,
    maxScore,
    reason: isGeneric
      ? "The goal is still too generic."
      : "The goal description is clear.",
  };
}

function buildImprovements(input: {
  genericStepCount: number;
  stepsCount: number;
  contextAnchoredStepCount: number;
  closureScore: number;
  parameterizationScore: number;
  focusScore: number;
  threshold: number;
  score: number;
}): string[] {
  const improvements: string[] = [];

  if (input.closureScore < 12) {
    improvements.push(
      "Closure is too weak: strengthen the completion conditions, final result page, or final artifact description so the skill is easier to verify.",
    );
  }

  if (input.parameterizationScore < 8) {
    improvements.push(
      "Parameterization is too weak: keep more replaceable inputs, page cues, entity identifiers, or step hints.",
    );
  }

  if (input.focusScore < 8) {
    improvements.push(
      "Task focus is too weak: some steps mix in off-task applications or low-value actions and should stay closer to the real objective.",
    );
  }

  if (input.genericStepCount > 0) {
    improvements.push(
      "The LLM output is too generic: make the steps more concrete, reduce template-like phrasing, and retain real actions plus key checkpoints.",
    );
  }

  if (
    input.stepsCount > 0 &&
    input.contextAnchoredStepCount < input.stepsCount
  ) {
    improvements.push(
      "Context anchoring is too weak: some steps are missing a clear operationApp or hints, so execution would be hard to localize.",
    );
  }

  if (input.score < input.threshold) {
    improvements.push(
      "The quality gate failed: improve step specificity, parameter signals, and verifiable completion conditions before deciding whether to retry the LLM.",
    );
  }

  return uniqueStrings(improvements);
}

function pickDominantApp(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
): string | null {
  if (skill.evidence.appsSeen.length === 1) {
    return skill.evidence.appsSeen[0] ?? null;
  }

  const counter = new Map<string, number>();
  for (const step of steps) {
    const app = normalizeText(step.operationApp);
    if (app.length === 0) {
      continue;
    }
    if (
      skill.evidence.appsSeen.length > 0 &&
      !skill.evidence.appsSeen.some(
        (observedApp) => normalizeText(observedApp) === app,
      )
    ) {
      continue;
    }
    counter.set(app, (counter.get(app) ?? 0) + 1);
  }

  let bestApp: string | null = null;
  let bestCount = -1;
  for (const [app, count] of counter.entries()) {
    if (count > bestCount) {
      bestApp = app;
      bestCount = count;
    }
  }
  return bestApp ?? skill.evidence.appsSeen[0] ?? null;
}

function countParameterSignals(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
): number {
  const placeholderCount = countPlaceholders([
    skill.goal,
    ...flattenSkillFields(skill.inputs),
    ...flattenSkillFields(skill.outputs),
    ...skill.prerequisites,
    ...skill.successCriteria,
    ...flattenSkillAssets(skill.assets),
    ...steps.flatMap((step) => [step.instruction, step.intent, ...step.hints]),
  ]);
  const hintCount = steps.reduce(
    (sum, step) =>
      sum + step.hints.filter((hint) => normalizeText(hint).length > 0).length,
    0,
  );
  const reusableSignals = [
    skill.inputs.length > 0,
    skill.outputs.length > 0,
    skill.assets.length > 0,
    skill.evidence.appsSeen.length > 0,
    skill.evidence.windowsSeen.length > 0,
  ].filter(Boolean).length;

  return placeholderCount + hintCount + reusableSignals;
}

function countPlaceholders(values: string[]): number {
  return values.reduce(
    (sum, value) => sum + (value.match(/\{\{[^}]+\}\}/g)?.length ?? 0),
    0,
  );
}

function flattenSkillFields(fields: OpenClawSkillField[]): string[] {
  return fields.flatMap((field) => {
    const values = [
      normalizeText(field.name),
      normalizeText(field.description),
    ];
    return values.filter((value) => value.length > 0);
  });
}

function flattenSkillAssets(values: OpenClawSkillAsset[]): string[] {
  return values.flatMap((value) => {
    const base = [normalizeText(value.name), normalizeText(value.notes)].filter(
      (item) => item.length > 0,
    );

    if (typeof value.value === "string") {
      return [...base, normalizeText(value.value)].filter(
        (item) => item.length > 0,
      );
    }

    if (Array.isArray(value.value)) {
      return [
        ...base,
        ...value.value
          .map((item) => normalizeText(item))
          .filter((item) => item.length > 0),
      ];
    }

    return [
      ...base,
      ...Object.entries(value.value).flatMap(([key, item]) => {
        const normalizedKey = normalizeText(key);
        const normalizedValue = normalizeText(item);
        return [normalizedKey, normalizedValue].filter(
          (part) => part.length > 0,
        );
      }),
    ];
  });
}

function computeFocusLossRatio(
  skill: OpenClawSkill,
  steps: OpenClawSkillStep[],
  dominantApp: string | null,
  dominantAppStepCoverage: number,
): number {
  if (steps.length === 0) {
    return 1;
  }

  const observedApps = new Set(
    skill.evidence.appsSeen
      .map((value) => normalizeText(value))
      .filter((value) => value.length > 0),
  );
  const offSurfaceSteps = steps.filter((step) => {
    const operationApp = normalizeText(step.operationApp);
    if (operationApp.length === 0 || operationApp === "target application") {
      return false;
    }
    if (AUXILIARY_CONTEXT_PATTERN.test(operationApp)) {
      return true;
    }
    return observedApps.size > 0 && !observedApps.has(operationApp);
  }).length;
  const dominantPenalty =
    dominantApp && dominantAppStepCoverage < 0.5 ? 0.25 : 0;
  const auxiliaryHintPenalty = steps.some((step) =>
    AUXILIARY_CONTEXT_PATTERN.test(
      `${step.operationApp} ${step.instruction} ${step.hints.join(" ")}`,
    ),
  )
    ? 0.25
    : 0;
  return Math.min(
    1,
    offSurfaceSteps / steps.length + dominantPenalty + auxiliaryHintPenalty,
  );
}

function normalizeText(value: string | null | undefined): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function uniqueStrings(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value) => value.length > 0),
    ),
  ];
}

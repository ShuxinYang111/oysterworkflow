import { readFile } from "node:fs/promises";
import type { OpenClawSkill, SkillExecutionMode } from "../types/contracts.js";

const POLLUTION_KEYWORDS = ["terminal", "codex", "screenpipe"];
const TOKEN_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "your",
  "current",
  "page",
  "result",
  "open",
  "click",
  "check",
  "current",
  "already",
  "google",
  "docs",
  "ups",
  "claim",
  "page",
  "result-page",
  "current",
  "already",
  "enter",
  "open",
  "verify",
  "record",
  "key-point",
  "check",
  "step",
  "complete",
  "need",
  "can",
  "result",
  "details-page",
]);

export interface SkillIdealComparisonDimension {
  name: string;
  score: number;
  maxScore: number;
  reason: string;
}

export interface SkillIdealComparison {
  mode: SkillExecutionMode;
  idealPath: string;
  score: number;
  threshold: number;
  verdict: "close" | "partial" | "far";
  dimensions: SkillIdealComparisonDimension[];
  missingKeywords: string[];
  pollutionHits: string[];
}

/**
 * EN: Loads an ideal skill file and compares it against one generated skill.
 * @param input generated skill, ideal path, and threshold.
 * @returns ideal comparison result.
 */
export async function compareSkillWithIdealFile(input: {
  generatedSkill: OpenClawSkill;
  idealPath: string;
  threshold?: number;
}): Promise<SkillIdealComparison> {
  const raw = await readFile(input.idealPath, "utf8");
  const idealSkill = JSON.parse(raw) as OpenClawSkill;
  return compareSkillWithIdeal({
    generatedSkill: input.generatedSkill,
    idealSkill,
    idealPath: input.idealPath,
    threshold: input.threshold,
  });
}

/**
 * EN: Compares one generated skill to one ideal skill.
 * @param input generated skill, ideal skill, and threshold.
 * @returns ideal comparison result.
 */
export function compareSkillWithIdeal(input: {
  generatedSkill: OpenClawSkill;
  idealSkill: OpenClawSkill;
  idealPath: string;
  threshold?: number;
}): SkillIdealComparison {
  const threshold = input.threshold ?? 70;
  const dimensions: SkillIdealComparisonDimension[] = [];

  const modeScore =
    input.generatedSkill.executionMode === input.idealSkill.executionMode
      ? 5
      : 0;
  dimensions.push({
    name: "executionMode",
    score: modeScore,
    maxScore: 5,
    reason:
      modeScore === 5
        ? "execution mode matches ideal"
        : "execution mode differs from ideal",
  });

  const nameCoverage = calcLineCoverage(
    input.generatedSkill.skillName,
    input.idealSkill.skillName,
  );
  dimensions.push({
    name: "skillName",
    score: Math.round(nameCoverage * 20),
    maxScore: 20,
    reason: summarizeCoverage(
      nameCoverage,
      input.generatedSkill.skillName,
      input.idealSkill.skillName,
    ),
  });

  const goalCoverage = calcLineCoverage(
    input.generatedSkill.goal,
    input.idealSkill.goal,
  );
  dimensions.push({
    name: "goal",
    score: Math.round(goalCoverage * 15),
    maxScore: 15,
    reason: summarizeCoverage(
      goalCoverage,
      input.generatedSkill.goal,
      input.idealSkill.goal,
    ),
  });

  const prerequisitesCoverage = calcListCoverage(
    input.generatedSkill.prerequisites,
    input.idealSkill.prerequisites,
  );
  dimensions.push({
    name: "prerequisites",
    score: Math.round(prerequisitesCoverage * 20),
    maxScore: 20,
    reason: `matched ${Math.round(prerequisitesCoverage * 100)}% of ideal prerequisite intent`,
  });

  const stepsCoverage = calcStepsCoverage(
    input.generatedSkill.steps,
    input.idealSkill.steps,
  );
  dimensions.push({
    name: "steps",
    score: Math.round(stepsCoverage * 30),
    maxScore: 30,
    reason: `matched ${Math.round(stepsCoverage * 100)}% of ideal step intent`,
  });

  const successCoverage = calcListCoverage(
    input.generatedSkill.successCriteria,
    input.idealSkill.successCriteria,
  );
  dimensions.push({
    name: "successCriteria",
    score: Math.round(successCoverage * 10),
    maxScore: 10,
    reason: `matched ${Math.round(successCoverage * 100)}% of ideal success criteria intent`,
  });

  const pollutionHits = detectPollution(input.generatedSkill);
  const pollutionScore = Math.max(0, 20 - pollutionHits.length * 5);
  dimensions.push({
    name: "pollution",
    score: pollutionScore,
    maxScore: 20,
    reason:
      pollutionHits.length === 0
        ? "no polluted context keywords detected"
        : `polluted keywords: ${pollutionHits.join(", ")}`,
  });

  const score = dimensions.reduce((sum, item) => sum + item.score, 0);
  const missingKeywords = collectMissingKeywords(
    input.generatedSkill,
    input.idealSkill,
  );
  const verdict =
    score >= threshold
      ? "close"
      : score >= Math.round(threshold * 0.75)
        ? "partial"
        : "far";

  return {
    mode: input.idealSkill.executionMode ?? "autonomous",
    idealPath: input.idealPath,
    score,
    threshold,
    verdict,
    dimensions,
    missingKeywords,
    pollutionHits,
  };
}

function calcStepsCoverage(
  generated: OpenClawSkill["steps"],
  ideal: OpenClawSkill["steps"],
): number {
  if (ideal.length === 0) {
    return 1;
  }
  const instructionCoverage = calcListCoverage(
    generated.map((step) => step.instruction),
    ideal.map((step) => step.instruction),
  );
  const countPenalty = Math.max(
    0,
    1 - Math.abs(generated.length - ideal.length) / Math.max(ideal.length, 1),
  );
  return instructionCoverage * 0.8 + countPenalty * 0.2;
}

function calcListCoverage(generated: string[], ideal: string[]): number {
  if (ideal.length === 0) {
    return 1;
  }
  const scores = ideal.map((idealLine) => {
    let best = 0;
    for (const generatedLine of generated) {
      best = Math.max(best, calcLineCoverage(generatedLine, idealLine));
    }
    return best;
  });
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function calcLineCoverage(generated: string, ideal: string): number {
  const generatedTokens = extractTokens(generated);
  const idealTokens = extractTokens(ideal);
  if (idealTokens.length === 0) {
    return normalizeText(generated) === normalizeText(ideal) ? 1 : 0;
  }
  const generatedSet = new Set(generatedTokens);
  const overlap = idealTokens.filter((token) => generatedSet.has(token));
  const recall = overlap.length / idealTokens.length;
  const normalizedGenerated = normalizeText(generated);
  const normalizedIdeal = normalizeText(ideal);
  const substringBonus =
    normalizedGenerated.includes(normalizedIdeal) ||
    normalizedIdeal.includes(normalizedGenerated)
      ? 0.15
      : 0;
  return Math.min(1, recall + substringBonus);
}

function collectMissingKeywords(
  generatedSkill: OpenClawSkill,
  idealSkill: OpenClawSkill,
): string[] {
  const generatedCorpus = buildCorpus(generatedSkill);
  const generatedTokens = new Set(extractTokens(generatedCorpus));
  return unique(
    extractTokens(buildCorpus(idealSkill)).filter(
      (token) => !generatedTokens.has(token),
    ),
  ).slice(0, 12);
}

function detectPollution(skill: OpenClawSkill): string[] {
  const corpus = buildCorpus(skill).toLowerCase();
  return POLLUTION_KEYWORDS.filter((keyword) => corpus.includes(keyword));
}

function summarizeCoverage(
  coverage: number,
  generated: string,
  ideal: string,
): string {
  if (coverage >= 0.9) {
    return "very close to ideal";
  }
  if (coverage >= 0.7) {
    return "partially matches ideal wording";
  }
  return `generated="${truncate(normalizeText(generated), 50)}" ideal="${truncate(normalizeText(ideal), 50)}"`;
}

function buildCorpus(skill: OpenClawSkill): string {
  return [
    skill.skillName,
    skill.description,
    skill.goal,
    ...normalizeStringList(skill.whenToUse),
    ...normalizeStringList(skill.whenNotToUse),
    ...flattenSkillFields(skill.inputs),
    ...flattenSkillFields(skill.outputs),
    ...normalizeStringList(skill.prerequisites),
    ...normalizeSteps(skill.steps).map(
      (step) => `${step.instruction} ${step.intent} ${step.hints.join(" ")}`,
    ),
    ...normalizeStringList(skill.successCriteria),
    ...normalizeStringList(skill.failureModes),
    ...normalizeStringList(skill.fallback),
    ...normalizeStringList(skill.examples),
    ...normalizeStringList(skill.tags),
    ...flattenSkillAssets(skill.assets),
  ]
    .map((value) => normalizeText(value))
    .join(" ");
}

function flattenSkillFields(fields: unknown): string[] {
  if (!Array.isArray(fields)) {
    return normalizeStringList(fields);
  }
  return fields.flatMap((field) =>
    typeof field === "string"
      ? [normalizeText(field)]
      : isRecord(field)
        ? [
            typeof field.name === "string" ? field.name : "",
            typeof field.description === "string" ? field.description : "",
          ].map((value) => normalizeText(value))
        : [],
  );
}

function flattenSkillAssets(values: unknown): string[] {
  if (isLegacyAssetRecord(values)) {
    return [
      ...normalizeStringList(values.texts),
      ...normalizeStringList(values.urls),
      ...normalizeLegacyCredentialAssets(values.credentials),
    ];
  }
  if (!Array.isArray(values)) {
    return [];
  }
  return values.flatMap((value) => {
    if (!isRecord(value)) {
      return [];
    }
    const base = [
      typeof value.name === "string" ? value.name : "",
      typeof value.notes === "string" ? value.notes : "",
    ];
    if (typeof value.value === "string") {
      return [...base, value.value];
    }
    if (Array.isArray(value.value)) {
      return [
        ...base,
        ...value.value.filter(
          (item): item is string => typeof item === "string",
        ),
      ];
    }
    if (!isRecord(value.value)) {
      return base;
    }
    return [
      ...base,
      ...Object.entries(value.value).flatMap(([key, item]) =>
        typeof item === "string" ? [key, item] : [key],
      ),
    ];
  });
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => normalizeText(item))
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    const normalized = normalizeText(value);
    return normalized.length > 0 ? [normalized] : [];
  }
  return [];
}

function normalizeSteps(value: unknown): Array<{
  instruction: string;
  intent: string;
  hints: string[];
}> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((step) => {
    if (!isRecord(step)) {
      return [];
    }
    return [
      {
        instruction: normalizeText(String(step.instruction ?? "")),
        intent: normalizeText(String(step.intent ?? "")),
        hints: normalizeStringList(step.hints),
      },
    ];
  });
}

function normalizeLegacyCredentialAssets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    return [item.account, item.username, item.name, item.password, item.secret]
      .filter((part): part is string => typeof part === "string")
      .map((part) => normalizeText(part))
      .filter((part) => part.length > 0);
  });
}

function isLegacyAssetRecord(value: unknown): value is {
  credentials?: unknown;
  texts?: unknown;
  urls?: unknown;
} {
  return (
    isRecord(value) &&
    ("credentials" in value || "texts" in value || "urls" in value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function extractTokens(value: string): string[] {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized.length === 0) {
    return [];
  }

  const phraseMatches =
    normalized.match(/[\u4e00-\u9fff]{2,}|[a-z0-9$][a-z0-9./-]{1,}/g) ?? [];
  return unique(
    phraseMatches.filter(
      (token) => token.length >= 2 && !TOKEN_STOPWORDS.has(token),
    ),
  );
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function unique(values: string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => normalizeText(value))
        .filter((value) => value.length > 0),
    ),
  ];
}

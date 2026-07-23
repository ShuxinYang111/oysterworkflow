import type { OpenClawSkill } from "../types/contracts.js";
import {
  type ExecutionProtocol,
  type HarnessPlanning,
  type RulePack,
  type RulePackLevel,
  type SurfaceRulePackId,
  executionProtocolSchema,
  harnessPlanningSchema,
} from "./types.js";

interface RulePackSelection {
  surface: RulePack | null;
  app: RulePack | null;
}

/**
 * EN: Parses and validates the first-call planning output against the RulePack catalog.
 * @param raw raw LLM JSON value.
 * @param input source skill and RulePack catalog.
 * @returns validated planning object.
 */
export function parseAndValidateHarnessPlanning(
  raw: unknown,
  input: {
    skill: OpenClawSkill;
    rulePacks: RulePack[];
  },
): HarnessPlanning {
  const planning = harnessPlanningSchema.parse(raw);
  if (planning.sourceSkillId !== input.skill.skillId) {
    throw new Error(
      `Planning sourceSkillId mismatch: expected ${input.skill.skillId}, got ${planning.sourceSkillId}.`,
    );
  }
  validateSequentialPhaseIds(planning.phases.map((phase) => phase.id));
  const index = indexRulePacks(input.rulePacks);
  for (const phase of planning.phases) {
    validatePhaseRulePackSelection(phase.id, phase.rulePackIds, index);
  }
  return planning;
}

/**
 * EN: Parses and validates the second-call execution protocol.
 * @param raw raw LLM JSON value.
 * @param input source skill, planning, selected mode and RulePack catalog.
 * @returns validated execution protocol.
 */
export function parseAndValidateExecutionProtocol(
  raw: unknown,
  input: {
    skill: OpenClawSkill;
    planning: HarnessPlanning;
    mode: "autonomous" | "collaborative";
    rulePacks: RulePack[];
  },
): ExecutionProtocol {
  const protocol = executionProtocolSchema.parse(raw);
  if (protocol.sourceSkillId !== input.skill.skillId) {
    throw new Error(
      `Execution protocol sourceSkillId mismatch: expected ${input.skill.skillId}, got ${protocol.sourceSkillId}.`,
    );
  }
  if (protocol.mode !== input.mode) {
    throw new Error(
      `Execution protocol mode mismatch: expected ${input.mode}, got ${protocol.mode}.`,
    );
  }
  if (protocol.phases.length !== input.planning.phases.length) {
    throw new Error(
      `Execution protocol phase count ${protocol.phases.length} does not match planning phase count ${input.planning.phases.length}.`,
    );
  }
  const index = indexRulePacks(input.rulePacks);
  for (const [phaseIndex, phase] of protocol.phases.entries()) {
    const planned = input.planning.phases[phaseIndex];
    if (phase.id !== planned.id) {
      throw new Error(
        `Execution protocol phase id mismatch at index ${phaseIndex}: expected ${planned.id}, got ${phase.id}.`,
      );
    }
    if (!sameStringSet(phase.rulePackIds, planned.rulePackIds)) {
      throw new Error(
        `${phase.id} rulePackIds must match planning rulePackIds.`,
      );
    }
    validatePhaseRulePackSelection(phase.id, phase.rulePackIds, index);
  }
  return protocol;
}

function validateSequentialPhaseIds(ids: string[]): void {
  for (const [index, id] of ids.entries()) {
    const expected = `phase-${String(index + 1).padStart(2, "0")}`;
    if (id !== expected) {
      throw new Error(
        `Phase id must be sequential. Expected ${expected}, got ${id}.`,
      );
    }
  }
}

function validatePhaseRulePackSelection(
  phaseId: string,
  rulePackIds: string[],
  rulePackIndex: Map<string, RulePack>,
): RulePackSelection {
  if (rulePackIds.length > 2) {
    throw new Error(`${phaseId} must select at most two RulePacks.`);
  }

  const selected = rulePackIds.map((id) => {
    const rulePack = rulePackIndex.get(id);
    if (!rulePack) {
      throw new Error(`${phaseId} references unknown RulePack: ${id}.`);
    }
    return rulePack;
  });

  const byLevel = new Map<RulePackLevel, RulePack[]>();
  for (const rulePack of selected) {
    byLevel.set(rulePack.level, [
      ...(byLevel.get(rulePack.level) ?? []),
      rulePack,
    ]);
  }

  const surfaces = byLevel.get("surface") ?? [];
  const apps = byLevel.get("app") ?? [];
  if (surfaces.length !== 1) {
    throw new Error(`${phaseId} must select exactly one surface RulePack.`);
  }
  if (apps.length > 1) {
    throw new Error(`${phaseId} must select at most one app RulePack.`);
  }

  const surface = surfaces[0] ?? null;
  const app = apps[0] ?? null;
  if (
    surface &&
    app &&
    !(app.compatibleSurfaces ?? []).includes(surface.id as SurfaceRulePackId)
  ) {
    throw new Error(
      `${phaseId} app RulePack ${app.id} is not compatible with surface ${surface.id}.`,
    );
  }

  return { surface, app };
}

function indexRulePacks(rulePacks: RulePack[]): Map<string, RulePack> {
  return new Map(rulePacks.map((rulePack) => [rulePack.id, rulePack]));
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

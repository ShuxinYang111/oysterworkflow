import type { OpenClawSkill } from "../types/contracts.js";
import {
  HARNESS_EXECUTION_PROTOCOL_SCHEMA_VERSION,
  HARNESS_PLANNING_SCHEMA_VERSION,
  type HarnessMode,
  type HarnessPlanning,
  type RulePack,
  type RulePackCatalogItem,
} from "./types.js";

export interface HarnessPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function buildHarnessPlanningPrompt(input: {
  skill: OpenClawSkill;
  rulePackCatalog: RulePackCatalogItem[];
}): HarnessPrompt {
  return {
    systemPrompt: [
      "You are the OysterWorkflow Harness planning model.",
      "Your only job is to split the source skill into natural business phases and select RulePacks for each phase.",
      "Do not generate the final harness, execution instructions, checkpoints, validations, blocking policy, or reference lookups.",
      "Phases are business stages, not clicks, keystrokes, scrolling, window switches, or app switches.",
      "Keep the source skill timeline unless the skill clearly contains independent work.",
      "Each phase must select exactly one surface RulePack and may select at most one app RulePack.",
      "Allowed surface RulePacks are surface.browser, surface.desktop_app, and surface.terminal.",
      "Never invent RulePack ids. Select only ids from the provided catalog.",
      "Do not choose file-system as a surface; files are inputs, outputs, artifacts, or validation targets.",
      "Return exactly one JSON object and no Markdown.",
    ].join("\n"),
    userPrompt: JSON.stringify(
      {
        requiredOutputSchema: {
          schemaVersion: HARNESS_PLANNING_SCHEMA_VERSION,
          sourceSkillId: "string",
          phases: [
            {
              id: "phase-01",
              title: "string",
              objective: "string",
              sourceSkillSteps: [1],
              entryState: "observable state before this phase starts",
              exitState: "observable state after this phase completes",
              rulePackIds: ["surface.browser", "app.gmail"],
              artifacts: ["optional phase output or modified artifact"],
            },
          ],
          assumptions: ["string"],
        },
        hardRules: [
          "Do not include referenceLookups, checkpointNeeds, validationNeeds, blockingConditions, completionStandard, dependencyNotes, or parallelizable.",
          "Every phase must have exactly one surface RulePack.",
          "Every phase may have zero or one app RulePack.",
          "Each app RulePack must be compatible with the chosen surface RulePack.",
          "Use artifacts only when the phase clearly creates, modifies, downloads, exports, or depends on a named deliverable.",
        ],
        rulePackCatalog: input.rulePackCatalog,
        skill: input.skill,
      },
      null,
      2,
    ),
  };
}

export function buildExecutionProtocolPrompt(input: {
  skill: OpenClawSkill;
  planning: HarnessPlanning;
  selectedRulePacks: RulePack[];
  mode: HarnessMode;
}): HarnessPrompt {
  return {
    systemPrompt: [
      "You are the OysterWorkflow Harness generation model.",
      "Generate the executionProtocol from the source skill, the planning result, and the selected RulePack guidance.",
      "Respect the planning phase order, phase count, phase ids, and rulePackIds exactly.",
      "RulePacks do not choose runtime providers. Do not mention BrowserAct, Playwright, MCP, Gmail API, Chrome plugin, or other provider policy unless the source skill itself requires it.",
      "Write validation as observable self-checks for the agent.",
      "Write checkpoints only for normal-path user review or approval before high-risk actions.",
      "Write stopIf conditions for missing context, unsafe state, ambiguity, or inability to verify.",
      "Place RulePack expert document references into the relevant phase instructions by path, but do not inline expert document contents.",
      "Return exactly one JSON object and no Markdown.",
    ].join("\n"),
    userPrompt: JSON.stringify(
      {
        mode: input.mode,
        modePolicy:
          input.mode === "autonomous"
            ? [
                "Autonomous mode should gather needed inputs up front and should not wait for the user mid-run except for approval-required high-risk actions or blocking conditions.",
                "Use validation for self-checks rather than asking the user to confirm routine progress.",
              ]
            : [
                "Collaborative mode should expose meaningful review points when the workflow creates content, makes judgments, or reaches a decision boundary.",
                "Each user review checkpoint should include what the agent will show the user before continuing.",
              ],
        requiredOutputSchema: {
          schemaVersion: HARNESS_EXECUTION_PROTOCOL_SCHEMA_VERSION,
          sourceSkillId: "string",
          title: "string",
          description: "string",
          mode: input.mode,
          phases: [
            {
              id: "phase-01",
              title: "string",
              objective: "string",
              rulePackIds: ["surface.browser", "app.gmail"],
              instructions: ["business-level action for the agent"],
              validation: ["observable self-check"],
              askUserBefore: ["approval or review checkpoint"],
              stopIf: ["blocking condition"],
            },
          ],
          finalValidation: ["string"],
          blockingReportFields: ["string"],
          assumptions: ["string"],
        },
        selectedRulePacks: input.selectedRulePacks.map((rulePack) => ({
          id: rulePack.id,
          level: rulePack.level,
          target: rulePack.target,
          name: rulePack.name,
          description: rulePack.description,
          generationGuidance: rulePack.generationGuidance,
          hardRequirements: rulePack.hardRequirements,
          runtimeReference: rulePack.runtimeReference,
        })),
        planning: input.planning,
        skill: input.skill,
      },
      null,
      2,
    ),
  };
}

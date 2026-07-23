import { z } from "zod";
import type {
  LlmInvocationSummary,
  OpenClawSkill,
} from "../types/contracts.js";

export const HARNESS_PLANNING_SCHEMA_VERSION =
  "oysterworkflow-harness-planning-v1";
export const HARNESS_EXECUTION_PROTOCOL_SCHEMA_VERSION =
  "oysterworkflow-harness-execution-protocol-v1";
export const HARNESS_INDEX_SCHEMA_VERSION = "oysterworkflow-harness-index-v1";
export const RULE_PACK_SCHEMA_VERSION = "oysterworkflow-rulepack-v1";

export const harnessModeSchema = z.enum(["autonomous", "collaborative"]);
export type HarnessMode = z.infer<typeof harnessModeSchema>;

export const rulePackLevelSchema = z.enum(["surface", "app"]);
export type RulePackLevel = z.infer<typeof rulePackLevelSchema>;

export const surfaceRulePackIdSchema = z.enum([
  "surface.browser",
  "surface.desktop_app",
  "surface.terminal",
]);
export type SurfaceRulePackId = z.infer<typeof surfaceRulePackIdSchema>;

export const rulePackReferenceSchema = z
  .object({
    title: z.string().min(1),
    path: z.string().min(1),
    packagePath: z.string().min(1).optional(),
    purpose: z.string().min(1),
    whenToRead: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const rulePackSchema = z
  .object({
    schemaVersion: z.literal(RULE_PACK_SCHEMA_VERSION),
    id: z.string().min(1),
    level: rulePackLevelSchema,
    target: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1).default("draft"),
    description: z.string().min(1),
    whenToApply: z.array(z.string().min(1)).default([]),
    whenNotToApply: z.array(z.string().min(1)).default([]),
    compatibleSurfaces: z.array(surfaceRulePackIdSchema).optional(),
    generationGuidance: z.array(z.string().min(1)).default([]),
    hardRequirements: z.array(z.string().min(1)).default([]),
    runtimeReference: rulePackReferenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.level === "surface") {
      const surfaceResult = surfaceRulePackIdSchema.safeParse(value.id);
      if (!surfaceResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "surface RulePack id must be one of surface.browser, surface.desktop_app, or surface.terminal.",
          path: ["id"],
        });
      }
      if (value.compatibleSurfaces && value.compatibleSurfaces.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "surface RulePack must not define compatibleSurfaces.",
          path: ["compatibleSurfaces"],
        });
      }
    }
    if (value.level === "app") {
      if (!value.id.startsWith("app.")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "app RulePack id must start with app.",
          path: ["id"],
        });
      }
      if (!value.compatibleSurfaces || value.compatibleSurfaces.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "app RulePack must define at least one compatible surface.",
          path: ["compatibleSurfaces"],
        });
      }
    }
  });
export type RulePack = z.infer<typeof rulePackSchema>;

export interface RulePackCatalogItem {
  id: string;
  level: RulePackLevel;
  target: string;
  name: string;
  description: string;
  whenToApply: string[];
  whenNotToApply: string[];
  compatibleSurfaces?: SurfaceRulePackId[];
}

export const harnessPlanningPhaseSchema = z
  .object({
    id: z.string().regex(/^phase-\d{2}$/u),
    title: z.string().min(1),
    objective: z.string().min(1),
    sourceSkillSteps: z.array(z.number().int().positive()).default([]),
    entryState: z.string().min(1),
    exitState: z.string().min(1),
    rulePackIds: z.array(z.string().min(1)).min(1).max(2),
    artifacts: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const harnessPlanningSchema = z
  .object({
    schemaVersion: z.literal(HARNESS_PLANNING_SCHEMA_VERSION),
    sourceSkillId: z.string().min(1),
    phases: z.array(harnessPlanningPhaseSchema).min(1).max(8),
    assumptions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HarnessPlanning = z.infer<typeof harnessPlanningSchema>;

export const executionProtocolPhaseSchema = z
  .object({
    id: z.string().regex(/^phase-\d{2}$/u),
    title: z.string().min(1),
    objective: z.string().min(1),
    rulePackIds: z.array(z.string().min(1)).min(1).max(2),
    instructions: z.array(z.string().min(1)).min(1),
    validation: z.array(z.string().min(1)).min(1),
    askUserBefore: z.array(z.string().min(1)).default([]),
    stopIf: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const executionProtocolSchema = z
  .object({
    schemaVersion: z.literal(HARNESS_EXECUTION_PROTOCOL_SCHEMA_VERSION),
    sourceSkillId: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    mode: harnessModeSchema,
    phases: z.array(executionProtocolPhaseSchema).min(1),
    finalValidation: z.array(z.string().min(1)).default([]),
    blockingReportFields: z.array(z.string().min(1)).default([]),
    assumptions: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ExecutionProtocol = z.infer<typeof executionProtocolSchema>;

export interface HarnessIndex {
  schemaVersion: typeof HARNESS_INDEX_SCHEMA_VERSION;
  generatedAt: string;
  name: string;
  description: string;
  mode: HarnessMode;
  sourceSkill: {
    skillId: string;
    skillName: string;
  };
  entrypoint: string;
  phases: Array<{
    id: string;
    title: string;
    file: string;
    rulePackIds: string[];
    ruleFiles: string[];
    artifacts?: string[];
  }>;
  selectedRulePacks: Array<{
    id: string;
    level: RulePackLevel;
    name: string;
    file: string;
  }>;
}

export interface HarnessGenerationSummary {
  schemaVersion: "oysterworkflow-harness-generation-summary-v1";
  generatedAt: string;
  sourceSkillId: string;
  mode: HarnessMode;
  output: {
    outDir: string;
    generationRecordDir: string;
    packageDir: string;
    skillPath: string;
    harnessJsonPath: string;
  };
  llm?: LlmInvocationSummary;
  warnings: string[];
}

export interface GenerateHarnessResult {
  sourceSkill: OpenClawSkill;
  planning: HarnessPlanning;
  executionProtocol: ExecutionProtocol;
  harnessIndex: HarnessIndex;
  summary: HarnessGenerationSummary;
}

import { z } from "zod";

export type UserSkillGranularity = "specific" | "general";
export type UserSkillPromptSet = string;

/**
 * EN: User-facing skill generation config.
 */
export interface UserSkillConfig {
  granularity: UserSkillGranularity;
  promptSet: UserSkillPromptSet;
  promptVersionTag?: string;
}

export const userSkillConfigSchema = z.object({
  granularity: z.enum(["specific", "general"]),
  promptSet: z.string().min(1),
  promptVersionTag: z.string().min(1).optional(),
});

export const DEFAULT_USER_SKILL_CONFIG: UserSkillConfig = {
  granularity: "specific",
  promptSet: "specific-v34",
  promptVersionTag: "specific-v34-2026-07-22-step-bound-references",
};

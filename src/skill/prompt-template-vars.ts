interface PromptTemplateVarsInput {
  promptSet: string;
  granularity: string;
  promptVersionTag?: string;
  providedSkillName?: string;
  generationGuidanceBlock?: string;
}

/**
 * EN: Builds common prompt template variables shared by extraction and post-processing stages.
 * @param input prompt metadata and optional user-provided fields.
 * @returns string-only template variable map.
 */
export function buildPromptTemplateVars(
  input: PromptTemplateVarsInput,
): Record<string, string> {
  const promptVersionTag = input.promptVersionTag || input.promptSet;
  const skillNameLine = input.providedSkillName
    ? "User-provided skillName: " + input.providedSkillName
    : "No skillName was provided. You may name the skill yourself.";
  return {
    promptSet: input.promptSet,
    granularity: input.granularity,
    promptVersionTag,
    skillNameLine,
    generationGuidanceBlock: input.generationGuidanceBlock ?? "",
  };
}

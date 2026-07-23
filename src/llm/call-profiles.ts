export const LLM_CALL_PROFILE_KEYS = [
  "workflow-discovery",
  "skill-extraction-step",
  "skill-extraction-terminal",
  "skill-extraction-finalize",
  "workflow-candidate-generation",
  "workflow-family-matching",
  "workflow-merge-proposal",
  "planner-optimization",
  "scenario-prediction",
  "scenario-generalization",
  "harness-planning",
  "harness-generation",
] as const;

export type LlmCallProfileKey = (typeof LLM_CALL_PROFILE_KEYS)[number];

/**
 * EN: Builds a strict record-shaped Zod schema fragment from the shared profile registry.
 * 中文: 从共享调用档案注册表构建严格的 record 形状。
 * @param createValue creates the schema/value assigned to each known profile key.
 * @returns object whose keys cannot drift from the execution registry.
 */
export function mapLlmCallProfileKeys<T>(
  createValue: (key: LlmCallProfileKey) => T,
): Record<LlmCallProfileKey, T> {
  return Object.fromEntries(
    LLM_CALL_PROFILE_KEYS.map((key) => [key, createValue(key)]),
  ) as Record<LlmCallProfileKey, T>;
}

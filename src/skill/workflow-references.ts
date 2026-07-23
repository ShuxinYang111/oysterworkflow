import type {
  OpenClawSkill,
  OpenClawSkillReference,
} from "../types/contracts.js";

/**
 * CN: 为一次 Skill 抽取中的 Reference 生成跨工作流合并仍唯一的 ID。
 * EN: Namespaces a skill Reference ID so it remains unique across workflow merges.
 * @param skillId source skill identity.
 * @param referenceId Call 2 reference identity inside that skill.
 * @returns workflow-safe reference identity.
 */
export function buildWorkflowReferenceId(
  skillId: string,
  referenceId: string,
): string {
  return `reference:${skillId}:${referenceId}`;
}

/**
 * CN: 将 Skill 顶层 Reference 目录复制为工作流级目录。
 * EN: Copies the skill reference catalog into workflow-scoped identities.
 * @param skill source Call 2 skill.
 * @returns namespaced workflow reference catalog.
 */
export function buildWorkflowReferenceCatalog(
  skill: OpenClawSkill,
): OpenClawSkillReference[] {
  return (skill.references ?? []).map((reference) => ({
    ...reference,
    id: buildWorkflowReferenceId(skill.skillId, reference.id),
  }));
}

/**
 * CN: 校验并转换 Step 或 Candidate 节点的 Reference 绑定。
 * EN: Validates and converts Step or Candidate node reference bindings.
 * @param skill source Call 2 skill and its reference catalog.
 * @param referenceRefs source-local reference IDs.
 * @returns namespaced workflow reference IDs.
 */
export function buildWorkflowReferenceRefs(
  skill: OpenClawSkill,
  referenceRefs: string[] | undefined,
): string[] {
  const knownIds = new Set(
    (skill.references ?? []).map((reference) => reference.id),
  );
  return [...new Set(referenceRefs ?? [])].map((referenceId) => {
    if (!knownIds.has(referenceId)) {
      throw new Error(
        `Skill ${skill.skillId} references unknown Reference: ${referenceId}`,
      );
    }
    return buildWorkflowReferenceId(skill.skillId, referenceId);
  });
}

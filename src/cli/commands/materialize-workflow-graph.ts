import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { materializeWorkflowGraphArtifacts } from "../../skill/workflow-graph.js";
import type { OpenClawSkill } from "../../types/contracts.js";

const materializeWorkflowGraphArgsSchema = z.object({
  skill: z.string().min(1),
  out: z.string().min(1).optional(),
});

export interface MaterializeWorkflowGraphCliOptions {
  skillPath: string;
  outDir: string;
}

/**
 * CN: 解析独立图物化命令参数，并强制使用绝对路径。
 * EN: Parses standalone graph materialization arguments and requires absolute paths.
 * @param input raw Commander arguments.
 * @returns normalized CLI options.
 */
export function parseMaterializeWorkflowGraphCliArgs(input: {
  skill: string;
  out?: string;
}): MaterializeWorkflowGraphCliOptions {
  const parsed = materializeWorkflowGraphArgsSchema.parse(input);
  if (!isAbsolute(parsed.skill)) {
    throw new Error("--skill must be an absolute path.");
  }
  if (parsed.out && !isAbsolute(parsed.out)) {
    throw new Error("--out must be an absolute path.");
  }
  const skillPath = resolve(parsed.skill);
  return {
    skillPath,
    outDir: parsed.out ? resolve(parsed.out) : dirname(skillPath),
  };
}

/**
 * CN: 从已有 skill.json 生成 workflow.json 与 WORKFLOW.md，无需重新调用 LLM。
 * EN: Generates workflow.json and WORKFLOW.md from an existing skill.json without an LLM call.
 * @param options normalized file paths.
 * @returns materialized workflow graph artifacts.
 */
export async function runMaterializeWorkflowGraph(
  options: MaterializeWorkflowGraphCliOptions,
) {
  const skill = parseSkillJson(
    await readFile(options.skillPath, "utf8"),
    options.skillPath,
  );
  return materializeWorkflowGraphArtifacts({
    skill,
    outDir: options.outDir,
    sourceSkillPath: options.skillPath,
  });
}

export function parseSkillJson(
  content: string,
  skillPath: string,
): OpenClawSkill {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid skill JSON at ${skillPath}: ${message}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Skill JSON must contain an object: ${skillPath}`);
  }
  const candidate = parsed as Partial<OpenClawSkill>;
  if (
    candidate.schemaVersion !== "openclaw-skill-v1" ||
    typeof candidate.skillId !== "string" ||
    typeof candidate.skillName !== "string" ||
    typeof candidate.goal !== "string" ||
    !candidate.source ||
    !Array.isArray(candidate.steps)
  ) {
    throw new Error(
      `Skill JSON does not match openclaw-skill-v1: ${skillPath}`,
    );
  }
  return candidate as OpenClawSkill;
}

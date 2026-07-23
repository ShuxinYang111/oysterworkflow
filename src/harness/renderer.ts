import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { OpenClawSkill } from "../types/contracts.js";
import {
  HARNESS_INDEX_SCHEMA_VERSION,
  type ExecutionProtocol,
  type HarnessIndex,
  type HarnessPlanning,
  type RulePack,
} from "./types.js";

export interface WriteHarnessPackageOptions {
  projectRoot: string;
  packageDir: string;
  skill: OpenClawSkill;
  planning: HarnessPlanning;
  protocol: ExecutionProtocol;
  selectedRulePacks: RulePack[];
  generatedAt: string;
}

export interface WriteHarnessPackageResult {
  harnessIndex: HarnessIndex;
  skillPath: string;
  harnessJsonPath: string;
  phaseFiles: string[];
  ruleFiles: string[];
}

/**
 * EN: Materializes the final harness package that an agent can read and execute.
 * @param options renderer input and output directories.
 * @returns output file paths and lightweight harness index.
 */
export async function writeHarnessPackage(
  options: WriteHarnessPackageOptions,
): Promise<WriteHarnessPackageResult> {
  const referencesDir = join(options.packageDir, "references");
  const phaseDir = join(referencesDir, "phases");
  const ruleDir = join(referencesDir, "rules");
  await mkdir(phaseDir, { recursive: true });
  await mkdir(ruleDir, { recursive: true });

  const ruleFiles = await materializeRuleFiles({
    projectRoot: options.projectRoot,
    ruleDir,
    rulePacks: options.selectedRulePacks,
  });
  const ruleFileById = new Map(
    ruleFiles.map((file) => [file.rulePackId, file.packagePath]),
  );

  const phaseFiles: string[] = [];
  const phaseIndex = [];
  for (const phase of options.protocol.phases) {
    const plannedPhase = options.planning.phases.find(
      (candidate) => candidate.id === phase.id,
    );
    const fileName = `${phase.id}.md`;
    const packagePath = `references/phases/${fileName}`;
    const absolutePath = join(phaseDir, fileName);
    const phaseRuleFiles = phase.rulePackIds
      .map((id) => ruleFileById.get(id))
      .filter((value): value is string => typeof value === "string");
    await writeFile(
      absolutePath,
      renderPhaseMarkdown({
        phase,
        plannedPhase,
        ruleFiles: phaseRuleFiles,
      }),
      "utf8",
    );
    phaseFiles.push(absolutePath);
    phaseIndex.push({
      id: phase.id,
      title: phase.title,
      file: packagePath,
      rulePackIds: phase.rulePackIds,
      ruleFiles: phaseRuleFiles,
      ...(plannedPhase?.artifacts ? { artifacts: plannedPhase.artifacts } : {}),
    });
  }

  const selectedRulePacks = options.selectedRulePacks.map((rulePack) => ({
    id: rulePack.id,
    level: rulePack.level,
    name: rulePack.name,
    file: ruleFileById.get(rulePack.id) ?? "",
  }));
  const harnessIndex: HarnessIndex = {
    schemaVersion: HARNESS_INDEX_SCHEMA_VERSION,
    generatedAt: options.generatedAt,
    name: options.protocol.title,
    description: options.protocol.description,
    mode: options.protocol.mode,
    sourceSkill: {
      skillId: options.skill.skillId,
      skillName: options.skill.skillName,
    },
    entrypoint: "SKILL.md",
    phases: phaseIndex,
    selectedRulePacks,
  };

  const skillPath = join(options.packageDir, "SKILL.md");
  await writeFile(
    skillPath,
    renderSkillMarkdown({
      skill: options.skill,
      protocol: options.protocol,
      harnessIndex,
    }),
    "utf8",
  );
  const harnessJsonPath = join(options.packageDir, "harness.json");
  await writeFile(
    harnessJsonPath,
    `${JSON.stringify(harnessIndex, null, 2)}\n`,
    "utf8",
  );

  return {
    harnessIndex,
    skillPath,
    harnessJsonPath,
    phaseFiles,
    ruleFiles: ruleFiles.map((file) => file.absolutePath),
  };
}

export function renderSkillMarkdown(input: {
  skill: OpenClawSkill;
  protocol: ExecutionProtocol;
  harnessIndex: HarnessIndex;
}): string {
  const name = slugifySkillName(input.protocol.title || input.skill.skillName);
  return [
    "---",
    `name: ${name}`,
    `description: ${yamlSingleLine(input.protocol.description)}`,
    "---",
    "",
    `# ${input.protocol.title}`,
    "",
    input.protocol.description,
    "",
    "## Operating Mode",
    "",
    `- ${input.protocol.mode}`,
    "",
    "## File Reading Order",
    "",
    "- Start with this `SKILL.md` file.",
    "- Before executing a phase, read that phase file under `references/phases/`.",
    "- When a phase file lists rule references, read those rule files before acting in that phase.",
    "",
    "## Workflow",
    "",
    ...input.harnessIndex.phases.flatMap((phase) => [
      `- ${phase.id}: ${phase.title}`,
      `  - Read: \`${phase.file}\``,
    ]),
    "",
    "## Final Validation",
    "",
    ...listItems(input.protocol.finalValidation),
    "",
    "## Blocking Report",
    "",
    ...listItems(input.protocol.blockingReportFields),
    "",
  ].join("\n");
}

export function renderPhaseMarkdown(input: {
  phase: ExecutionProtocol["phases"][number];
  plannedPhase: HarnessPlanning["phases"][number] | undefined;
  ruleFiles: string[];
}): string {
  return [
    `# ${input.phase.id}: ${input.phase.title}`,
    "",
    "## Read First",
    "",
    ...listItems(input.ruleFiles.map((file) => `\`${file}\``)),
    "",
    "## Start When",
    "",
    input.plannedPhase?.entryState ?? "The previous phase has completed.",
    "",
    "## Objective",
    "",
    input.phase.objective,
    "",
    "## Do",
    "",
    ...listItems(input.phase.instructions),
    "",
    "## Validation",
    "",
    ...listItems(input.phase.validation),
    "",
    "## Ask User Before",
    "",
    ...listItems(input.phase.askUserBefore),
    "",
    "## Stop If",
    "",
    ...listItems(input.phase.stopIf),
    "",
    "## Exit State",
    "",
    input.plannedPhase?.exitState ??
      "The phase objective is complete and validated.",
    "",
  ].join("\n");
}

async function materializeRuleFiles(input: {
  projectRoot: string;
  ruleDir: string;
  rulePacks: RulePack[];
}): Promise<
  Array<{ rulePackId: string; absolutePath: string; packagePath: string }>
> {
  const files = [];
  for (const rulePack of input.rulePacks) {
    const fileName =
      rulePack.runtimeReference.packagePath ??
      `${rulePack.id.replace(/[._]/gu, "-")}.md`;
    const absolutePath = join(input.ruleDir, basename(fileName));
    await copyFile(
      resolve(input.projectRoot, rulePack.runtimeReference.path),
      absolutePath,
    );
    files.push({
      rulePackId: rulePack.id,
      absolutePath,
      packagePath: `references/rules/${basename(fileName)}`,
    });
  }
  return files;
}

function listItems(items: string[] | undefined): string[] {
  return Array.isArray(items) && items.length > 0
    ? items.map((item) => `- ${item}`)
    : ["- (none)"];
}

function slugifySkillName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug || "generated-harness";
}

function yamlSingleLine(value: string): string {
  return JSON.stringify(value.replace(/\s+/gu, " ").trim());
}

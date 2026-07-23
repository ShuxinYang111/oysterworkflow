import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ProductInstalledWorkflow, ProductWorker } from "./contracts.js";

const HERMES_SKILLS_ROOT_ENV_NAME = "OYSTERWORKFLOW_HERMES_SKILLS_ROOT";

/**
 * EN: Builds the managed Hermes skill directory name for one workflow title.
 * @param workflowTitle human-readable workflow title.
 * @returns stable Hermes skill name.
 */
export function defaultHermesSkillName(workflowTitle: string): string {
  return `oysterworkflow-${slugify(workflowTitle)}`;
}

/**
 * EN: Builds the Hermes install reference for one installed workflow.
 * @param workflow installed workflow metadata.
 * @param workersById workers indexed by id.
 * @returns Hermes install reference.
 */
export function defaultHermesInstallReference(
  workflow: ProductInstalledWorkflow,
  workersById: Map<string, ProductWorker>,
): string {
  const worker = workersById.get(workflow.workerId);
  const workerReference =
    worker?.config.hermesAgentReference ?? `hermes-agent:${workflow.workerId}`;
  return `hermes-install:${workerReference}:${defaultHermesSkillName(
    workflow.workflowTitle,
  )}`;
}

/**
 * EN: Resolves the default managed Hermes SKILL.md path.
 * @param workflowTitle human-readable workflow title.
 * @returns absolute SKILL.md path.
 */
export function defaultHermesSkillPath(workflowTitle: string): string {
  return resolve(
    process.env[HERMES_SKILLS_ROOT_ENV_NAME] ??
      resolve(homedir(), ".hermes", "skills"),
    defaultHermesSkillName(workflowTitle),
    "SKILL.md",
  );
}

/**
 * EN: Builds the managed Hermes profile reference for one worker.
 * @param workerId product worker id.
 * @param workerName product worker name.
 * @returns Hermes profile reference.
 */
export function managedHermesProfileReference(
  workerId: string,
  workerName: string,
): string {
  return `hermes-profile:${managedHermesProfileName(workerId, workerName)}`;
}

/**
 * EN: Builds the managed Hermes profile name for one worker.
 * @param workerId product worker id.
 * @param workerName product worker name.
 * @returns Hermes profile name.
 */
export function managedHermesProfileName(
  workerId: string,
  workerName: string,
): string {
  const seed = slugify(`${workerId}-${workerName}`) || "worker";
  return `ow-${seed}`.slice(0, 63).replace(/-$/u, "");
}

/**
 * EN: Converts user-facing text into a stable lowercase slug.
 * @param value text to slugify.
 * @returns slug.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 72);
}

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type RulePack,
  type RulePackCatalogItem,
  rulePackSchema,
} from "./types.js";

export interface LoadRulePackCatalogOptions {
  projectRoot: string;
  catalogDir?: string;
}

/**
 * EN: Loads built-in harness RulePacks and validates their surface/app contract.
 * @param options project root and optional custom catalog directory.
 * @returns validated RulePacks sorted by id.
 */
export async function loadRulePackCatalog(
  options: LoadRulePackCatalogOptions,
): Promise<RulePack[]> {
  const catalogDir = resolve(
    options.catalogDir ??
      join(options.projectRoot, "config", "harness", "rulepacks"),
  );
  const entries = (await readdir(catalogDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort();
  const rulePacks: RulePack[] = [];
  for (const entry of entries) {
    const filePath = join(catalogDir, entry);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    rulePacks.push(rulePackSchema.parse(parsed));
  }
  validateRulePackCatalog(rulePacks);
  return rulePacks.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * EN: Converts full RulePacks to compact metadata for the planning LLM call.
 * @param rulePacks validated RulePacks.
 * @returns metadata-only catalog without runtime expert document bodies.
 */
export function toRulePackCatalogItems(
  rulePacks: RulePack[],
): RulePackCatalogItem[] {
  return rulePacks.map((rulePack) => ({
    id: rulePack.id,
    level: rulePack.level,
    target: rulePack.target,
    name: rulePack.name,
    description: rulePack.description,
    whenToApply: rulePack.whenToApply,
    whenNotToApply: rulePack.whenNotToApply,
    ...(rulePack.compatibleSurfaces
      ? { compatibleSurfaces: rulePack.compatibleSurfaces }
      : {}),
  }));
}

/**
 * EN: Ensures app RulePacks only reference surfaces present in the same catalog.
 * @param rulePacks validated RulePacks.
 */
export function validateRulePackCatalog(rulePacks: RulePack[]): void {
  const seenIds = new Set<string>();
  const surfaceIds = new Set(
    rulePacks
      .filter((rulePack) => rulePack.level === "surface")
      .map((rulePack) => rulePack.id),
  );

  for (const rulePack of rulePacks) {
    if (seenIds.has(rulePack.id)) {
      throw new Error(`Duplicate RulePack id: ${rulePack.id}`);
    }
    seenIds.add(rulePack.id);

    if (rulePack.level === "app") {
      for (const surfaceId of rulePack.compatibleSurfaces ?? []) {
        if (!surfaceIds.has(surfaceId)) {
          throw new Error(
            `${rulePack.id} references missing compatible surface ${surfaceId}.`,
          );
        }
      }
    }
  }
}

export function indexRulePacks(rulePacks: RulePack[]): Map<string, RulePack> {
  return new Map(rulePacks.map((rulePack) => [rulePack.id, rulePack]));
}

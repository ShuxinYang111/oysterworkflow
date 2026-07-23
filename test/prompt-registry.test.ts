import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPromptSet,
  renderPromptTemplate,
} from "../src/skill/prompt-registry.js";

describe("prompt-registry", () => {
  it("inherits the tested extraction prompt while adding Call 5", async () => {
    const previous = await loadPromptSet("specific-v28");
    const promptSet = await loadPromptSet("specific-v29");

    expect(promptSet.promptSet).toBe("specific-v29");
    expect(promptSet.skillExtraction).toEqual(previous.skillExtraction);
    expect(promptSet.workflowDiscovery).toEqual(previous.workflowDiscovery);
    expect(promptSet.workflowMergeProposal?.system.join("\n")).toContain(
      "complete merged canonical graph",
    );
    expect(promptSet.workflowCandidateGeneration?.system.join("\n")).toContain(
      "outcome must be completed, stopped, rejected, or failed",
    );
  });

  it("inherits Call 5 while tightening the Call 3 array contract in v30", async () => {
    const previous = await loadPromptSet("specific-v29");
    const promptSet = await loadPromptSet("specific-v30");

    expect(promptSet.workflowMergeProposal).toEqual(
      previous.workflowMergeProposal,
    );
    expect(promptSet.skillExtraction).toEqual(previous.skillExtraction);
    expect(promptSet.workflowCandidateGeneration?.system.join("\n")).toContain(
      "act must be a JSON array",
    );
  });

  it("inherits the Call 3 contract while tightening Decision identity in v31", async () => {
    const previous = await loadPromptSet("specific-v30");
    const promptSet = await loadPromptSet("specific-v31");

    expect(promptSet.workflowCandidateGeneration).toEqual(
      previous.workflowCandidateGeneration,
    );
    expect(promptSet.workflowMergeProposal?.system.join("\n")).toContain(
      "Decision identity is semantic, not lexical",
    );
    expect(promptSet.workflowMergeProposal?.system.join("\n")).toContain(
      "Do not invent an inverse Candidate route",
    );
  });

  it("inherits Call 5 while tightening semantic node granularity in v32", async () => {
    const previous = await loadPromptSet("specific-v31");
    const promptSet = await loadPromptSet("specific-v32");

    expect(promptSet.workflowMergeProposal).toEqual(
      previous.workflowMergeProposal,
    );
    expect(promptSet.skillExtraction).toEqual(previous.skillExtraction);
    const candidatePrompt =
      promptSet.workflowCandidateGeneration?.system.join("\n") ?? "";
    expect(candidatePrompt).toContain("apply this necessity test");
    expect(candidatePrompt).toContain(
      "A graph node may combine multiple skill steps",
    );
    expect(candidatePrompt).toContain(
      "Do not create separate nodes merely because the source skill changes app or page",
    );
    expect(candidatePrompt).toContain("reusable work product");
  });

  it("inherits Call 3 while declaring the exact Call 5 transition contract in v33", async () => {
    const previous = await loadPromptSet("specific-v32");
    const promptSet = await loadPromptSet("specific-v33");

    expect(promptSet.workflowCandidateGeneration).toEqual(
      previous.workflowCandidateGeneration,
    );
    expect(promptSet.skillExtraction).toEqual(previous.skillExtraction);
    const mergePrompt =
      promptSet.workflowMergeProposal?.system.join("\n") ?? "";
    expect(mergePrompt).toContain("conditional has exactly");
    expect(mergePrompt).toContain("Always use when for route conditions");
    expect(mergePrompt).toContain("never output a condition field");
  });

  it("loads prompt set and validates name", async () => {
    const promptSet = await loadPromptSet("specific-v28");
    expect(promptSet.promptSet).toBe("specific-v28");
    expect(promptSet.schemaVersion).toBe("oysterworkflow-promptset-v1");
    expect(promptSet.filePath).toContain(
      path.join("config", "promptsets", "specific-v28.json"),
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-step",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-terminal",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "coveredThroughEventId",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "shortDescription",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "the last event seen and consumed in this round",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "required fields name and value",
    );
    expect(promptSet.workflowDiscovery.userPreamble.join("\n")).toContain(
      "Raw activity log:",
    );
    expect(promptSet.workflowDiscovery.userPreamble.join("\n")).toContain(
      "{{generationGuidanceBlock}}",
    );
    expect(promptSet.skillExtraction.userPreamble.join("\n")).toContain(
      "The current mode will be provided later in the input.",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "user generation guidance",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "reusable, callable agent skill",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "evidence-driven exception fields",
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "System and runtime diagnostics",
    );
    expect(promptSet.workflowCandidateGeneration?.system.join("\n")).toContain(
      "Do not output confidence, score, reason",
    );
    expect(promptSet.workflowFamilyMatching?.system.join("\n")).toContain(
      "exactly two fields",
    );
    expect(promptSet.scenarioPrediction?.system.join("\n")).toContain(
      "similar or identical workflow",
    );
    expect(promptSet.plannerOptimization?.system.join("\n")).toContain(
      "Instructions for whenToUse:",
    );
    expect(promptSet.plannerOptimization?.system.join("\n")).toContain(
      "mostly positive match conditions",
    );
    expect(promptSet.plannerOptimization?.system.join("\n")).toContain(
      "each target agent's planner",
    );
    expect(promptSet.scenarioPrediction?.userPreamble).toEqual([
      "{{generationGuidanceBlock}}",
    ]);
    expect(promptSet.scenarioGeneralization?.userPreamble).toEqual([
      "{{generationGuidanceBlock}}",
    ]);
    expect(promptSet.scenarioGeneralization?.system.join("\n")).toContain(
      "By default, assume the skill should execute from scratch.",
    );
    expect(promptSet.scenarioGeneralization?.system.join("\n")).toContain(
      "Element Category",
    );
    expect(promptSet.scenarioGeneralization?.system.join("\n")).toContain(
      "must be preserved exactly from the source skill",
    );
  });

  it("loads specific-v14 without promptSet mismatch", async () => {
    const promptSet = await loadPromptSet("specific-v14");
    expect(promptSet.promptSet).toBe("specific-v14");
    expect(promptSet.filePath).toContain(
      path.join("config", "promptsets", "specific-v14.json"),
    );
    expect(promptSet.skillExtraction.system.join("\n")).toContain(
      "skill-extraction-finalize",
    );
  });

  it("rejects mismatched promptSet name", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-promptset-"),
    );
    const filePath = path.join(root, "wrong.json");
    const payload = {
      schemaVersion: "oysterworkflow-promptset-v1",
      promptSet: "other",
      workflowDiscovery: { system: ["sys"], userPreamble: ["user"] },
      skillExtraction: { system: ["sys"], userPreamble: ["user"] },
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    await expect(loadPromptSet("wrong", root)).rejects.toThrow(
      /Prompt set mismatch/,
    );
  });

  it("renders templates and detects unresolved placeholders", () => {
    const rendered = renderPromptTemplate(["hello {{name}}"], {
      name: "world",
    });
    expect(rendered).toBe("hello world");
    expect(() => renderPromptTemplate(["{{missing}}"], {})).toThrow(
      /Unresolved prompt placeholders/,
    );
  });
});

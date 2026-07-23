import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseMaterializeWorkflowGraphCliArgs,
  runMaterializeWorkflowGraph,
} from "../src/cli/commands/materialize-workflow-graph.js";
import {
  parsePersistWorkflowGraphCliArgs,
  parseRenderWorkflowGraphCliArgs,
  parseValidateWorkflowGraphCliArgs,
  runPersistWorkflowGraph,
  runRenderWorkflowGraph,
  runValidateWorkflowGraph,
} from "../src/cli/commands/manage-workflow-graph.js";
import {
  buildWorkflowGraphFromSkill,
  listWorkflowGraphRevisions,
  loadWorkflowGraph,
  materializeWorkflowGraphArtifacts,
  persistWorkflowGraphDraft,
  renderWorkflowGraphMarkdown,
  renderWorkflowGraphProjection,
  restoreWorkflowGraphRevision,
  toWorkflowGraphDraft,
  validateWorkflowGraph,
} from "../src/skill/workflow-graph.js";
import { appendWorkflowGraphSkillGuide } from "../src/skill/workflow-graph-package.js";
import type {
  OpenClawSkill,
  OysterWorkflowGraph,
  WorkflowGraphTransition,
} from "../src/types/contracts.js";

describe("workflow graph", () => {
  it("mechanically migrates linear steps without inventing branches", () => {
    const skill = buildSkill();
    const graph = buildWorkflowGraphFromSkill(skill, {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    expect(graph.schemaVersion).toBe("oyster-workflow-graph-v2");
    expect(graph.entryNodeId).toBe("step-001");
    expect(graph.source.runDir).toBe("/tmp/run-001");
    expect(graph.nodes.map((node) => [node.id, node.type])).toEqual([
      ["step-001", "action"],
      ["step-002", "action"],
      ["terminal-completed", "terminal"],
    ]);
    expect(graph.transitions).toEqual([
      expect.objectContaining({
        from: "step-001",
        to: "step-002",
        type: "default",
      }),
      expect.objectContaining({
        from: "step-002",
        to: "terminal-completed",
        type: "default",
      }),
    ]);
    expect(graph.transitions.every((edge) => edge.type === "default")).toBe(
      true,
    );
    expect(graph.nodes[0]).toEqual(
      expect.objectContaining({
        type: "action",
        objective: "Assess whether the opportunity is credible.",
        act: ["Review the sender and request."],
        operationApp: "Mail",
      }),
    );
    expect(graph.nodes[0].sourceRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "skill-step",
          ref: "skill:email-triage#step-1",
        }),
        expect.objectContaining({
          kind: "episode",
          ref: "episode:run-001:episode-001",
        }),
      ]),
    );
  });

  it("carries step-bound References into only the corresponding graph node", () => {
    const base = buildSkill();
    const skill: OpenClawSkill = {
      ...base,
      references: [
        {
          id: "sender-profile",
          name: "Observed sender profile",
          value: "Public mailbox with no company website.",
        },
      ],
      steps: base.steps.map((step) =>
        step.step === 1 ? { ...step, referenceRefs: ["sender-profile"] } : step,
      ),
    };

    const graph = buildWorkflowGraphFromSkill(skill);

    expect(graph.references).toEqual([
      expect.objectContaining({
        id: "reference:email-triage:sender-profile",
      }),
    ]);
    expect(graph.nodes[0]?.referenceRefs).toEqual([
      "reference:email-triage:sender-profile",
    ]);
    expect(graph.nodes[1]?.referenceRefs).toBeUndefined();
    expect(renderWorkflowGraphMarkdown(graph)).toContain(
      "**Observed sender profile**",
    );
  });

  it("rejects dangling node Reference bindings", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill());
    graph.nodes[0] = {
      ...graph.nodes[0],
      referenceRefs: ["reference:missing"],
    };

    expect(() => validateWorkflowGraph(graph)).toThrow("unknown Reference");
  });

  it("reads legacy v1 graphs and upgrades a mechanical graph on the next materialization", async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-v1-compat-"),
    );
    const current = buildWorkflowGraphFromSkill(buildSkill(), {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const { revision: _revision, ...currentDraft } = current;
    const legacyDraft = {
      ...currentDraft,
      schemaVersion: "oyster-workflow-graph-v1",
      nodes: currentDraft.nodes.map((node) => {
        if (node.type === "action") {
          return { ...node, observe: [], verify: [] };
        }
        if (node.type === "decision") {
          return { ...node, observe: [] };
        }
        return node;
      }),
    };
    const legacy = await persistWorkflowGraphDraft({
      draft: legacyDraft,
      outDir,
      now: new Date("2026-07-12T12:01:00.000Z"),
    });

    expect(legacy.graph.schemaVersion).toBe("oyster-workflow-graph-v1");
    expect((await loadWorkflowGraph(legacy.graphPath)).schemaVersion).toBe(
      "oyster-workflow-graph-v1",
    );

    const upgraded = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
      now: new Date("2026-07-12T12:02:00.000Z"),
    });
    expect(upgraded.graph.schemaVersion).toBe("oyster-workflow-graph-v2");
    expect(upgraded.graph.revision.number).toBe(2);
    expect(upgraded.graph.revision.previousRevisionId).toBe(
      legacy.graph.revision.revisionId,
    );
  });

  it("preserves a revision for identical content and links changed content", () => {
    const skill = buildSkill();
    const first = buildWorkflowGraphFromSkill(skill, {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const unchanged = buildWorkflowGraphFromSkill(skill, {
      existingGraph: first,
      now: new Date("2026-07-12T12:10:00.000Z"),
    });
    const changed = buildWorkflowGraphFromSkill(
      {
        ...skill,
        steps: skill.steps.map((step) =>
          step.step === 2
            ? { ...step, instruction: "Send the approved reply." }
            : step,
        ),
      },
      {
        existingGraph: unchanged,
        now: new Date("2026-07-12T12:20:00.000Z"),
      },
    );

    expect(unchanged.revision).toEqual(first.revision);
    expect(changed.revision.number).toBe(2);
    expect(changed.revision.previousRevisionId).toBe(first.revision.revisionId);
    expect(changed.revision.contentHash).not.toBe(first.revision.contentHash);
  });

  it("keeps immutable revision snapshots when the graph changes", async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-revisions-"),
    );
    const first = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const changedSkill = buildSkill();
    changedSkill.steps[1].instruction = "Send the approved reply.";
    const second = await materializeWorkflowGraphArtifacts({
      skill: changedSkill,
      outDir,
      now: new Date("2026-07-12T12:10:00.000Z"),
    });

    expect(second.graph.revision.number).toBe(2);
    expect(second.graph.revision.previousRevisionId).toBe(
      first.graph.revision.revisionId,
    );
    expect(second.revisionPath).not.toBe(first.revisionPath);
    await Promise.all([
      access(first.revisionPath),
      access(second.revisionPath),
    ]);
  });

  it("keeps an enriched canonical graph from being overwritten by skill compatibility output", async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-canonical-"),
    );
    const first = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const { revision: _revision, ...draft } = first.graph;
    const firstAction = draft.nodes[0];
    if (firstAction.type !== "action") {
      throw new Error("Expected the first migrated node to be an action.");
    }
    draft.nodes[0] = {
      ...firstAction,
      hints: [
        ...firstAction.hints,
        "A public mailbox alone is not sufficient to reject a request.",
      ],
      sourceRefs: [
        ...firstAction.sourceRefs,
        {
          kind: "episode",
          ref: "episode:run-002:episode-002",
          label: "episode-002",
        },
      ],
    };
    const enriched = await persistWorkflowGraphDraft({
      draft,
      outDir,
      now: new Date("2026-07-12T12:10:00.000Z"),
    });

    const preserved = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
      now: new Date("2026-07-12T12:20:00.000Z"),
    });
    expect(preserved.graph).toEqual(enriched.graph);
    expect(preserved.graph.revision.number).toBe(2);

    const changedSkill = buildSkill();
    changedSkill.steps[0].instruction = "Replace the canonical action.";
    await expect(
      materializeWorkflowGraphArtifacts({ skill: changedSkill, outDir }),
    ).rejects.toThrow("protected from compatibility overwrite");
    expect((await loadWorkflowGraph(enriched.graphPath)).revision.number).toBe(
      2,
    );
  });

  it("rebuilds Markdown directly from canonical JSON and detects content tampering", async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-render-"),
    );
    const result = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
    });
    await writeFile(result.markdownPath, "stale projection\n", "utf8");
    const rendered = await renderWorkflowGraphProjection({
      graphPath: result.graphPath,
    });
    expect(await readFile(rendered.markdownPath, "utf8")).toContain(
      "```mermaid",
    );

    const tampered = JSON.parse(
      await readFile(result.graphPath, "utf8"),
    ) as OysterWorkflowGraph;
    tampered.goal = "Tampered without a new revision";
    await writeFile(
      result.graphPath,
      `${JSON.stringify(tampered, null, 2)}\n`,
      "utf8",
    );
    await expect(loadWorkflowGraph(result.graphPath)).rejects.toThrow(
      "content hash mismatch",
    );
  });

  it("accepts cycles with a bounded retry or explicit exit and rejects closed cycles", () => {
    const base = buildWorkflowGraphFromSkill(buildSkill());
    const boundedRetry = structuredClone(base);
    boundedRetry.transitions = [
      defaultTransition("step-001", "step-002"),
      {
        id: "transition-success",
        from: "step-002",
        to: "terminal-completed",
        type: "conditional",
        when: "The result is valid",
        sourceRefs: [],
      },
      {
        id: "transition-retry",
        from: "step-002",
        to: "step-001",
        type: "retry",
        when: "Validation failed",
        maxAttempts: 3,
        sourceRefs: [],
      },
    ];
    expect(() => validateWorkflowGraph(boundedRetry)).not.toThrow();

    const conditionalExitCycle = structuredClone(boundedRetry);
    conditionalExitCycle.transitions[2] = {
      id: "transition-loop",
      from: "step-002",
      to: "step-001",
      type: "conditional",
      when: "Try again",
      sourceRefs: [],
    };
    expect(() => validateWorkflowGraph(conditionalExitCycle)).not.toThrow();

    const closedCycle = structuredClone(base);
    closedCycle.transitions = [
      {
        id: "enter-cycle",
        from: "step-001",
        to: "step-002",
        type: "conditional",
        when: "Further work is required",
        sourceRefs: [],
      },
      {
        id: "finish-without-cycle",
        from: "step-001",
        to: "terminal-completed",
        type: "conditional",
        when: "No further work is required",
        sourceRefs: [],
      },
      {
        id: "closed-loop",
        from: "step-002",
        to: "step-002",
        type: "conditional",
        when: "Continue indefinitely",
        sourceRefs: [],
      },
    ];
    expect(() => validateWorkflowGraph(closedCycle)).toThrow(
      "cycle must have an exit route or bounded retry transition",
    );

    const dangling = structuredClone(base);
    dangling.transitions[0].to = "missing-node";
    expect(() => validateWorkflowGraph(dangling)).toThrow(
      "references missing target node",
    );

    const terminalOutgoing = structuredClone(base);
    terminalOutgoing.transitions.push(
      defaultTransition("terminal-completed", "step-001"),
    );
    expect(() => validateWorkflowGraph(terminalOutgoing)).toThrow(
      "terminal node must not have outgoing transitions",
    );
  });

  it("accepts partial decisions and open waits while preserving typed routes", () => {
    const decisionGraph = structuredClone(
      buildWorkflowGraphFromSkill(buildSkill()),
    );
    decisionGraph.nodes[0] = {
      id: "step-001",
      type: "decision",
      title: "Check legitimacy",
      decision: "Is this request legitimate?",
      hints: [],
      sourceRefs: [],
    };
    decisionGraph.transitions = [
      {
        id: "route-valid",
        from: "step-001",
        to: "step-002",
        type: "conditional",
        when: "The request is legitimate",
        sourceRefs: [],
      },
      defaultTransition("step-002", "terminal-completed"),
    ];
    expect(() => validateWorkflowGraph(decisionGraph)).not.toThrow();

    decisionGraph.transitions = [
      ...decisionGraph.transitions,
      {
        id: "route-reject",
        from: "step-001",
        to: "terminal-completed",
        type: "conditional",
        when: "The request is fraudulent",
        sourceRefs: [],
      },
    ];
    expect(() => validateWorkflowGraph(decisionGraph)).not.toThrow();

    const waitGraph = structuredClone(
      buildWorkflowGraphFromSkill(buildSkill()),
    );
    const openWait = {
      id: "step-001",
      type: "wait" as const,
      title: "Wait for engineering assessment",
      waitFor: "Engineering response",
      resumeCondition: "An assessment is available",
      hints: [],
      sourceRefs: [],
    };
    waitGraph.nodes = [openWait];
    waitGraph.entryNodeId = openWait.id;
    waitGraph.transitions = [];
    expect(() => validateWorkflowGraph(waitGraph)).not.toThrow();

    waitGraph.nodes = [
      openWait,
      {
        id: "terminal-completed",
        type: "terminal",
        title: "Assessment received",
        outcome: "completed",
        summary: "Engineering assessment is available.",
        hints: [],
        sourceRefs: [],
      },
    ];
    waitGraph.transitions = [
      defaultTransition("step-001", "terminal-completed"),
    ];
    expect(() => validateWorkflowGraph(waitGraph)).toThrow(
      "wait node with known continuation requires a resume transition",
    );
    waitGraph.transitions = [
      {
        id: "resume-engineering",
        from: "step-001",
        to: "terminal-completed",
        type: "resume",
        when: "Engineering has responded",
        sourceRefs: [],
      },
    ];
    expect(() => validateWorkflowGraph(waitGraph)).not.toThrow();
  });

  it("retains structural safety constraints that do not assume future routes", () => {
    const base = buildWorkflowGraphFromSkill(buildSkill());
    const invalidResume = structuredClone(base);
    invalidResume.transitions[0] = {
      id: "invalid-resume",
      from: "step-001",
      to: "step-002",
      type: "resume",
      when: "Continue",
      sourceRefs: [],
    };
    expect(() => validateWorkflowGraph(invalidResume)).toThrow(
      "must start from a wait node",
    );

    const ambiguousDefault = structuredClone(base);
    ambiguousDefault.transitions.push(
      defaultTransition("step-001", "terminal-completed"),
    );
    expect(() => validateWorkflowGraph(ambiguousDefault)).toThrow(
      "more than one default transition",
    );
  });

  it("refreshes an existing Agent graph guide without removing later sections", () => {
    const first = buildWorkflowGraphFromSkill(buildSkill(), {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const changedSkill = buildSkill();
    changedSkill.steps[1].instruction = "Send the approved reply.";
    const changed = buildWorkflowGraphFromSkill(changedSkill, {
      existingGraph: first,
      now: new Date("2026-07-12T12:10:00.000Z"),
    });
    const initialMarkdown = [
      "# Example skill",
      "",
      appendWorkflowGraphSkillGuide("", first).trim(),
      "",
      "## Human Notes",
      "",
      "Keep this section.",
    ].join("\n");
    const refreshed = appendWorkflowGraphSkillGuide(initialMarkdown, changed);

    expect(refreshed).toContain(
      `- Revision: \`${changed.revision.revisionId}\``,
    );
    expect(refreshed).not.toContain(
      `- Revision: \`${first.revision.revisionId}\``,
    );
    expect(refreshed).toContain("## Human Notes\n\nKeep this section.");
    expect(refreshed.match(/^## Canonical Execution Graph$/gmu)).toHaveLength(
      1,
    );
  });

  it("removes linear Steps when an Agent package has a canonical graph", () => {
    const graph = buildWorkflowGraphFromSkill(buildSkill(), {
      now: new Date("2026-07-12T12:00:00.000Z"),
    });
    const markdown = [
      "# Example skill",
      "",
      "## Steps",
      "",
      "1. This legacy sequence must not reach the Agent.",
      "",
      "## Success Criteria",
      "",
      "- The workflow completes.",
    ].join("\n");

    const rendered = appendWorkflowGraphSkillGuide(markdown, graph);

    expect(rendered).not.toContain("## Steps");
    expect(rendered).not.toContain("This legacy sequence");
    expect(rendered).toContain(
      "## Success Criteria\n\n- The workflow completes.",
    );
    expect(rendered).toContain("## Canonical Execution Graph");
  });

  it("writes canonical JSON and an Obsidian-compatible review projection", async () => {
    const outDir = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-"),
    );
    const result = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir,
      sourceSkillPath: path.join(outDir, "skill.json"),
      now: new Date("2026-07-12T12:00:00.000Z"),
    });

    await Promise.all([
      access(result.graphPath),
      access(result.markdownPath),
      access(result.revisionPath),
    ]);
    const persisted = JSON.parse(
      await readFile(result.graphPath, "utf8"),
    ) as OysterWorkflowGraph;
    const markdown = await readFile(result.markdownPath, "utf8");
    expect(persisted.workflowId).toBe("workflow.email-triage");
    expect(markdown).toContain(
      "`workflow.json` is the canonical executable graph",
    );
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("### step-001");
    expect(markdown).toContain("](#step-002)");
    expect(markdown).toContain("episode:run-001:episode-001");
    expect(
      renderWorkflowGraphMarkdown(
        persisted,
        path.join(outDir, "skill.json"),
        outDir,
      ),
    ).toBe(markdown);
  });

  it("materializes an existing skill through the standalone CLI service", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-command-"),
    );
    const skillPath = path.join(root, "skill.json");
    const outDir = path.join(root, "graph");
    await writeFile(
      skillPath,
      `${JSON.stringify(buildSkill(), null, 2)}\n`,
      "utf8",
    );

    const options = parseMaterializeWorkflowGraphCliArgs({
      skill: skillPath,
      out: outDir,
    });
    const result = await runMaterializeWorkflowGraph(options);

    expect(options).toEqual({ skillPath, outDir });
    expect(result.graph.revision.number).toBe(1);
    await Promise.all([
      access(result.graphPath),
      access(result.markdownPath),
      access(result.revisionPath),
    ]);
    expect(await readFile(result.markdownPath, "utf8")).toContain(
      "[skill.json](../skill.json)",
    );
    expect(() =>
      parseMaterializeWorkflowGraphCliArgs({ skill: "relative-skill.json" }),
    ).toThrow("--skill must be an absolute path");
  });

  it("validates, persists, and renders canonical graph artifacts through standalone services", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "oysterworkflow-graph-management-"),
    );
    const seedDir = path.join(root, "seed");
    const canonicalDir = path.join(root, "canonical");
    const seed = await materializeWorkflowGraphArtifacts({
      skill: buildSkill(),
      outDir: seedDir,
    });
    const { revision: _revision, ...draft } = seed.graph;
    const draftPath = path.join(root, "workflow-draft.json");
    await writeFile(draftPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

    const persisted = await runPersistWorkflowGraph(
      parsePersistWorkflowGraphCliArgs({
        input: draftPath,
        out: canonicalDir,
      }),
    );
    const validated = await runValidateWorkflowGraph(
      parseValidateWorkflowGraphCliArgs({
        workflow: persisted.graphPath,
      }),
    );
    const projectionPath = path.join(root, "review.md");
    const rendered = await runRenderWorkflowGraph(
      parseRenderWorkflowGraphCliArgs({
        workflow: persisted.graphPath,
        out: projectionPath,
      }),
    );

    expect(validated.workflowId).toBe(seed.graph.workflowId);
    expect(rendered.markdownPath).toBe(projectionPath);
    const projection = await readFile(projectionPath, "utf8");
    expect(projection).toContain("## Graph / 图");
    expect(projection).toContain("Source skill: `skill:email-triage`");
    expect(() =>
      parsePersistWorkflowGraphCliArgs({
        input: path.join(canonicalDir, "workflow.json"),
        out: canonicalDir,
      }),
    ).toThrow("must be a separate draft file");
  });

  it("lists immutable versions and restores history as a new revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "workflow-history-"));
    const initialGraph = buildWorkflowGraphFromSkill(buildSkill());
    const first = await persistWorkflowGraphDraft({
      draft: toWorkflowGraphDraft(initialGraph),
      outDir: root,
      now: new Date("2026-07-21T10:00:00.000Z"),
    });
    const second = await persistWorkflowGraphDraft({
      draft: {
        ...toWorkflowGraphDraft(first.graph),
        goal: "Use the updated qualification policy.",
      },
      outDir: root,
      expectedRevisionId: first.graph.revision.revisionId,
      now: new Date("2026-07-21T10:05:00.000Z"),
    });

    const history = await listWorkflowGraphRevisions(second.graphPath);
    expect(history.map(({ graph }) => graph.revision.number)).toEqual([2, 1]);
    expect(history[0].isCurrent).toBe(true);

    const restored = await restoreWorkflowGraphRevision({
      graphPath: second.graphPath,
      revisionId: first.graph.revision.revisionId,
      now: new Date("2026-07-21T10:10:00.000Z"),
    });
    expect(restored.graph.revision).toMatchObject({
      number: 3,
      previousRevisionId: second.graph.revision.revisionId,
    });
    expect(restored.graph.goal).toBe(first.graph.goal);
    expect(await listWorkflowGraphRevisions(restored.graphPath)).toHaveLength(
      3,
    );
  });
});

function defaultTransition(from: string, to: string): WorkflowGraphTransition {
  return {
    id: `transition-${from}-to-${to}`,
    from,
    to,
    type: "default",
    sourceRefs: [],
  };
}

function buildSkill(): OpenClawSkill {
  return {
    schemaVersion: "openclaw-skill-v1",
    promptSet: "specific-v25",
    skillId: "email-triage",
    skillName: "Handle inbound opportunity",
    generatedAt: "2026-07-12T11:00:00.000Z",
    source: {
      runId: "run-001",
      runDir: "/tmp/run-001",
      episodeId: "episode-001",
      startTs: "2026-07-12T10:00:00.000Z",
      endTs: "2026-07-12T10:10:00.000Z",
    },
    executionMode: "autonomous",
    shortDescription: "Qualify an inbound opportunity.",
    description: "Review and respond to an inbound opportunity.",
    goal: "Decide whether and how to follow up.",
    whenToUse: ["An inbound opportunity arrives"],
    whenNotToUse: [],
    inputs: [],
    outputs: [],
    prerequisites: ["Mailbox access"],
    steps: [
      {
        step: 1,
        instruction: "Review the sender and request.",
        intent: "Assess whether the opportunity is credible.",
        operationApp: "Mail",
        hints: ["Use concrete case values only when helpful as examples."],
      },
      {
        step: 2,
        instruction: "Prepare the appropriate response.",
        intent: "Close or advance the opportunity.",
        operationApp: "Mail",
        hints: [],
      },
    ],
    successCriteria: ["A next action is decided"],
    failureModes: [],
    fallback: [],
    examples: [],
    tags: ["email"],
    assets: [],
    evidence: {
      totalEvents: 10,
      anchorEvents: 2,
      ocrEvents: 4,
      appsSeen: ["Mail"],
      windowsSeen: ["Inbox"],
    },
  };
}

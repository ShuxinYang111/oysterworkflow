# PromptSet Changelog

## 2026-07-22

- `specific-v35`
  - Based on `specific-v34`; Call 2 step References and Call 3 node bindings remain unchanged.
  - Restored the exact Call 5 node and transition mapping field contract that was accidentally omitted while adding Reference merge rules in v34.
  - Explicitly requires non-empty `mergedNodeIds` / `mergedTransitionIds` arrays and prohibits the singular `targetNodeId` / `targetTransitionId` aliases in model output.
  - Added a conservative Call 5 boundary normalizer for those unambiguous single-target aliases while keeping persisted proposals strict.
  - `config/user-skill.config.json` now selects `specific-v35`.

- `specific-v34`
  - Based on `specific-v33`; adds the `stepReferences` PromptSet capability.
  - Call 2 now separates concrete case material into a stable `references` catalog and binds only relevant IDs through each step's `referenceRefs`.
  - Call 3 maps those IDs onto the corresponding semantic Action, Decision, Wait, or Terminal node while code copies and validates the catalog.
  - Call 5 preserves existing Reference bindings and lets code append Candidate References deterministically through validated node mappings.
  - `config/user-skill.config.json` now selects `specific-v34`.

## 2026-07-21

- `specific-v33`
  - Based on `specific-v32`; Call 2, Call 3, and Call 4 prompts remain unchanged.
  - Declared the exact Call 5 transition field contract for default, conditional, resume, and retry routes.
  - Required route conditions to use `when` and explicitly prohibited the non-canonical `condition` alias.
  - Added a conservative Call 5 boundary normalizer for unambiguous legacy `condition` output while keeping stored canonical graphs strict.
  - `config/user-skill.config.json` now selects `specific-v33`.

## 2026-07-13

- `specific-v32`
  - Based on `specific-v31`; Call 2, Call 4, and Call 5 prompts remain unchanged.
  - Added a Call 3 node-necessity test: a separate graph node must preserve an independent work objective, route-changing judgment, real external wait, reusable work product, or failure/return/recovery position.
  - Explicitly allowed multiple Skill Steps to collapse into one semantic graph node and one Skill Step to split only when it contains independently meaningful work.
  - Prohibited nodes created only from app/page changes, intermediate navigation, adjacent control operations, or reading adjacent sections of the same work object.
  - `config/user-skill.config.json` now selects `specific-v32`.

## 2026-07-12

- `specific-v31`
  - Based on `specific-v30`; Call 2, Call 3, and Call 4 prompts remain unchanged.
  - Tightened Call 5 Decision identity so complementary or stronger classifications over the same object, evidence, and judgment dimension reuse the existing Decision rather than creating adjacent duplicates.
  - Prohibited synthetic inverse routes that exist only to reconnect a newly inserted Decision to canonical continuation paths.
  - `config/user-skill.config.json` now selects `specific-v31`.

- `specific-v30`
  - Based on `specific-v29` through PromptSet inheritance; Call 2, Call 4, and Call 5 prompts remain unchanged.
  - Clarified the Call 3 JSON contract so action `act` is always a non-empty array of strings and every node `hints` field is an array.
  - Added a conservative parser compatibility path that wraps one non-empty string `act` as a one-item array while preserving all semantic graph validation.
  - `config/user-skill.config.json` now selects `specific-v30`.

- `specific-v29`
  - Based on `specific-v28` through explicit PromptSet inheritance, keeping the tested Call 2 extraction prompt unchanged.
  - Tightened Call 3 terminal outcomes to canonical runtime states and clarified that hints must be selectively useful for future execution rather than a dump of case values.
  - Added Call 5 `workflowMergeProposal`: it reads the full canonical graph plus Call 3 Candidate and returns `merge / no_change / incompatible`, a complete merged v2 graph draft, and exhaustive candidate-to-merged node/transition mappings.
  - Added partial-decision learning, stable-node/transition preservation, many-to-one merge, one-to-many split, provenance-only `no_change`, and explicit bans on node-to-transition absorption, invented branches, `observe`, and `verify`.
  - `config/user-skill.config.json` now selects `specific-v29`.

- `specific-v28`
  - Based on `specific-v27`, removed `observe` and `verify` from Call 3 Candidate action/decision nodes so the workflow-learning graph retains semantic actions, decisions, conditions, outcomes, and selected future-use hints without inventing execution-protocol fields.
  - Allowed a real Decision to contain one known conditional route when the source Skill represents only one observed result; explicitly prohibited condition-only pseudo nodes.
  - Allowed an open Wait node when the demonstrated workflow ends while waiting, and allowed a real conditional cycle with an explicit exit route without forcing an invented numeric retry limit.
  - Kept Call 4 output unchanged and did not implement Call 5.
  - `config/user-skill.config.json` now defaults to `specific-v28` with a real-workflow validator version tag.

- `specific-v27`
  - Based on `specific-v26`, added Call 3 `workflowCandidateGeneration`, whose only business input is the generated `skill.json` and whose output is a candidate node/transition graph.
  - Candidate output explicitly excludes confidence, reason, rationale, provenance, evidence, source references, and step references.
  - Added Call 4 `workflowFamilyMatching`, which compares one candidate with compact Workflow Family cards and returns only `decision` plus `matchedWorkflowId`.
  - Call 5 merge behavior remains intentionally undefined and is not part of this PromptSet.
  - `config/user-skill.config.json` now defaults to `specific-v27` with a workflow-candidate/family-match version tag.

- `specific-v26`
  - Based on `specific-v25`, made `failureModes` and `fallback` evidence-driven instead of completeness-driven: only observed trace behavior, relevant audio narration, or explicit user generation guidance may populate them.
  - Explicitly rejected generic login, network, permission, page-change, retry, and ask-the-user boilerplate unless the accepted evidence teaches that condition or response; runtime and LLM diagnostics are also excluded from skill exception fields.
  - Required scenario generalization to preserve evidence-bound exception fields exactly rather than inventing or expanding them.
  - `config/user-skill.config.json` now defaults to `specific-v26` with an evidence-driven exception version tag.

## 2026-07-11

- `specific-v25`
  - Based on `specific-v24`, clarified that step instructions describe reusable actions for future cases instead of binding execution to the current case.
  - Directed only case-specific observations, examples, and concrete evidence that help a future agent understand, reason about, or execute a step into its `hints`; explicitly prohibited copying case details there by default.
  - `config/user-skill.config.json` now defaults to `specific-v25` with a version tag that marks this future-case step and hint separation.

## 2026-07-02

- `specific-v24`
  - Based on `specific-v23`, replaced OpenClaw-only wording in the active prompt path with agent-neutral skill language so generated skills fit Oyster's multi-agent product direction while remaining compatible with OpenClaw.
  - Kept schema fields, mode names, and extraction behavior unchanged so troubleshooting can focus on wording and downstream planner-facing output.
  - `config/user-skill.config.json` now defaults to `specific-v24` with a version tag that marks the agent-neutral skill language update.

## 2026-04-28

- `specific-v23`
  - Based on `specific-v22`, added optional user generation guidance support so a short user-provided requirement can shape workflow discovery, skill extraction, planner-facing copy, scenario prediction, and scenario generalization.
  - Added the `{{generationGuidanceBlock}}` placeholder to relevant prompt stages and clarified that this guidance is user preference rather than trace evidence, and must not override schema validity or evidence-backed usability.
  - `config/user-skill.config.json` now defaults to `specific-v23` with a version tag that marks the user generation guidance tweak.

## 2026-04-15

- `specific-v22`
  - Based on `specific-v21`, added one explicit workflow-discovery instruction that audio evidence often carries the user's guidance and task-critical logic, so workflow intent and boundaries should align with relevant audio over incidental UI/OCR noise.
  - Added one matching skill-extraction instruction so step planning prioritizes relevant audio guidance and key logic over incidental UI/OCR noise.
  - `config/user-skill.config.json` now defaults to `specific-v22` with a version tag that marks this audio-priority alignment tweak.

## 2026-04-09

- `specific-v21`
  - Based on `specific-v20`, expanded the planner optimization system prompt with explicit `whenToUse` writing instructions for future-facing scenarios, recurring workflow intent, stable constraint preservation, and avoidance of one-time trace retelling.
  - Kept the change isolated to planner-facing `whenToUse` guidance so troubleshooting can focus on retrieval and matching behavior.
  - `config/user-skill.config.json` now defaults to `specific-v21` with a version tag that marks this planner `whenToUse` guidance tweak.

- `specific-v20`
  - Based on `specific-v19`, added one explicit asset-output contract line requiring each asset to use `name` and `value`, with `value` replacing the previously ambiguous `content` wording.
  - Kept the rest of the promptset unchanged so asset troubleshooting stays isolated to one prompt delta.
  - `config/user-skill.config.json` now defaults to `specific-v20` with a version tag that marks this asset-schema alignment tweak.

## 2026-04-08

- `specific-v19`
  - Based on `specific-v18`, added one extra scenario-prediction guard sentence requiring each kept scenario to produce a meaningfully different generalized skill from both the current specific skill and every other kept scenario.
  - Kept the rest of the promptset unchanged so the troubleshooting surface stays narrow.
  - `config/user-skill.config.json` now defaults to `specific-v19` with a version tag that marks this minimal scenario-distinctness tweak.

## 2026-04-04

- `specific-v18`
  - Rebuilt the English promptset directly from `specific-v16` instead of lightly editing `specific-v17`, with the goal of preserving the original Chinese semantics more faithfully.
  - Restored the missing scenario-prediction and scenario-generalization intent, including the partial-logic-reuse wording, the rewrite heuristic table, and the explicit from-scratch execution assumption.
  - `config/user-skill.config.json` now defaults to `specific-v18` with a version tag that marks it as a faithful `specific-v16` English translation.

- `specific-v17`
  - Added a fully English promptset based on `specific-v16` so the active prompt path no longer depends on Chinese prompt text.
  - Kept the step + terminal extraction contract unchanged while translating workflow discovery, extraction, planner optimization, and scenario generalization instructions.
  - `config/user-skill.config.json` now defaults to `specific-v17` with an English-only prompt version tag.

## 2026-04-02

- `specific-v16`
  - Based on `specific-v15`, consolidated the previously separate `skill-extraction-finalize` stage into the explicit `skill-extraction-terminal` mode.
  - The terminal mode now requires the last round to complete the remaining steps and final fields together, and makes it explicit that `coveredThroughEventId` should advance to the end of the terminal chunk.
  - `config/user-skill.config.json` switched to `specific-v16` by default to match the new step + terminal protocol.

## 2026-04-02

- `specific-v15`
  - Based on `specific-v13`, added one more semantic rule for `coveredThroughEventId`: it refers to the last event seen and consumed in the round, not necessarily the last event written as a new step.
  - `config/user-skill.config.json` switched to `specific-v15` by default to reduce extra empty chunks caused by tail-end wrap-up events.

## 2026-04-01

- `specific-v13`
  - Based on `specific-v12`, renamed prompt stages to semantic names: `skillExtraction`, `plannerOptimization`, `scenarioPrediction`, and `scenarioGeneralization`.
  - Replaced the old `callB-step` / `callB-finalize` names with `skill-extraction-step` / `skill-extraction-finalize` so the prompt contract matches the new trace labels, callProfiles, and CLI names.
  - `config/user-skill.config.json` switched to `specific-v13` by default as the only actively maintained promptset at that time.

## 2026-03-30

- `specific-v12`
  - Based on `specific-v10`, tightened the `callD` input context so the model now receives only `skill.json`, without an extra workflow or extraction-summary digest.
  - Rewrote the `callD` prompt into a lighter scenario-prediction instruction and cleared `userPreamble` so concrete context can be appended directly.
  - Added default completion for scenario normalization in `callD`: if the model omits `title` or `generalizationGuidance`, the code now synthesizes a minimal usable fallback so `callE` does not fail immediately.

## 2026-03-28

- `specific-v10`
  - Based on `specific-v9`, strengthened the website-login workflow generalization rules in `callE` and added explicit environment normalization constraints.
  - Distinguished stable target domains from unstable local browser containers so generalized skills do not implicitly depend on the user's current Chrome tabs, profile, cookies, or active session.
  - Added a from-scratch execution constraint so generalized skills can start without existing context and explicitly describe controlled browser startup, entering the target site, logging in when needed, and locating the target object.

- `specific-v9`
  - Based on `specific-v8`, added two post-processing stages, `callD` and `callE`, for the path specific skill -> predicted reuse scenarios -> scenario-conditioned generalized skill.
  - `callD` now outputs 1 to 3 lightly structured scenario cards rather than relying on hard-coded generalization fields.
  - `callE` performs scenario-conditioned generalization, emphasizing action preservation, relative time, stable platforms and domains, and stable output containers versus temporary instances.

## 2026-03-26

- `specific-v8`
  - Based on `specific-v7`, tightened the workflow-discovery split rule so “is this still the same final outcome?” matters more than “did the user switch app or page?”.
  - Explicitly required workflow boundaries to start from the entry action needed to reproduce the task, avoiding dropped app-open, landing-page, and search-entry steps.
  - Strengthened the `callB-step` requirement to preserve major phases such as entry, core operations, and verification/closure rather than compressing the workflow into a high-level summary.

- `specific-v7`
  - Based on `specific-v6`, added an explicit `workflowDiscovery` stage that identifies and ranks multiple workflow candidates inside an episode.
  - Changed the `callB` input semantics from the old `callA.goal / callA.skillName` shape to `selectedWorkflow`, so step generation follows the chosen workflow directly.
  - Kept the dual role of `shortDescription` and `description`, while the planner-facing rewrite stage still edits only copy-oriented fields.

- `specific-v6`
  - Based on `specific-v5`, introduced the dual-description mechanism with `shortDescription`.
  - Required `callB-finalize` and `callC` to produce a short summary within 280 characters instead of truncating the full `description` for OpenClaw frontmatter.
  - Kept the full `description` for the `SKILL.md` body while making OpenClaw discovery consume a shorter, more stable summary.

## 2026-03-25

- `specific-v5`
  - Based on `specific-v4`, added the staged `callB` protocol description.
  - Explicitly separated `callB-step` and `callB-finalize` so step mode no longer keeps outputting a full skill JSON while omitting `coveredThroughEventId`.
  - Clarified that finalize-stage `assets` are only additive and should not overwrite assets already extracted in earlier chunks.

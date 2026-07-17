# OysterWorkflow Roadmap

OysterWorkflow is building a work experience layer for AI agents: capture real computer work, extract the workflow and judgment that made it succeed, and let agents reuse that experience.

This roadmap is directional. It is not a commitment to ship every item or to ship them in this exact order.

## Current release

- desktop capture for screen states, visible text, UI actions, inputs, app context, and optional voice coaching
- candidate workflow discovery from noisy real work sessions
- reviewable workflow graphs with actions, decisions, branches, terminal outcomes, and revision history
- a local runtime that pins revisions, validates transitions, limits retries, and preserves run state
- a Codex plugin beta that lets Codex execute graph nodes with its authorized apps and tools
- a current macOS Apple Silicon release and an earlier Windows x64 build
- an Apache-2.0 open core for trace processing, workflow discovery, OpenClaw skill extraction, and quality evaluation

## Near-term focus

- reduce installation, permission, and first-run friction
- make recording quality and missing evidence easier to understand
- improve graph review, editing, version comparison, and trust signals
- strengthen long-running execution, recovery, and verification in Oyster AI Worker
- expand safe handoff to Codex and other agent runtimes
- improve Windows support and Chinese-language behavior across platforms

## Experience layer direction

The workflow graph is the durable product boundary. Skills, MCP tools, AI Workers, and future agent integrations are ways to consume it.

Longer-term exploration includes:

- learning from both human and agent execution traces
- merging new cases into an existing workflow without losing proven behavior
- portable policies for context, preferences, risk, verification, and completion
- quality evaluation loops for workflow revisions and agent runs
- shared and team-managed experience libraries

## Feedback wanted

The most useful feedback tells us:

- which real workflow you tried
- what judgment or preference the Agent needed to preserve
- where the extracted graph was incomplete or wrong
- which retry, recovery, verification, or completion rule was missing
- which Agent or app integration would make the workflow useful
- what would make you trust it for recurring work

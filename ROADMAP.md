# OysterWorkflow Roadmap

OysterWorkflow is building a work experience layer for autonomous agents: a way to capture real computer work, extract the patterns that made it succeed, and hand those patterns to agent runtimes as reusable memory.

This roadmap is directional. It is not a commitment to ship every item or to ship them in this exact order.

## Current Release

- macOS desktop app for Apple Silicon and Windows x64 installer
- workflow evidence capture from screen activity, OCR text, UI events, input traces, window state, and optional narration
- candidate workflow detection from noisy real sessions
- structured experience generation for noticing rules, retry logic, verification checks, and completion conditions
- OpenClaw skill artifact generation as the first runtime target
- skill installation into OpenClaw-discoverable folders
- public noncommercial release through GitHub Releases

## Near-Term Focus

- reduce macOS installation / permission friction and Windows setup friction
- make recorder, candidate workflow, and skill review states clearer
- make generated artifacts easier to inspect, compare, and trust
- improve how the product explains captured work as reusable agent memory
- collect examples of workflows that need goal retention, preference alignment, recovery logic, and verification checks
- improve feedback loops around where generated steps are useful, wrong, or missing context

## Experience Layer Direction

OpenClaw skills are the first runtime artifact, not the final boundary of the product.

Future work may explore:

- clearer schemas for work experience artifacts
- better examples that show how real traces become agent memory
- richer review surfaces for long workflows and edge cases
- quality evaluation loops for generated capabilities
- integration surfaces for Codex, Claude Code, Cursor, OpenAI Agents, OpenClaw, and custom agent stacks
- additional runtimes where observed work paths, user preferences, and recovery moves can improve repeatability

The source code is currently private. Any future opening of source code, SDKs, or integration layers will be announced separately.

## Feedback Wanted

The most useful feedback right now:

- what workflow you tried to capture
- what goal, preference, or decision rule the agent should remember
- where the product felt confusing or untrustworthy
- what the generated artifact got right or wrong
- what recovery moves, verification checks, or completion conditions were missing
- what integration surface would make this useful in your own agent stack
- what would make you comfortable using this for real repetitive work

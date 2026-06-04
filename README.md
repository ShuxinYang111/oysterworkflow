# OysterWorkflow

[English](./README.md) | [简体中文](./README.zh-CN.md)

The work experience layer for autonomous agents on macOS and Windows.

[Website](https://oysterworkflow.vercel.app/) | [Open Core](https://github.com/ShuxinYang111/oysterworkflow-core) | [Download Latest Release](https://github.com/ShuxinYang111/oysterworkflow/releases/latest) | [Release Notes](https://github.com/ShuxinYang111/oysterworkflow/releases) | [Report an Issue](https://github.com/ShuxinYang111/oysterworkflow/issues) | [Commercial Licensing](mailto:shuxin.y.97@gmail.com)

OysterWorkflow captures what humans and agents observe, how they react, and how they complete real work on computers. It turns screens, OCR text, clicks, keystrokes, retries, choices, and verification moves into reusable experience for AI agents.

The current release focuses on reviewable AI skills: recording evidence, detecting candidate workflows, creating structured workflow skills, and installing them into your agent.

## Open Core

The core workflow pipeline is open source in [OysterWorkflow Core](https://github.com/ShuxinYang111/oysterworkflow-core) under the Apache-2.0 license.

The open core includes the Screenpipe ingest client, OCR/UI/audio trace processing, event normalization, deduplication, segmentation, workflow discovery, OpenClaw skill extraction, and generated skill quality evaluation.

This repository remains the public release home for the desktop app: binaries, documentation, screenshots, issue tracking, and product updates. The private desktop app source code is not included here.

## The Idea

Autonomous agents need more than instructions. They need work experience.

Most real work is not just reasoning or a checklist. It is a compound of experience patterns: noticing, deciding, trying, fixing, verifying, and finishing. OysterWorkflow preserves those patterns from real computer work so agent stacks such as Codex, Claude Code, Cursor, OpenAI Agents, OpenClaw, and custom agents can reuse the path that already worked.

## How Work Becomes Agent Experience

1. **Capture real work.** Just do your work while OysterWorkflow records screen states, OCR text, inputs, windows, and optional narration as evidence.
2. **Detect the meaningful pattern.** The app identifies what changed, what mattered, and where the task actually progressed inside a noisy session.
3. **Structure the experience.** Captured work becomes reusable noticing rules, retry logic, verification checks, and completion conditions.
4. **Hand it to the agent ecosystem.** The finished artifact becomes agent-ready memory and runtime material, starting with skills.

## What Agents Gain

- **Goal retention:** the agent is anchored to a demonstrated outcome instead of only a fresh prompt interpretation.
- **Workflow fidelity:** the agent can follow the path that worked in real software instead of improvising around every page and tool.
- **Preference alignment:** naming habits, folder structure, cleanup standards, and judgment rules can carry forward.
- **Repeatability:** recurring work can reuse a steadier experience layer instead of being solved from scratch each time.
- **Edge-case handling:** retries, failed clicks, changed pages, ambiguous states, and verification moves remain part of the memory.
- **Less prompting:** users do not need to rewrite long setup prompts every time the same workflow returns.
- **Long workflow support:** multi-step work keeps the chain of decisions that made it coherent over time.

## Current Runtime Artifact

 Skills are the first runtime artifact, not the final boundary of the product. Working on the harness and workflow script now.

The current release focuses on:

- `skill.json` for the generated skill definition
- `assets.json` for captured supporting evidence
- `summary.json` for run and generation context
- human review before a generated capability is installed or reused

## Product Screens

### Recorder control

Start the recorder, do your work, and stop it. Here to review recorder metrics: screen states, OCR text, inputs, windows, and optional narration captured as evidence.

![OysterWorkflow recorder dashboard with capture controls and status cards](./assets/screenshots/01-recorder-dashboard.png)

### Candidate workflow detection

Review the work patterns OysterWorkflow detected from a noisy session, then choose the path worth turning into reusable agent experience.

![OysterWorkflow workflow candidate discovery screen](./assets/screenshots/02-workflow-candidates.png)

### Skill draft review

Inspect generated steps and hints before installing the result to your agent.

![OysterWorkflow generated skill steps with sensitive details redacted](./assets/screenshots/03-skill-steps-redacted.png)

### Skill manager and agent handoff

Manage generated skills, copy the recommended execution prompt, and remove obsolete capabilities when they are no longer useful.

![OysterWorkflow skill manager with generated skills and copy prompt controls](./assets/screenshots/04-skill-manager-installation.png)

## Who Should Try It?

OysterWorkflow is most relevant if you:

- repeat desktop or browser workflows and want to capture the real path once
- build AI agent, RPA, workflow automation, or developer productivity tools
- need to turn messy operational procedures into reviewable artifacts
- care about user preferences, recovery logic, and verification checks
- want human review before generated skills are installed or reused

## Download

Download the latest macOS or Windows build from [Releases](https://github.com/ShuxinYang111/oysterworkflow/releases/latest).

Current release assets:

- `OysterWorkflow-0.1.0-arm64.dmg`
- `OysterWorkflow-Setup-0.1.0.exe`

SHA-256:

```text
macOS arm64 dmg:
711fe49c3abeb66e109c1ab78476b09978d3c83c042b922a58a6affa46d16187

Windows x64 installer:
78dad16a0e9152173d128ca5c2674a4987c61a4245e5f67bd2650654687bf0cf
```

## System Requirements

- macOS on Apple Silicon (`arm64`)
- Windows x64

## Installation Notes

### macOS

1. Download `OysterWorkflow-0.1.0-arm64.dmg` from the latest release.
2. Open the `.dmg` and drag `OysterWorkflow.app` into `Applications`.
3. Launch OysterWorkflow from `Applications`.
4. Grant the required macOS permissions when prompted.
5. If a recorder permission was just enabled, quit and reopen the app once before starting a recording.

Because OysterWorkflow records workflow evidence, macOS may ask for:

- Screen Recording
- Accessibility
- Input Monitoring
- Microphone, when voice narration is enabled

### Windows

1. Download `OysterWorkflow-Setup-0.1.0.exe` from the latest release.
2. Run the installer.
3. Launch OysterWorkflow from the Start menu or install location.
4. Enable recorder audio only when you want voice narration captured.

Windows notes:

- The Windows build is x64.
- The Windows version currently does not support Chinese text input in the app.
- Voice transcription on Windows currently works best for English. Chinese speech transcription is not reliable in this release.

## Public Repo Scope

This public repository hosts release binaries, documentation, screenshots, issue tracking, and the official product website link. The private OysterWorkflow source code is not included here.

For the open-source implementation surface, see [OysterWorkflow Core](https://github.com/ShuxinYang111/oysterworkflow-core).

## Third-Party Components

OysterWorkflow bundles third-party sidecar tools used by the recorder, including Screenpipe, FFmpeg, and ffprobe. These components keep their own license terms; they are not relicensed as OysterWorkflow code and are not covered by the PolyForm Noncommercial terms.

See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for bundled component notices, FFmpeg/ffprobe source information, and the build-time license profile recorded in `screenpipe-bundle.json`.

## Roadmap and Feedback

- See [ROADMAP.md](./ROADMAP.md) for the current direction.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for useful feedback areas and issue guidelines.
- Use [GitHub Issues](https://github.com/ShuxinYang111/oysterworkflow/issues) for installation problems, workflow-generation feedback, and feature requests.

## FAQ

**Which part of OysterWorkflow is open source?**

[OysterWorkflow Core](https://github.com/ShuxinYang111/oysterworkflow-core) is open source under Apache-2.0. It contains the CLI pipeline for ingesting Screenpipe traces, generating OpenClaw skill artifacts, and evaluating generated skills. This desktop app release repository is public, but it does not include the private app source code.

**What does OysterWorkflow generate today?**

The current workflow generates reviewable OpenClaw skill artifacts, typically including `skill.json`, `assets.json`, and `summary.json`.

**Does OysterWorkflow fully automate every workflow after one recording?**

No. The current product focuses on capturing workflow evidence, discovering candidate workflows, generating reviewable artifacts, and letting the user inspect the result before reuse.

**Is commercial use allowed?**

Not under the public release license. Public releases are licensed for noncommercial use under PolyForm Noncommercial 1.0.0. Commercial use requires separate written permission.

**What should I avoid sharing in public issues?**

Do not share credentials, private URLs, account data, customer data, or sensitive screenshots. Redacted workflow descriptions are much more useful than raw private data.

## License

Public releases are licensed under [PolyForm Noncommercial 1.0.0](./LICENSE).

In plain language:

- you may download and use the public release for noncommercial purposes
- you do not receive rights to the private source code
- commercial use is not licensed under the public release terms

See [LICENSE-SUMMARY.md](./LICENSE-SUMMARY.md) for the plain-language summary.

For commercial licensing, contact: `shuxin.y.97@gmail.com`

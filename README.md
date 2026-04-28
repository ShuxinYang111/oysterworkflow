# OysterWorkflow

[English](./README.md) | [简体中文](./README.zh-CN.md)

Turn real computer workflows into reusable agent capabilities on macOS.

[Download Latest Release](https://github.com/ShuxinYang111/oysterworkflow/releases/latest) | [Release Notes](https://github.com/ShuxinYang111/oysterworkflow/releases) | [Report an Issue](https://github.com/ShuxinYang111/oysterworkflow/issues)

OysterWorkflow is a desktop app for capturing real workflow evidence, reviewing candidate workflows, generating reusable skill artifacts, and installing those skills into OpenClaw-discoverable folders. It is an early step toward workflow-to-capability infrastructure: turning demonstrated human computer workflows into reviewable, reusable agent capabilities.

This public repository is the release home for OysterWorkflow. It is intended for downloads, release notes, screenshots, product documentation, and issue tracking. The source code for OysterWorkflow is currently private; future partial source, SDK, or integration surfaces are being considered, but are not promised in this release.

## Why Follow This Repo?

This repo is useful to follow if you care about:

- workflow evidence as training and review material for AI agents
- turning real desktop work into reusable capability packages
- OpenClaw skills as an early runtime artifact for agent capabilities
- human-in-the-loop review before generated skills are installed or reused
- practical macOS workflows where screen state, OCR text, UI events, and user judgment all matter

## Who Should Try It?

OysterWorkflow is most relevant if you:

- repeat desktop or browser workflows and want to capture the real path once
- build AI agent, RPA, workflow automation, or developer productivity tools
- need to turn messy operational procedures into reviewable artifacts
- want to test how generated OpenClaw skills feel before this idea becomes more automated

Current release scope is intentionally narrow: macOS on Apple Silicon, public noncommercial release, and private source code.

## Screenshots

### Capture and recorder status

Start, stop, or schedule a capture from one place while checking OCR language priority, audio capture, recorder status, and macOS permission readiness.

![OysterWorkflow recorder dashboard with capture controls and status cards](./assets/screenshots/01-recorder-dashboard.png)

### Workflow candidate discovery

Review candidate workflows detected from a recorded session, see the stage summary, and choose whether to continue with the generated candidate or create one manually.

![OysterWorkflow workflow candidate discovery screen](./assets/screenshots/02-workflow-candidates.png)

### Skill draft review

Inspect the generated OpenClaw skill steps and evidence notes before installing the result. Sensitive personal and account-specific details are redacted in this screenshot.

![OysterWorkflow generated skill steps with sensitive details redacted](./assets/screenshots/03-skill-steps-redacted.png)

### Skill manager and install prompts

Manage installed skills, copy the recommended execution prompt, and uninstall generated skills when they are no longer needed.

![OysterWorkflow skill manager with generated skills and copy prompt controls](./assets/screenshots/04-skill-manager-installation.png)

## Why People Use It

- Capture workflow evidence from screen activity, OCR, UI events, and optional voice narration
- Turn one recording session into candidate reusable workflows
- Review generated skill artifacts before export or install
- Install finished skills directly into an OpenClaw skill folder

## How It Works

1. Record a workflow in the desktop app.
2. Review the captured session and select the workflow you want.
3. Generate a reusable OpenClaw skill artifact.
4. Install the result into your skill directory and reuse it later.

## Download

Download the latest macOS build from [Releases](https://github.com/ShuxinYang111/oysterworkflow/releases/latest).

Current release asset:

- `OysterWorkflow-0.1.0-arm64.dmg`

SHA-256:

```text
711fe49c3abeb66e109c1ab78476b09978d3c83c042b922a58a6affa46d16187
```

## System Requirements

- macOS
- Apple Silicon Mac (`arm64`)

## Installation Notes

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

## What This Public Repo Contains

- macOS release downloads
- release notes
- screenshots and product documentation
- issue tracking for installation and usage problems

It does not include the private source code for OysterWorkflow.

## Roadmap and Feedback

- See [ROADMAP.md](./ROADMAP.md) for the current direction.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for useful feedback areas and issue guidelines.
- Use [GitHub Issues](https://github.com/ShuxinYang111/oysterworkflow/issues) for installation problems, workflow-generation feedback, and feature requests.

## FAQ

**Is this repo open source?**

No. This public repository hosts release binaries, documentation, screenshots, and issue tracking. The OysterWorkflow source code is currently private.

**Will any source code or SDK be opened later?**

Possibly. Future partial source, SDK, or integration surfaces are being considered, especially around artifacts and runtime integration, but this release does not promise a timeline or scope.

**What does OysterWorkflow generate?**

The current workflow generates reviewable OpenClaw skill artifacts, typically including files such as `skill.json`, `assets.json`, and `summary.json`.

**Is commercial use allowed?**

Not under the public release license. Public releases are licensed for noncommercial use under PolyForm Noncommercial 1.0.0. Commercial use requires separate written permission.

**Does OysterWorkflow fully automate every workflow after one recording?**

No. The current product focuses on capturing workflow evidence, discovering candidate workflows, generating reviewable artifacts, and letting the user inspect the result before reuse.

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

## Feedback

Use [GitHub Issues](https://github.com/ShuxinYang111/oysterworkflow/issues) for bug reports, installation problems, and workflow-generation feedback.

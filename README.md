# OysterWorkflow

OysterWorkflow is a macOS desktop app for turning recorded workflows into reusable OpenClaw skills.

This repository is the public release home for the app. It provides downloads, release notes, licensing information, and issue tracking. The source code for OysterWorkflow is currently private.

## Download

Download the latest macOS build from [Releases](../../releases).

Current public release asset:

- `OysterWorkflow-0.1.0-arm64.dmg`

## What OysterWorkflow Does

- Records workflow evidence from screen activity, OCR, UI events, and optional voice narration
- Finds candidate workflows from one captured session
- Generates reusable OpenClaw skill artifacts from recorded workflows
- Lets you inspect artifacts before exporting or installing them
- Installs generated skills into OpenClaw-discoverable directories

## Platform

OysterWorkflow is currently distributed as a macOS desktop app.

Because it records workflow evidence, macOS may ask for permissions such as:

- Screen Recording
- Accessibility
- Input Monitoring
- Microphone, when voice narration is enabled

## Quick Start

1. Download the latest `.dmg` from the Releases page.
2. Open the app and grant the required macOS permissions.
3. Record a workflow.
4. Review the captured session and generate an OpenClaw skill.
5. Install the generated skill into OpenClaw.

## Public Repo, Private Source

OysterWorkflow is currently distributed as closed-source public binaries.

That means:

- this repository is public for downloads, release notes, documentation, and issue tracking
- the app source code is not included here
- public releases are licensed for noncommercial use under PolyForm Noncommercial 1.0.0

See [LICENSE](./LICENSE) and [LICENSE-SUMMARY.md](./LICENSE-SUMMARY.md) for details.

For commercial licensing, contact: `shuxin.y.97@gmail.com`

## Feedback

Use GitHub Issues for bug reports, installation problems, and workflow-generation feedback.

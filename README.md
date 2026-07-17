<p align="center">
  <img src="./assets/oysterworkflow-app-icon.png" alt="OysterWorkflow pearl app icon" width="112" />
</p>

<h1 align="center">OysterWorkflow</h1>

<p align="center"><strong>Teach AI how your work actually gets done.</strong></p>

<p align="center">Capture real computer work, extract the workflow and judgment behind it, then run that experience with your AI agent.</p>

<p align="center">
  <a href="https://github.com/ShuxinYang111/oysterworkflow/releases/download/v0.2.0/OysterWorkflow-0.2.0-arm64.dmg"><strong>Download for macOS</strong></a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="https://oysterworkflow.com/">Website</a>
  &nbsp;&nbsp;|&nbsp;&nbsp;
  <a href="./README.zh-CN.md">简体中文</a>
</p>

![A reviewable OysterWorkflow graph with actions, decisions, branches, and verification](./assets/screenshots/03-workflow-graph.png)

## Powerful AI still needs your workflow and judgment

AI can reason, but it does not automatically know which signal matters, when to branch, how to recover, or what "done" means in your work.

OysterWorkflow learns these patterns from real computer work. You demonstrate the task in the apps you already use, review the extracted workflow graph, and hand a pinned revision to an agent.

## From real work to reusable agent experience

1. **Capture real work.** Record screen states, visible text, mouse and keyboard actions, app context, and optional voice coaching while you work normally.
2. **Learn the pattern.** Extract goals, decision branches, preferences, exceptions, retry logic, verification checks, and completion conditions.
3. **Run the workflow.** Turn the evidence into a reviewable, revisioned graph that Oyster AI Worker, Codex, or another compatible agent can follow.

## See what OysterWorkflow learns

<table>
  <tr>
    <td width="50%">
      <img src="./assets/screenshots/01-recorder-dashboard.png" alt="OysterWorkflow recorder controls and capture status" />
      <br />
      <strong>Capture the work</strong><br />
      Record the screen, visible text, inputs, app context, and optional narration.
    </td>
    <td width="50%">
      <img src="./assets/screenshots/02-workflow-candidates.png" alt="OysterWorkflow candidate workflow review" />
      <br />
      <strong>Choose the pattern</strong><br />
      Review the meaningful workflows detected inside a noisy work session.
    </td>
  </tr>
</table>

The result preserves more than a checklist:

- what context the agent should notice or ignore
- which actions and decisions move the task forward
- how to recover from changed pages, failed attempts, and ambiguous states
- how to verify the outcome and know when the task is complete

## Run an OysterWorkflow workflow in Codex

The Codex plugin connects Codex to the OysterWorkflow Runtime on the same Mac. OysterWorkflow owns the workflow graph, revision, transitions, retry limits, and durable run state. Codex performs the real actions with the apps and tools installed and authorized in Codex.

You need both OysterWorkflow and Codex. Every app required by the workflow must also be available to Codex.

```bash
codex plugin marketplace add ShuxinYang111/oysterworkflow
codex plugin add oysterworkflow@oysterworkflow
```

Start a new Codex task and try:

```text
Use OysterWorkflow to run "Screen sales inquiries and prepare replies"
```

The beta connects to the local MCP endpoint at `http://127.0.0.1:3034/api/codex/mcp`, so OysterWorkflow must remain running during execution.

## Download and start

### macOS Apple Silicon

Current installer: `OysterWorkflow-0.2.0-arm64.dmg`. Use the download link at the top of this page.

1. Open the DMG and drag `OysterWorkflow.app` into `Applications`.
2. Launch OysterWorkflow and grant the requested permissions.
3. Record one real workflow, review the graph, and choose where to run it.

Screen Recording, Accessibility, and Input Monitoring permissions support desktop capture. Microphone permission is only needed for voice coaching.

### Windows x64

**[Download the Windows 0.1.0 build](https://github.com/ShuxinYang111/oysterworkflow/releases/download/v0.1.0/OysterWorkflow-Setup-0.1.0.exe)**

The Windows build is an earlier release. The Codex plugin and the newest workflow graph experience currently require macOS Apple Silicon.

## Open-source core

[OysterWorkflow Core](https://github.com/ShuxinYang111/oysterworkflow-core) is available under Apache-2.0. It includes the Screenpipe ingest client, trace normalization, deduplication, segmentation, workflow discovery, OpenClaw skill extraction, and generated skill quality evaluation.

This repository is the public home for desktop releases, documentation, screenshots, the Codex plugin, and issue tracking. The desktop app source code is not included here.

## Feedback and licensing

- [Report an issue](https://github.com/ShuxinYang111/oysterworkflow/issues)
- [Read the roadmap](./ROADMAP.md)
- [Contribute feedback](./CONTRIBUTING.md)
- [Review third-party notices](./THIRD-PARTY-NOTICES.md)

Public desktop releases use the [PolyForm Noncommercial 1.0.0](./LICENSE) license. Commercial use requires separate written permission. See the [plain-language license summary](./LICENSE-SUMMARY.md) or contact [shuxin.y.97@gmail.com](mailto:shuxin.y.97@gmail.com).

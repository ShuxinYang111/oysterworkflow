# OysterWorkflow Codex Plugin

This MCP-only plugin lets Codex execute workflows recorded, generated, and managed by OysterWorkflow. The workflow remains a revisioned canonical graph in OysterWorkflow instead of being copied into a generated Codex skill.

这个 MCP-only plugin 让 Codex 执行由 OysterWorkflow 录制、生成和管理的 workflow。Workflow 始终保留为带 revision 的 OysterWorkflow 规范执行图，不会被复制成动态生成的 Codex skill。

## Install / 安装

1. Install and launch the latest OysterWorkflow desktop app on the same Mac as Codex.
2. Add this GitHub marketplace:

   ```bash
   codex plugin marketplace add ShuxinYang111/oysterworkflow
   ```

3. Install the plugin:

   ```bash
   codex plugin add oysterworkflow@oysterworkflow
   ```

4. Start a new Codex task and try:

   ```text
   用 OysterWorkflow 执行“筛选销售询盘并准备回复”
   ```

## Requirements / 使用条件

- Codex with this plugin installed.
- OysterWorkflow installed and running on the same computer.
- A generated canonical `workflow.json` for the selected workflow.
- Every app or capability named by the workflow must also be available to Codex. For example, an Outlook workflow needs an Outlook-capable Codex app/plugin or another authorized execution tool.

- Codex 已安装此 plugin。
- 同一台电脑已安装并运行 OysterWorkflow。
- 被选 workflow 已生成规范 `workflow.json`。
- Workflow 依赖的 app/capability 也必须在 Codex 中可用。例如 Outlook workflow 还需要 Codex 能访问 Outlook 的 app/plugin 或其它已授权执行工具。

The local MCP endpoint is `http://127.0.0.1:3034/api/codex/mcp`.

## Runtime model / 运行模型

Codex calls OysterWorkflow to search and fetch workflows, verify readiness, pin a workflow revision, and advance one validated graph node at a time. Codex performs external actions with its own installed apps and tools. OysterWorkflow owns workflow discovery, revision pinning, transition validation, retry limits, and durable run state.

`cancel_workflow_run` stops future workflow actions but cannot undo external actions already completed by Codex.

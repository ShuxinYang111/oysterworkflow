# OysterWorkflow Codex Plugin

This MCP-only plugin lets Codex execute workflows recorded, generated, and managed by OysterWorkflow. The workflow stays a revisioned OysterWorkflow canonical graph; it is not copied into a generated Codex skill.

这个 MCP-only plugin 让 Codex 执行由 OysterWorkflow 录制、生成和管理的 workflow。Workflow 始终保留为带 revision 的 OysterWorkflow 规范执行图，不会被复制成动态生成的 Codex skill。

## Install / 安装

1. Install and launch the latest OysterWorkflow desktop app on the same Mac as Codex.
2. Add the public GitHub marketplace:

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

## Runtime model / 运行模型

1. Codex searches or fetches a workflow from the local OysterWorkflow Runtime.
2. OysterWorkflow validates the canonical graph and lists the apps the workflow expects.
3. Codex prepares a run, which pins the graph revision and current node.
4. Codex uses its own installed apps, plugins, and tools to execute only that node.
5. Codex records evidence and asks OysterWorkflow to validate one transition.
6. OysterWorkflow persists the new current node until the run reaches a terminal state.

Codex performs external actions; OysterWorkflow owns workflow discovery, revision pinning, transition validation, retry limits, and durable run state.

Codex 负责真实外部动作；OysterWorkflow 负责 workflow 发现、revision 固定、transition 校验、重试上限和持久运行状态。

## Requirements / 使用条件

- Codex with this plugin installed.
- OysterWorkflow installed and running on the same computer.
- A generated canonical `workflow.json` for the selected workflow.
- Every app or capability named by the workflow must also be available to Codex. For example, an Outlook workflow needs an Outlook-capable Codex app/plugin or another authorized execution tool.

- Codex 已安装此 plugin。
- 同一台电脑已安装并运行 OysterWorkflow。
- 被选 workflow 已生成规范 `workflow.json`。
- Workflow 依赖的 app/capability 也必须在 Codex 中可用。例如 Outlook workflow 还需要 Codex 能访问 Outlook 的 app/plugin 或其它已授权执行工具。

The default local MCP endpoint is `http://127.0.0.1:3034/api/codex/mcp`. If OysterWorkflow uses another Runtime port, update `.mcp.json` before packaging or installation.

## Example / 示例

```text
用 OysterWorkflow 执行“筛选销售询盘并准备回复”
```

Codex should call the tools in this order:

```text
search -> fetch -> get_workflow_readiness -> prepare_workflow_run
       -> execute current node with Codex tools -> advance_workflow_run
       -> repeat until terminal
```

`cancel_workflow_run` stops future workflow actions but cannot undo external actions already completed by Codex.

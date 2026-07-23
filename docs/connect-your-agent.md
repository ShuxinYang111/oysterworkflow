# Connect an AI Agent to OysterWorkflow

OysterWorkflow ships one local STDIO MCP bridge that can be used by Codex, Claude, OpenClaw, Hermes, and other MCP-capable clients on the same computer.

## Copy This Prompt

Send this entire prompt to the agent you are currently using:

```text
Connect the AI agent you are currently running to the OysterWorkflow desktop app on this computer through its local STDIO MCP bridge.

Requirements:
1. Configure only this current AI client. Do not modify MCP settings for other clients.
2. Confirm OysterWorkflow is installed. If it is missing, stop and send me to https://github.com/ShuxinYang111/oysterworkflow/releases/latest.
3. Locate the packaged launcher named oysterworkflow-mcp on macOS or oysterworkflow-mcp.cmd on Windows. The typical macOS path is /Applications/OysterWorkflow.app/Contents/Resources/mcp/oysterworkflow-mcp. On Windows, locate it under the installed OysterWorkflow app's resources\mcp directory.
4. Add the launcher as a local stdio MCP server named oysterworkflow using this client's supported MCP CLI or configuration file. Use the launcher as the command with no arguments. Do not connect directly to a localhost port, copy runtime tokens, or expose the server publicly.
5. If this client is Codex and supports plugins, prefer the first-party OysterWorkflow plugin: add the marketplace ShuxinYang111/oysterworkflow, then install oysterworkflow@oysterworkflow.
6. Start OysterWorkflow if it is closed. Reload MCP servers, or tell me exactly which restart or new conversation is required.
7. Verify that the server initializes and tools/list includes search, fetch, prepare_workflow_run, get_workflow_run, advance_workflow_run, and cancel_workflow_run. Do not execute a workflow during setup.
8. Report the exact configuration or commands you changed and the verification result. Ask before overwriting an existing oysterworkflow MCP entry.
```

## Packaged Launcher

The launcher starts the bridge over standard input and output. It does not expose a public port.

- macOS: `/Applications/OysterWorkflow.app/Contents/Resources/mcp/oysterworkflow-mcp`
- Windows: locate `resources\mcp\oysterworkflow-mcp.cmd` inside the installed OysterWorkflow application directory

The bridge discovers the current private OysterWorkflow Runtime connection. Do not copy its dynamic port or per-launch token into an AI client's configuration.

## After Setup

The client may require an MCP reload, application restart, or new conversation before the tools appear. Once connected, try:

```text
Use OysterWorkflow to run "Filter sales inquiries and prepare replies."
```

OysterWorkflow provides the workflow graph and durable run state. The current agent remains responsible for its own external tools, account access, and permissions.

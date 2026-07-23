# OysterWorkflow Codex Plugin

This plugin connects Codex to the same local OysterWorkflow MCP bridge used by other MCP-capable agents.

## How it connects

Codex starts the bundled STDIO MCP bridge on demand. The bridge discovers the current dynamic localhost Runtime port through an owner-only connection file written by OysterWorkflow. Users do not configure a port or start the bridge manually.

If OysterWorkflow is closed, the plugin remains loadable and tool calls ask the user to open the app. OysterWorkflow provides workflow state; Codex remains responsible for its own tools, permissions, and external actions.

## Requirements

- Install and open a compatible OysterWorkflow desktop release.
- Install this plugin in Codex.
- Start a new Codex task after installing or updating the plugin.

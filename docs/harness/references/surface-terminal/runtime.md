# Terminal Surface Rules

Use this reference before terminal phases.

## Core Rules

- Confirm the working directory and target paths before running commands.
- Prefer commands with observable output, deterministic files, or clear exit status.
- Validate generated files, command results, and changed state before moving on.
- Ask for approval before destructive commands, credential changes, installs, uploads, or production-impacting operations.
- Stop when required tools, paths, credentials, permissions, or command outputs are missing or ambiguous.

## Common Mistakes

- Running a command in the wrong directory.
- Treating a command start as success without checking exit status or output.
- Deleting or overwriting files without approval.
- Hiding stderr or partial failures from the final report.

# Browser Surface Rules

Use this reference before browser phases.

## Core Rules

- Confirm the current site, page, account, and relevant visible state before acting.
- Do not treat a click, typed value, or URL change as success by itself.
- Validate state changes by observing the page, saved state, uploaded file, downloaded file, confirmation message, or submitted result.
- Ask for approval before submit, send, publish, purchase, delete, or other externally visible actions.
- Stop when login, permissions, human verification, ambiguous results, or unreadable page state prevents reliable progress.

## Common Mistakes

- Acting in the wrong account or workspace.
- Clicking submit before reviewing the final visible payload.
- Assuming a spinner, route change, or disabled button means the action succeeded.
- Reusing stale page state after navigation or reload.

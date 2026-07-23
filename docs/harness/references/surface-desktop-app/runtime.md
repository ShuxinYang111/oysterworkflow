# Desktop App Surface Rules

Use this reference before native desktop app phases.

## Core Rules

- Confirm the active app, window, document, and edit target before making changes.
- Distinguish editing the original from editing a copy.
- Validate save, export, import, destructive edit, and document-state changes through observable app state or file output.
- Ask for approval before overwriting files, deleting content, sending from an app, or changing shared/local settings.
- Stop when the target app, window, document, permission prompt, or save/export result cannot be observed.

## Common Mistakes

- Typing into the wrong focused window.
- Saving over the original when the user expected a copy.
- Treating visible text in chat as proof that a document file was updated.
- Failing to verify exported file name, format, and location.

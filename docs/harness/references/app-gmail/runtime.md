# Gmail App Rules

Use this reference before Gmail phases.

## Core Rules

- Identify the target thread by visible subject, sender, date, label, and message snippet before acting.
- Separate reading, drafting, saving a draft, and sending.
- A generated reply is not a saved draft, and a saved draft is not a sent message.
- Review To, Cc, Bcc, subject, body, and attachments before sending or forwarding.
- Ask for approval before sending, forwarding, deleting, unsubscribing, or batch-moving messages.
- Validate final state through Gmail-visible state: draft marker, Sent, label, archive, trash, thread, or attachment names.

## Stop Conditions

- Multiple threads match the target.
- The current mailbox or workspace cannot be confirmed.
- Required recipient, subject, body, attachment, or user instruction is missing.
- Thread context, attachments, or final Gmail state cannot be read back.

## Common Mistakes

- Replying to a new message instead of the correct thread.
- Sending when the workflow only asked for a draft.
- Selecting the first search result when several threads match.
- Treating a closed compose window as proof that the draft was saved or sent.

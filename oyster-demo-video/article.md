# OysterWorkflow Demo Source Notes

Source: `codex://threads/019ed2ba-d31c-7d22-a6de-cea83c2e07b5`

## Demo Goal

Create an English spoken demo for OysterWorkflow. The video should show that OysterWorkflow trains AI workers by watching a real human workflow, extracting the decision logic, installing that workflow to an AI worker, assigning it to a laptop, and letting it continue work while the founder steps away.

## Core Story

- Alex introduces the idea of training AI versions of himself.
- The opener shows Marketing Worker, Product Worker, Finance Worker, and Sales AI Worker as different AI workers.
- The main demo trains Sales AI Worker on a real workflow: qualifying an inbound opportunity.
- The human demonstrates how he checks whether an inquiry is legitimate before replying.
- OysterWorkflow captures actions, screen context, voice notes, and inferred workflow logic.
- The workflow includes sender/domain checks, request specificity, internal case search, engineering feasibility approval, safe customer reply drafting, tracker creation, priority, and follow-up.
- OysterWorkflow detects the workflow and shows it as installable.
- The detected workflow is installed to Sales AI Worker.
- After installation, the latest workflow should appear at the top of Installed workflows with `Runs` and `Success` both at `0`, and `Last run` as `Not run yet`.
- `Trigger` should not appear in the Installed workflows table.
- Sales AI Worker is assigned to `Alex's MacBook Pro`.
- The device can work through a runtime queue while idle and pause when Alex returns.
- Command channels include WeChat and email-style command intake.
- External replies require approval before sending.

## Current Demo UI Details

- Main navigation: `AI workers`, `Workflows`, `Devices`.
- Selected worker: `Sales AI Worker`.
- Existing installed sales workflows:
  - `Extract action items from customer meeting`
  - `Track unanswered customer questions`
  - `Prepare NDA handoff`
  - `Check funding and company news`
  - `Update deal stage from email thread`
  - `Create onboarding handoff`
- Detected workflow examples:
  - `Qualify Outlook inbound inquiry and draft follow-up`
  - `Prepare follow-up tracker`
  - `Route feasibility request`
  - `Draft client reply safely`
- Important detected workflow screen details:
  - `94%` confidence
  - `Installable`
  - workflow logic includes six steps
  - Step 4 is `Ask engineering for feasibility`
  - external reply should require approval
- Device screen:
  - selected device: `Alex's MacBook Pro`
  - assigned worker: `Sales AI Worker`
  - runtime mode: `Think when idle`
  - queue includes reviewing inbox, preparing tracker, and holding external replies for approval

# OysterWorkflow self-evolving graph presentation

## Artifact

- Format: standalone HTML presentation with animation controls.
- Canvas: 1920 x 1080, scaled without distortion to the current viewport.
- Audience: investors, early customers, and product partners.
- Mode: branded extension of the existing OysterWorkflow product.

## Brand assets

- Product icon: `assets/oysterworkflow-icon.png`
  - Source: `desktop/assets/app-icon.png`
- Sales canonical graph screenshot: `assets/sales-canonical-workflow.png`
  - Source: `.runs/package-replace-codex-20260712-workflow-graph-visual-fix-v1/evidence/final-sales-canonical.png`
- YC canonical graph screenshot: `assets/yc-canonical-workflow.png`
  - Source: `.runs/package-replace-codex-20260712-workflow-graph-visual-fix-v1/evidence/final-yc-canonical.png`

## Design tokens

- Background: `#f4f7f7`
- Surface: `#fefefe`
- Surface soft: `#f8fbfb`
- Border: `#dfe7e7`
- Text: `#0f172a`
- Muted text: `#64748b`
- Brand accent: `#007b78`
- Decision semantic: `#b77900`
- Wait semantic: `#3569d4`
- Terminal semantic: `#c2413d`
- Display and body: Avenir Next with Segoe UI fallback
- Machine labels: SFMono-Regular with Consolas fallback

## Shape and motion grammar

- Semantic graph nodes use a consistent 16px radius.
- Playback controls use a pill shape because they are transient controls, not graph objects.
- Motion only explains causality: a case arrives, a route is proposed, a node is reused, or a canonical revision changes.
- No ambient particles, neon glow, decorative status dots, or perpetual movement.
- Reduced motion keeps every scene readable and disables automatic movement.

## v0 assumptions

- Five scenes are enough to validate the story before building the full timeline.
- Chinese is the default language; English is available from the persistent language control.
- The final scene labels Graph Runner as the next execution layer, because the current product packages the graph for Agent guidance but does not yet drive every node from Runtime.

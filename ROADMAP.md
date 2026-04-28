# OysterWorkflow Roadmap

OysterWorkflow is exploring workflow-to-capability infrastructure: turning real human computer workflows into reviewable, reusable agent capabilities.

This roadmap is directional. It is not a commitment to ship every item or to ship them in this exact order.

## Current Release

- macOS desktop app for Apple Silicon
- workflow evidence capture from screen activity, OCR text, UI events, input traces, window state, and optional narration
- candidate workflow review
- OpenClaw skill artifact generation
- skill installation into OpenClaw-discoverable folders
- public noncommercial release through GitHub Releases

## Near-Term Focus

- reduce macOS installation and permission friction
- improve the clarity of recorder and review states
- make generated skill artifacts easier to inspect and compare
- collect high-quality examples of real workflows people want to capture
- improve feedback loops around where generated steps are useful or wrong

## Developer and Integration Direction

OpenClaw skill artifacts are the first runtime target, not the final boundary of the product.

Future work may explore:

- clearer artifact schemas and examples
- better export and review surfaces
- partial source, SDK, or integration surfaces for developers
- quality evaluation loops for generated capabilities
- additional runtimes beyond OpenClaw where the artifact model makes sense

The source code is currently private. Any future opening of source code, SDKs, or integration layers will be announced separately.

## Feedback Wanted

The most useful feedback right now:

- what workflow you tried to capture
- where the product felt confusing or untrustworthy
- what the generated artifact got right or wrong
- what integration surface would make this useful in your own agent stack
- what would make you comfortable using this for real repetitive work


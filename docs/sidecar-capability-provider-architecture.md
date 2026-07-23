# Sidecar Capability Provider Architecture

## Purpose

OysterWorkflow should treat local executables such as Screenpipe, Hermes, and
BrowserAct as managed sidecars, but not all sidecars have the same role.
Screenpipe and Hermes are required runtime foundations. BrowserAct-like tools
are optional capability providers that can be plugged into the AI worker when a
workflow needs a browser execution surface.

The goal is to make browser, desktop, terminal, and connector capabilities feel
hot-swappable without polluting the global Agent skill namespace.

## Current Baseline

### Screenpipe

Screenpipe is a required recorder sidecar. It is packaged as a local binary and
managed by the runtime service. The app starts or reuses a local Screenpipe
process, probes health over HTTP, and records process state, ports, tokens, and
logs in session/runtime state.

Screenpipe is not an Agent skill. It is a local data capture service owned by
OysterWorkflow.

### Hermes

Hermes is a required AI worker sidecar. It is packaged from a managed fork and
launched through the `WorkerExecutor` adapter. Hermes owns Agent turns, skill
installation, worker profiles, progress events, and AI output.

Hermes is the reasoning/execution worker, not the owner of every low-level local
capability. Browser and desktop surfaces should be attached to Hermes through
controlled capability adapters.

### BrowserAct

BrowserAct should be introduced as an optional browser capability provider. It
can supply `chrome-direct`, browser sessions, `state`, screenshots, JavaScript
evaluation, and network inspection through the `browser-act` CLI. It should not
be installed as a global Agent skill bundle and should not inject its whole
solutions catalog into Hermes or Codex.

## Core Model

Use three separate concepts:

1. Sidecar: a managed local dependency with its own version, installation,
   health check, logs, and runtime data directory.
2. Capability provider: a sidecar-backed implementation of a stable
   OysterWorkflow capability such as browser control.
3. Worker executor: the AI worker that reads a skill/harness and asks for
   capabilities through OysterWorkflow-controlled APIs.

```text
Generated Skill / Harness
  -> declares required capabilities
Hermes WorkerExecutor
  -> calls OysterWorkflow allowlisted capability tools
Capability Registry
  -> selects a provider
BrowserAct Provider Sidecar
  -> calls browser-act CLI
User Chrome / BrowserAct browser
```

## Directory Ownership

Desktop mode should keep sidecar state under the app data root instead of user
global Agent directories.

Recommended macOS layout:

```text
~/Library/Application Support/oysterworkflow/
  hermes/
    profiles/
    skills/
  sidecars/
    browseract/
      manifest.json
      runtime/
      skills/
      logs/
      tmp/
  runs/
```

BrowserAct solution skills should only live under the BrowserAct provider area
or a per-run isolated skill root. They should not be copied into
`~/.codex/skills`, `~/.hermes/skills`, or another executor-wide discovery path
unless the user explicitly asks for that global installation.

## Capability Registry

Each provider should expose a manifest that the runtime service can read.

Example:

```json
{
  "id": "browseract.chrome-direct",
  "provider": "browseract",
  "kind": "browser",
  "version": "1.0.4",
  "source": {
    "cliPackage": "browser-act-cli",
    "cliVersion": "1.0.4",
    "skillsRepository": "https://github.com/browser-act/skills",
    "skillsCommit": "d99cac3"
  },
  "capabilities": [
    "browser.open",
    "browser.navigate",
    "browser.state",
    "browser.evalReadOnly",
    "browser.screenshot",
    "browser.close"
  ],
  "permissions": [
    "uses_real_chrome_profile",
    "reads_authenticated_page_content"
  ],
  "riskLevel": "high"
}
```

The registry should answer two questions:

- Is a provider installed and healthy?
- Is this provider allowed for the current workflow, user setting, and risk
  level?

## Wrapper Contract

Generated skills and harnesses should not call raw `browser-act` commands.
They should request an OysterWorkflow-owned browser surface. The distinction is
important: the harness may be provider-agnostic, but it must not be
tool-agnostic. If it only says "use a browser capability", Hermes may choose its
own browser or Computer Use surface and bypass the product's provider registry,
permission gates, and logging.

Initial browser wrapper:

```ts
interface BrowserCapability {
  open(input: { session: string; url: string }): Promise<BrowserResult>;
  navigate(input: { session: string; url: string }): Promise<BrowserResult>;
  state(input: { session: string }): Promise<BrowserResult>;
  click(input: {
    session: string;
    index: string | number;
  }): Promise<BrowserResult>;
  hover(input: {
    session: string;
    index: string | number;
  }): Promise<BrowserResult>;
  input(input: {
    session: string;
    index: string | number;
    text: string;
  }): Promise<BrowserResult>;
  select(input: {
    session: string;
    index: string | number;
    option: string;
  }): Promise<BrowserResult>;
  upload(input: {
    session: string;
    index: string | number;
    filePath: string;
  }): Promise<BrowserResult>;
  keys(input: { session: string; keys: string }): Promise<BrowserResult>;
  scroll(input: {
    session: string;
    direction?: "up" | "down";
    amount?: string | number;
  }): Promise<BrowserResult>;
  wait(input: {
    session: string;
    mode?: "stable" | "selector";
    index?: string | number;
    selector?: string;
    state?: string;
    timeoutMs?: number;
  }): Promise<BrowserResult>;
  eval(input: { session: string; script: string }): Promise<BrowserResult>;
  screenshot(input: {
    session: string;
    path?: string;
    full?: boolean;
  }): Promise<BrowserResult>;
  get(input: {
    session: string;
    contentType?: "title" | "html" | "markdown" | "text" | "value";
    index?: string | number;
  }): Promise<BrowserResult>;
  networkRequests(input: {
    session: string;
    filter?: string;
    resourceType?: string;
    method?: string;
    status?: string;
    clear?: boolean;
  }): Promise<BrowserResult>;
  networkRequest(input: {
    session: string;
    requestId: string | number;
  }): Promise<BrowserResult>;
  close(input: { session: string }): Promise<BrowserResult>;
}
```

The BrowserAct provider implements this interface by spawning `browser-act`.
Hermes sees the stable wrapper, not the raw CLI. This keeps Hermes independent
from BrowserAct command syntax and lets the product replace BrowserAct later
with Codex Chrome, Playwright, Computer Use, or another provider.

## Binding Into Hermes

Hermes must receive a concrete OysterWorkflow browser tool surface for browser
workflows. The binding should happen before the Hermes turn starts.

Preferred tool namespace:

```text
oyster.browser.open
oyster.browser.navigate
oyster.browser.state
oyster.browser.eval_readonly
oyster.browser.screenshot
oyster.browser.close
```

The service can implement that namespace through a native Hermes tool, local MCP
server, local HTTP API, or a narrow CLI wrapper such as `oyster-browser`. The
implementation detail can change, but the visible tool contract should remain
OysterWorkflow-owned.

Hermes should not be launched with a competing generic browser surface for a
workflow that is explicitly bound to `oyster.browser.*`, unless that surface is
wrapped by the same provider registry and policy layer. If disabling competing
tools is not possible, the harness and system prompt must explicitly say:

```text
For browser actions, use only the OysterWorkflow browser tools
(`oyster.browser.*`). Do not use Hermes built-in browser, Computer Use,
Playwright, shell browser commands, or direct BrowserAct commands unless the
OysterWorkflow browser tool reports that it delegated to that provider.
```

## Teaching Hermes Tool Usage

OysterWorkflow needs its own equivalent of BrowserAct `get-skills core`, but it
should teach Hermes the OysterWorkflow tool surface, not provider-private
commands. Hermes should learn how to use `oyster.browser.*`; the BrowserAct
adapter should learn how to translate those calls into `browser-act` CLI or API
operations.

Use three artifacts:

1. Machine contract: a manifest or JSON schema for each exposed tool, including
   name, input schema, output schema, idempotency, timeout behavior,
   and stable error codes.
2. Agent usage guide: a concise Markdown instruction block injected into the
   Hermes turn or installed into a per-run isolated skill root. This guide tells
   Hermes when to use the tool, the normal call sequence, examples, forbidden
   fallbacks, and the current `allow_all` browser policy.
3. Runtime context: a per-run payload generated by the service layer, including
   selected provider, browser identity, visibility mode, active session IDs,
   output paths, and current run policy.

Example agent-facing guide:

```text
You have access to OysterWorkflow browser tools.
Use only `oyster.browser.*` for browser actions in this workflow.

Normal lifecycle:
1. `oyster.browser.open` with the requested URL and identity.
2. `oyster.browser.state` or `oyster.browser.eval_readonly` to inspect the page.
3. Use interactive browser tools through the OysterWorkflow wrapper when the
   workflow calls for them.
4. Verify the result with `state`, `eval_readonly`, or `screenshot`.
5. `oyster.browser.close` when the browser session is no longer needed.

Never call raw BrowserAct, Playwright, shell browser commands, Hermes built-in
browser tools, or Computer Use for browser actions unless the OysterWorkflow
runtime explicitly exposes them through `oyster.browser.*`.
```

The `WorkerExecutor` should render and inject only the usage guides required by
the current harness. A workflow that needs browser use receives the browser
guide; a workflow that only needs Screenpipe analysis should not receive browser
instructions. This keeps the tool surface hot-swappable and avoids global skill
pollution.

Provider-specific documentation has a different audience. BrowserAct
`get-skills core` and solution skills can guide the BrowserAct provider
implementation, or be converted into approved OysterWorkflow rule packs, but
they should not be passed directly to Hermes as global instructions. If the
provider changes later, the Hermes-facing guide remains stable while only the
adapter changes.

## Simplest MVP

The first implementation should prove the contract before building a full
plugin system.

Scope:

1. One provider: BrowserAct `chrome-direct`.
2. One identity mode: the user's current Chrome profile.
3. One narrow wrapper: `oyster-browser` or an equivalent local service method.
4. One injected usage guide: a static browser guide rendered by
   `WorkerExecutor` only when the harness declares browser use.
5. Full browser operations from the start: open, navigate, state, click, input,
   select, upload, eval, screenshot, network inspection, wait, and close.

Non-goals for the MVP:

- No daemon sidecar unless CLI startup or cancellation becomes a real problem.
- No full provider marketplace. The first UI is only a Settings Applications
  section with a manual Chrome check.
- No global installation of BrowserAct solution skills.
- No arbitrary raw `browser-act` commands visible to Hermes.
- No permission tier system in the MVP. Enabling a BrowserAct-backed browser
  workflow means `allow_all` browser operation through the wrapper.

If Hermes cannot receive native tools yet, the wrapper can temporarily be a
single allowlisted CLI with JSON input and JSON output. Hermes receives the
usage guide for that CLI, while the CLI internally calls BrowserAct. This is
less elegant than a native tool or MCP server, but it keeps the provider hidden
behind the OysterWorkflow contract and is enough to validate behavior.

## Full-Permission Browser Policy

The MVP does not split browser actions into `read_only`, `interactive`, and
`external_action` levels. When a workflow is bound to the BrowserAct provider,
Hermes receives full browser-operation permission through the OysterWorkflow
wrapper.

Allowed through the wrapper:

- Open and navigate pages.
- Read state, title, text, HTML, Markdown, values, screenshots, and network
  requests.
- Click, hover, type, select, upload, scroll, send keys, and wait.
- Run page JavaScript through the wrapper.
- Complete workflow actions, including submits or sends, when the installed
  workflow asks for them.

This is still not arbitrary shell access. Hermes should receive only the
OysterWorkflow wrapper command, not raw `browser-act`, Playwright, Computer Use,
or unrestricted terminal instructions for browser work. The wrapper remains the
auditing and provider-isolation boundary.

## Chrome-Direct Readiness Finding

BrowserAct `chrome-direct` does not copy cookies into a new browser. Its desired
identity model is live attachment to the user's local Chrome session, so logged
in state is inherited only when BrowserAct can successfully attach to that
running Chrome profile.

On the first 2026-07-06 macOS verification run, Hermes correctly called the
OysterWorkflow wrapper and the wrapper called BrowserAct, but BrowserAct could
not attach to the default Chrome profile. The observed Chrome process was Chrome
149, BrowserAct was `browser-act-cli@1.0.4`, and local CDP probing showed
`http://127.0.0.1:9222/json/version` was not available for the default profile.
Chrome 136+ hardens default-profile remote debugging, so a provider can no
longer assume `chrome-direct` against the user's default profile is healthy on
every machine. Primary reference:
`https://developer.chrome.com/blog/remote-debugging-port`. A comparable
default-profile attach failure is tracked for Chrome DevTools MCP at
`https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1830`.

A same-day retest showed the provider can recover without code changes:
BrowserAct `chrome-direct` successfully opened YC, reached Startup School
Co-Founder Matching with the user's logged-in account, opened the next candidate
profile, and the packaged OysterWorkflow run succeeded through
`$OYSTER_BROWSER_CLI`. Treat this as a transient provider-health risk rather
than a permanent impossibility.

A follow-up consent test on 2026-07-06 showed that Chrome remote-debugging user
approval is not required for every BrowserAct session once the current Chrome
profile has already persisted consent. On this machine,
`devtools.remote_debugging.user-enabled` was `true` in Chrome `Local State`; a
fresh BrowserAct `chrome-direct` session opened and read `https://example.com`
without another user click, and killing/restarting the BrowserAct command/session
daemons still did not require another click. The same test also showed that
`http://127.0.0.1:9222/json/version` returned HTTP 404 while BrowserAct itself
worked, so product readiness should use a real BrowserAct
`open -> state -> close` probe instead of relying only on the bare CDP HTTP
endpoint.

The cases not yet tested, because they would interrupt the user's browser or
change Chrome profile state, are a full Chrome quit/restart cycle and resetting
the persisted Chrome remote-debugging consent flag. Product copy should describe
the expected approval prompt as a first-use, profile-reset, new-profile,
new-machine, or Chrome-policy-reset event, not as a per-workflow or per-session
requirement.

Product consequence:

- BrowserAct can remain the MVP browser provider, but Chrome readiness should be
  checked by a user-triggered Settings action, not by an automatic step before
  every workflow run.
- A BrowserAct-bound run should fail with a clear provider-health diagnostic
  instead of silently switching Hermes to Computer Use, Playwright, or built-in
  browser tools.
- The product-visible name is Chrome. BrowserAct remains an internal provider
  implementation name for adapters, tests, and engineering docs.
- If signed-in local Chrome remains required, the long-term provider may need a
  BrowserAct upstream/fork fix, a Chrome live-session connector, or an
  extension/native-messaging bridge.
- A non-default automation profile is a fallback for provider health, but it
  changes the login-state inheritance story and should not be described as
  "using the user's current browser" unless profile/session migration is
  explicitly implemented and approved.

## Generated Skill And Harness Behavior

Generated skills should express capability needs and the required
OysterWorkflow tool surface, not provider names, unless the workflow truly
depends on a specific provider.

Preferred harness language:

```text
This workflow requires the OysterWorkflow browser tool surface with the user's
logged-in Chrome identity. Use only `oyster.browser.*` for browser actions. The
runtime may implement those tools with BrowserAct chrome-direct, Codex Chrome,
Playwright, or another approved provider. For BrowserAct-bound MVP runs, the
browser policy is `allow_all`.
```

Avoid:

```bash
browser-act --session s click 3
```

The harness can still include provider-specific notes in a runtime section, for
example "BrowserAct chrome-direct is the preferred provider when available",
but the execution protocol should remain capability-based.

## BrowserAct Solution Skills

BrowserAct solution skills are useful as a catalog of website-specific methods,
but they should not be globally installed.

Use them in one of three controlled ways:

1. Reference-only: read a solution package as implementation guidance while
   generating a workflow-specific harness.
2. Per-run injection: copy one approved solution into an isolated skills root
   for a single run.
3. Provider-owned package: keep approved solution packages under
   `sidecars/browseract/skills/` and expose them through the provider registry.

Do not install the full solutions catalog into Hermes or Codex global skill
roots. That would pollute skill discovery and cause unrelated tasks to trigger
third-party website skills.

## Fork And Pin Policy

Forking is not the first step for every provider. Pinning is required; forking is
conditional.

Always pin:

- CLI/package version.
- Git commit for any skill or solution repository used as source material.
- Hashes for downloaded binaries or wheels when we bundle them.
- A generated sidecar manifest in packaged builds.

Fork when at least one is true:

- We need to patch provider behavior or expose a stable machine API not
  available upstream.
- We need to redistribute source as part of the desktop package with an auditable
  commit history.
- We need to remove unsafe default behavior, change confirmation semantics, or
  harden logging.
- Upstream release cadence or dependency resolution is too unstable for desktop
  distribution.

For BrowserAct specifically, forking `browser-act/skills` alone does not pin the
runtime, because the actual CLI comes from `browser-act-cli`. If we need runtime
changes, we need a runtime fork or a wrapper layer. If we only need selected
solution instructions, a commit-pinned skills repository is enough.

## Packaging Stages

Stage 1: external managed install.

- Use `uv tool install browser-act-cli --python 3.12` into a provider-owned
  runtime area.
- Record the CLI version in `manifest.json`.
- Do not install BrowserAct website solution skills in this stage. If those
  skills are adopted later, record the pinned skills repository commit in a
  separate provider-owned catalog manifest.
- Good for validating product design quickly.

Stage 2: bundled installer.

- Bundle a launcher similar to Hermes.
- Prefer a pinned wheel or source seed.
- Install into the provider-owned sidecar runtime on first use.

Stage 3: daemon sidecar.

- Add a long-running local service only if command startup, streaming progress,
  cancellation, or concurrent sessions require it.
- Until then, an on-demand CLI wrapper is simpler and easier to audit.

## Composio Cloud Integration Provider

Composio is a remote integrations provider, not a local daemon sidecar. It uses
the same provider registry and product status model, while owning a different
execution boundary:

- Runtime stores the optional API key locally with owner-only permissions
  (`.runs/config` in development, the app user-data directory on desktop) and
  never returns the cleartext key to the renderer.
- One stable Composio external user id is derived from the current
  workspace/account identity, so the Connections UI and Hermes resolve the same
  connected accounts.
- The adapter creates or reuses a hosted MCP session. The session intentionally
  omits toolkit, tool, and tag filters and does not use the direct-tools preset.
- Dynamic discovery, manage-connections meta tools, the full toolkit catalog,
  hosted MCP, and the remote sandbox remain enabled.
- Hermes receives the hosted MCP URL and headers through its per-worker
  `mcp_servers.composio` profile configuration immediately before a turn.
- OAuth authorization is opened only through an HTTPS desktop bridge. Runtime
  owns authorization creation, polling, ownership checks, and disconnect.

The UI catalog must be server-driven and cursor-paginated. Application names,
logos, connection status, and future additions come from Composio; OysterWorkflow
must not maintain a product whitelist. Chrome remains a separate local provider
because signed-in browser control and cloud API integrations have different
identity, health, and execution semantics.

## Implementation Sketch

1. Add a `CapabilityProvider` registry in the product service layer.
2. Add a `BrowserCapability` interface with full browser operation methods.
3. Implement `BrowserActBrowserProvider` as an on-demand CLI wrapper.
4. Add a Settings Applications section that shows the Chrome provider and runs a
   user-triggered `open -> state -> close` check.
5. Inject a full-permission Chrome browser usage guide into Hermes for browser
   workflows. The guide may be implemented by BrowserAct internally, but Hermes
   should use the OysterWorkflow browser surface.
6. Let Hermes call only the OysterWorkflow wrapper tool, not raw shell.
7. Update harness generation so browser workflows declare capability needs:
   `surface=browser`, `needsLoggedInState=true`, and
   `preferredIdentity=user_chrome`.
8. Add the Composio remote integrations adapter with unrestricted session
   defaults and inject its hosted MCP endpoint into Hermes worker profiles.
9. Evolve Settings Applications into a generic high-density connection manager
   while retaining provider-specific diagnostics for local Chrome.

## Open Questions

- Whether BrowserAct should remain an optional provider or become the preferred
  browser provider for all logged-in browser workflows.
- Whether BrowserAct solution packages should be converted into OysterWorkflow
  harness rule packs, kept as provider-owned packages, or both.
- Whether `chrome-direct` can be made healthy against the user's real signed-in
  Chrome profile, or whether OysterWorkflow needs a different signed-in Chrome
  provider for this identity mode.
- Whether the first Settings Applications section should evolve into a generic
  provider manager shared by Screenpipe, Hermes, Chrome, and future providers.
- Whether future cloud providers should expose the same catalog/authorization
  interface as Composio or remain separately modeled adapters behind the shared
  capability registry.

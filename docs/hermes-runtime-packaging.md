# Hermes Runtime Packaging

OysterWorkflow packages Hermes Agent from our managed fork instead of pulling
an unpinned upstream version during desktop builds.

## Source of Truth

- Fork: `https://github.com/ShuxinYang111/hermes-agent`
- Upstream: `https://github.com/NousResearch/hermes-agent`
- Submodule: `vendor/hermes-agent`
- Packaging config: `config/hermes-bundle.config.json`

`npm run build:hermes` uses the submodule by default. The submodule commit
recorded by the parent OysterWorkflow repository is the only version lock.

The generated `out/bundled/hermes/hermes-bundle.json` records the packaged
Hermes version, commit, commit date, fork, and upstream. This makes each
desktop build traceable after packaging without keeping a second version pin.

## Upgrade Flow

1. Sync `ShuxinYang111/hermes-agent` from upstream.
2. Update `vendor/hermes-agent` to the commit we want to ship.
3. Commit the parent repository's submodule pointer change.
4. Run `npm run build:hermes`.
5. Verify `out/bundled/hermes/hermes-bundle.json` points to the intended
   commit.

For temporary local experiments, `OYSTERWORKFLOW_HERMES_SOURCE_PATH` can point
the bundle builder at a different Hermes checkout. Official desktop builds
should use the pinned submodule path.

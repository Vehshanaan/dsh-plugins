# dsh-plugins

Plugin collection for this `deepseek-harness` checkout. It lives inside the checkout root so plugin sessions keep the harness `AGENTS.md` conventions and dsh skills, but it is an independent git repo; the parent repo never tracks it (see the parent's `.git/info/exclude`).

## Load

Plugins load through `cordis.yml` patches with absolute paths. Run the Web UI from the checkout root:

```sh
pnpm dsh web --patch ./dsh-plugins/cordis.yml
```

## Plugins

- `automode-guardrail/` — automatic instruction classifier guardrail for full-access sessions, in the spirit of Claude Code's automode. Currently a loadable stub; the implementation lands in a separate agent session.

## TypeScript

Each plugin's `tsconfig.json` maps `@deepseek-ai/cordis` to `vendor/cordis/src` via relative `paths`, so editor type-checking works without `pnpm install` links. Runtime imports of harness packages (`Service`, `ctx.tools`, …) need a resolution strategy — a bundle-form package or a dependency link — which the implementing session should decide.

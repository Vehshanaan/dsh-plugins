# dsh-plugins

Plugin collection for this `deepseek-harness` checkout. It lives inside the checkout root so plugin sessions keep the harness `AGENTS.md` conventions and dsh skills, but it is an independent git repo; the parent repo never tracks it (see the parent's `.git/info/exclude`).

## Load

Plugins load through `cordis.yml` patches with absolute paths. Build the guardrail first, then run the Web UI from the checkout root:

```sh
corepack pnpm install      # in dsh-plugins/ (dev deps + peers)
corepack pnpm run build    # in dsh-plugins/automode-guardrail → dist/
pnpm dsh web --patch ./dsh-plugins/cordis.yml
```

The npm/npx launcher works unchanged — the patch points at the built `dist/index.js`, and the plugin resolves its harness imports from the profile's own dependency tree.

## Plugins

- `automode-guardrail/` — automatic instruction-safety guardrail for full-access sessions, in the spirit of Claude Code's auto mode: hard-rule guard plus an optional LLM classifier screening every tool call while the session runs in `danger-full-access` mode. See its [README](automode-guardrail/README.md) and the reviewable [implementation plan](automode-guardrail/IMPLEMENTATION-PLAN.md).
- `btw/` — Claude Code style `/btw` side questions: ask a question that never enters the main conversation history, answered by a fresh tool-less side subagent. See its [README](btw/README.md).

## TypeScript

Each plugin's `tsconfig.json` maps `@deepseek-ai/*` imports to the checkout's `packages/*/src` via relative `paths`, so editor type-checking, `tsc --noEmit`, and vitest work without building the harness. Runtime resolution is the profile's own tree (peer dependencies), never the repo's. btw/ 例外：@deepseek-ai/* 通过 
ode_modules/@deepseek-ai junction 解析到 $DSH_HOME/profiles/node_modules（与运行中的 dsh 安装版共享同一套依赖），类型检查亦然。
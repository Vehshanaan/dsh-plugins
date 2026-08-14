# automode-guardrail

English | [中文](README.zh.md)

Automatic instruction-safety guardrail for full-access sessions: when a session runs in an armed sandbox mode (default `danger-full-access`, where the file sandbox restricts nothing), every tool call is screened before execution. The plugin is a policy control, not a security boundary — a false `allow` executes the call.

Two layers:

- **Hard rules** — a synchronous, monotonic, deny-only guard (`ctx.tools.guard`) matches shell commands (`bash`, `pwsh`) against irreversible-catastrophe signatures: recursive deletes of filesystem roots, the home directory, the workspace root, or a root glob; raw-device writes (`dd of=/dev/…`); `mkfs`; `format <drive>:`; `diskpart clean`; and machine teardown (`shutdown`, `reboot`, `Restart-Computer`, …). A guard denial cannot be overridden by any `tools/pre-execute` listener.
- **LLM classifier** (optional) — an outermost `tools/pre-execute` listener judges every remaining call against a framed JSON input (tool name, full arguments, up to 20 summarized recent human messages and tool calls, and the standing sandbox policy). `allow` delegates; `deny` short-circuits the pipeline with a reason the model receives as the tool error. Any classifier failure — timeout, provider error, invalid reply — denies (fail closed).

The fixed read-only tool set (`read`, `glob`, `grep`, `read_image`, `job_output`, `job_list`, `todo_write`, `get_goal`, `list_agents`, `skill`, `ask_user_question`, `exit_plan_mode`) skips classification; the hard rules still apply. `skip` extends the set.

## Config

```yaml
config:
  modes: ['danger-full-access']   # sandbox modes that arm the guardrail
  skip: []                        # extra read-only tool names
  classifier:                     # omit for the rules-only mode
    provider: deepseek-official   # registered LLM provider route
    model: deepseek-v4-flash      # exact model id
    maxInputBytes: 12000          # UTF-8 bytes of the framed input
    maxOutputTokens: 200          # auxiliary output-token cap
    timeoutMs: 5000               # end-to-end classification deadline
```

Misconfiguration fails loud at load: unknown modes, empty `skip` entries, invalid classifier budgets, or a configured classifier without a composed LLM service all throw. The hard-rule table and the fixed skip set are security invariants — not configurable.

## Denial text

A denial reaches the model as the tool error:

```
Error: auto-safety guardrail denied bash (destructive): recursive delete (rm with -r and -f) targeting a filesystem root, the home directory, the workspace root, or a root glob
```

Decision metadata (rule id, verdict category, classifier route and input size) is written to the host logger. The plugin appends no session event types of its own, so harness builds that do not know this plugin still read the session logs; the model-visible denial text is already reconstructable from the ordinary `tool/result` event the tools pipeline writes.

## Loading

Build, then point a profile patch at the built entry (the launcher stays the same):

```sh
corepack pnpm install && corepack pnpm run build
dsh --profile web --patch ./dsh-plugins/cordis.yml
```

or install the packed package into a profile (`dsh plugin --profile web add ./automode-guardrail-0.1.0.tgz`) and add `automode-guardrail` to the profile patch. Harness packages are peer dependencies: the plugin resolves them from the profile's own tree, so it always shares one instance with the runtime.

## Model Experience

### Request context: guardrail-active notice

#### What the model sees

While the session's effective sandbox mode is armed, the runtime-context snapshot gains one sentence:

```markdown
Auto-safety guardrail active: this session runs with unrestricted file access, and tool calls are screened before execution. Denied calls return a reason — adapt with a different approach instead of re-issuing the denied call.
```

#### Token effect

One fixed sentence per request while armed; zero tokens while unarmed.

#### KV Cache effect

Append-only after retained history; armed/unarmed switches change only this contribution, preserving the stable system prompt prefix.

### Tool outcome: denials

#### What the model sees

A denied call returns an `isError` tool result whose message is the denial text above. The classifier reply itself never reaches the model.

#### Token effect

One error message per denied call; allowed calls add no classifier-derived tokens.

#### KV Cache effect

Append-only; denials surface as ordinary tool results and do not rewrite earlier request prefixes.

## Known Limitations and Deferred Work

- **Policy control, not a security boundary** — a false `allow` executes the call; the classifier cannot contain what the OS would. Calibrate with the eval set in `IMPLEMENTATION-PLAN.md` and prefer keeping machine-level sandboxing wherever the deployment allows it.
- **No escalation to a human** — the classifier only allows or denies. A denial is final for that call; the model adapts (ask/escalate routing to the approval seam is deferred until an interactive full-access deployment needs it).
- **No decision caching** — repeated calls of the same shape each pay one classifier round trip. A per-turn verdict cache is deferred.
- **No custom session events** — the harness defers a registration surface for out-of-repo plugin event types, so decision metadata lives in host logs only; post-hoc review uses log correlation, not session replay.
- **Classifier summaries omit assistant text and tool results** — scope judgment uses the recent human messages and tool calls only, which keeps the input bounded at the cost of less context.
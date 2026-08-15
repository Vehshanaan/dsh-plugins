/**
 * Pure types of the auto-safety guardrail — no runtime code.
 * @module automode-guardrail/types
 */

import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/** LLM classifier route and budgets. Omitting `classifier` from the plugin config runs the rules-only mode. */
export interface ClassifierConfig {
  /** Registered LLM provider route. */
  provider: string
  /** Exact model id served by that provider. */
  model: string
  /** Maximum UTF-8 bytes of the framed classification input (default 12000). */
  maxInputBytes?: number
  /** Auxiliary output-token cap (default 1024). */
  maxOutputTokens?: number
  /** Thinking effort for the classifier call (default `off` — verdicts are short; reasoning wastes the budget). */
  reasoningEffort?: 'off' | 'high' | 'max'
  /** Cap in UTF-8 bytes for string argument fields sent to the classifier; larger fields become a head/tail marker (default 2000). */
  maxArgumentFieldChars?: number
  /** End-to-end classification deadline in milliseconds (default 5000). */
  timeoutMs?: number
  /**
   * Retries after a transient classifier failure — unparseable reply,
   * deadline, or provider error. Each attempt gets a fresh deadline; the
   * caller's abort is never retried (default 1, range 0-3).
   */
  retries?: number
}

/** One deterministic policy rule: a pattern evaluated before the classifier. */
export interface PolicyRuleConfig {
  /**
   * Regular expression matched case-insensitively against the normalized
   * shell command for `shellTools`, and against the bare tool name for every
   * other tool.
   */
  match: string
  /** Model-visible denial reason (deny rules; defaults to the match text). */
  reason?: string
  /** Restrict the rule to these tool names; omitted applies to every tool. */
  tools?: string[]
}

/** Plugin config, validated by the `Config` schemastery schema plus the fail-loud checks in `apply`. */
export interface GuardrailConfig {
  /** Sandbox modes that arm the guardrail (default: `['danger-full-access']`). */
  modes?: SandboxMode[]
  /** Extra read-only tool names exempt from classification; the fixed read-only set and the hard rules always apply. */
  skip?: string[]
  /**
   * Tool names whose `command` argument the hard rules and the read-only
   * command fast path inspect (default `['bash', 'pwsh']`). Extend when
   * another tool surfaces a shell command.
   */
  shellTools?: string[]
  /**
   * Skip LLM classification for `write`/`edit` calls whose target resolves
   * inside the workspace root and is not a sensitive file name (default
   * `true`). Hard rules still apply.
   */
  workspaceWriteFastPath?: boolean
  /**
   * Skip LLM classification for single, purely read-only shell commands —
   * metadata listings and status queries with no separators, pipes,
   * redirections, substitutions, or sensitive targets (default `true`).
   * Hard rules still apply.
   */
  readOnlyCommandFastPath?: boolean
  /** LLM classifier; omitted runs the rules-only mode. */
  classifier?: ClassifierConfig
  /**
   * Deterministic deny rules evaluated after the hard rules and before the
   * classifier; a hit denies with the rule's reason. User-owned policy — can
   * never override the hard rules.
   */
  denyRules?: PolicyRuleConfig[]
  /**
   * Deterministic allow rules evaluated after the hard rules and before the
   * classifier; a hit skips classification. User-owned policy — can never
   * override the hard rules.
   */
  allowRules?: PolicyRuleConfig[]
}

/** Config after validation and defaulting — every optional field materialized. */
export interface ResolvedClassifierConfig {
  provider: string
  model: string
  maxInputBytes: number
  maxOutputTokens: number
  reasoningEffort: 'off' | 'high' | 'max'
  /** Per-field string cap applied to the framed arguments. */
  maxArgumentFieldChars: number
  timeoutMs: number
  /** Transient-failure retries; each attempt gets a fresh deadline. */
  retries: number
}

/** One compiled policy rule, validated and materialized by `resolveConfig`. */
export interface ResolvedPolicyRule {
  /** Compiled case-insensitive pattern. */
  regex: RegExp
  /** Model-visible denial reason; defaults to the match text. */
  reason: string
  /** Tool names the rule applies to; an empty set applies to every tool. */
  tools: ReadonlySet<string>
}

/** Validated plugin config used by `apply`. */
export interface ResolvedConfig {
  modes: readonly SandboxMode[]
  /** Fixed read-only tool names union the configured extras. */
  skip: ReadonlySet<string>
  /** Tool names whose `command` argument the hard rules and the read-only command fast path inspect. */
  shellTools: ReadonlySet<string>
  workspaceWriteFastPath: boolean
  readOnlyCommandFastPath: boolean
  classifier?: ResolvedClassifierConfig
  denyRules: readonly ResolvedPolicyRule[]
  allowRules: readonly ResolvedPolicyRule[]
}

/** Verdict decision produced by the classifier. */
export type ClassifierDecision = 'allow' | 'deny'

/** Risk categories a deny verdict may name — stable, closed vocabulary. */
export type RiskCategory =
  | 'destructive'
  | 'exfiltration'
  | 'credentials'
  | 'system-mutation'
  | 'out-of-scope'
  | 'suspicious'

/** Category an allow verdict may name (`allow` requires `safe`). */
export type ClassifierCategory = 'safe' | RiskCategory

/** One parsed classifier verdict. */
export interface Verdict {
  decision: ClassifierDecision
  category: ClassifierCategory
  reason: string
}

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
  /** Auxiliary output-token cap (default 200). */
  maxOutputTokens?: number
  /** End-to-end classification deadline in milliseconds (default 5000). */
  timeoutMs?: number
}

/** Plugin config, validated by the `Config` schemastery schema plus the fail-loud checks in `apply`. */
export interface GuardrailConfig {
  /** Sandbox modes that arm the guardrail (default: `['danger-full-access']`). */
  modes?: SandboxMode[]
  /** Extra read-only tool names exempt from classification; the fixed read-only set and the hard rules always apply. */
  skip?: string[]
  /** LLM classifier; omitted runs the rules-only mode. */
  classifier?: ClassifierConfig
}

/** Config after validation and defaulting — every optional field materialized. */
export interface ResolvedClassifierConfig {
  provider: string
  model: string
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
}

/** Validated plugin config used by `apply`. */
export interface ResolvedConfig {
  modes: readonly SandboxMode[]
  /** Fixed read-only tool names union the configured extras. */
  skip: ReadonlySet<string>
  classifier?: ResolvedClassifierConfig
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
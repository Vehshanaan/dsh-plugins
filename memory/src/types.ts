/**
 * Pure types and config validation of the memory plugin — no runtime side effects.
 * @module memory/types
 */

import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Optional LLM route for automatic memory extraction from conversation. */
export interface AutoExtractConfig {
  /** Registered LLM provider route. */
  provider: string
  /** Exact model id served by that provider. */
  model: string
  /** Auxiliary output-token cap for one extraction call (default 1024). */
  maxTokens?: number
  /** Cap in UTF-8 characters for the framed extraction input (default 12000). */
  maxInputChars?: number
  /** Minimum milliseconds between two extraction calls of one session (default 600000). */
  minIntervalMs?: number
  /** Maximum recent user messages fed to one extraction call (default 2). */
  perTurnMax?: number
}

/** Plugin config, validated by the `Config` schemastery schema plus the fail-loud checks in `resolveConfig`. */
export interface MemoryConfig {
  /**
   * Memory root directory. Defaults to `$DSH_HOME/memory` (i.e. `~/.dsh/memory`
   * without an override); a relative path resolves against the process cwd.
   */
  root?: string
  /** Maximum index lines rendered into the model context (default 200, mirroring Claude Code). */
  indexLineLimit?: number
  /** Maximum index bytes rendered into the model context (default 25000, mirroring Claude Code). */
  indexByteLimit?: number
  /** Cap in characters for memory content returned by `memory_search` (default 2000). */
  maxContentChars?: number
  /** Inject the global memory index into every session (default true). */
  injectGlobalIndex?: boolean
  /** Inject the current project's memory index into its sessions (default true). */
  injectProjectIndex?: boolean
  /** Automatic extraction from conversation; omitted disables the feature. */
  autoExtract?: AutoExtractConfig
}

/** Config after validation and defaulting — every optional field materialized. */
export interface ResolvedAutoExtractConfig {
  provider: string
  model: string
  maxTokens: number
  maxInputChars: number
  minIntervalMs: number
  perTurnMax: number
}

/** Validated plugin config used by `apply`. */
export interface ResolvedConfig {
  root: string
  indexLineLimit: number
  indexByteLimit: number
  maxContentChars: number
  injectGlobalIndex: boolean
  injectProjectIndex: boolean
  autoExtract?: ResolvedAutoExtractConfig
}

/** Throw the given message — the fail-loud pattern every validation branch uses. */
function fail(message: string): never {
  throw new Error(`memory config: ${message}`)
}

/** Validate one positive integer config field. */
function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1) {
    fail(`${name} must be a positive integer (got ${selected})`)
  }
  return selected
}

/**
 * Validate the plugin config and materialize every default. Unknown or
 * out-of-range values fail loud at load, never silently.
 * @param config - loader-validated config.
 * @returns the fully defaulted config.
 */
export function resolveConfig(config: MemoryConfig): ResolvedConfig {
  const rootInput = config.root?.trim() ?? ''
  const root = rootInput === '' ? join(resolveDshHome(), 'memory') : resolve(rootInput)
  const indexLineLimit = positiveInt(config.indexLineLimit, 200, 'indexLineLimit')
  const indexByteLimit = positiveInt(config.indexByteLimit, 25000, 'indexByteLimit')
  const maxContentChars = positiveInt(config.maxContentChars, 2000, 'maxContentChars')
  // The schemastery loader defaults a missing object field to `{}`; an empty
  // object carries no configuration and disables the feature, while a
  // non-empty one is validated fail-loud below.
  // The schemastery loader injects field defaults into a missing object, so
  // "configured" is decided by the only two required fields: provider and
  // model. Absent either, the feature stays off.
  const autoExtractInput = config.autoExtract !== undefined
    && (config.autoExtract.provider ?? '').trim() !== ''
    && (config.autoExtract.model ?? '').trim() !== ''
    ? config.autoExtract
    : undefined
  let autoExtract: ResolvedAutoExtractConfig | undefined
  if (autoExtractInput !== undefined) {
    const provider = (autoExtractInput.provider ?? '').trim()
    const model = (autoExtractInput.model ?? '').trim()
    if (provider === '') fail('autoExtract.provider must be a non-empty string')
    if (model === '') fail('autoExtract.model must be a non-empty string')
    autoExtract = {
      provider,
      model,
      maxTokens: positiveInt(autoExtractInput.maxTokens, 1024, 'autoExtract.maxTokens'),
      maxInputChars: positiveInt(autoExtractInput.maxInputChars, 12000, 'autoExtract.maxInputChars'),
      minIntervalMs: (() => {
        const selected = autoExtractInput.minIntervalMs ?? 600000
        if (!Number.isSafeInteger(selected) || selected < 0) {
          fail(`autoExtract.minIntervalMs must be a non-negative integer (got ${selected})`)
        }
        return selected
      })(),
      perTurnMax: positiveInt(autoExtractInput.perTurnMax, 2, 'autoExtract.perTurnMax'),
    }
  }
  return {
    root,
    indexLineLimit,
    indexByteLimit,
    maxContentChars,
    injectGlobalIndex: config.injectGlobalIndex ?? true,
    injectProjectIndex: config.injectProjectIndex ?? true,
    autoExtract,
  }
}

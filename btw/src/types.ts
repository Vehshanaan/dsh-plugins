/**
 * Plugin config types for the `/btw` side-question plugin.
 * @module dsh-btw/types
 */

/** User-supplied plugin config; every field is optional with a validated default. */
export interface BtwConfig {
  /** Subagent provider name used to run the side question (default `spawn`). */
  provider?: string
  /**
   * Child tool scoping. Defaults to `{ allow: [] }` — a side question runs
   * without any tools, so it can never mutate state or run commands.
   */
  toolFilter?: { allow?: string[]; deny?: string[] }
  /** Optional per-child persona that shadows the deployment persona for the side agent. */
  persona?: string
  /** Optional child LLM route overrides (provider/model/maxTokens). */
  agentOptions?: {
    provider?: string
    model?: string
    maxTokens?: number
  }
  /** Answer length cap in characters; longer answers are truncated (default 8000). */
  maxOutputChars?: number
}

/** Validated config with defaults applied. */
export interface ResolvedBtwConfig {
  provider: string
  toolFilter: { allow: string[]; deny?: string[] }
  persona?: string
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  maxOutputChars: number
}

/** Non-empty string check shared by every optional string field. */
function requireStringField(value: unknown, key: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`btw: \`${key}\` must be a non-empty string`)
  }
  return value
}

/** Positive safe integer check shared by every numeric field. */
function requirePositiveInt(value: unknown, key: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`btw: \`${key}\` must be a positive integer (got ${String(value)})`)
  }
  return value as number
}

/** Validate one tool list (allow/deny) as non-empty strings. */
function requireToolList(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new Error(`btw: ${key} entries must be non-empty strings`)
  }
  return [...value]
}

/**
 * Validate and default the plugin config. Misconfiguration fails loud:
 * unknown keys, blank strings, and out-of-range numbers throw at load.
 * @param config - loader-validated config (schema defaults already applied).
 * @returns the resolved config consumed by `apply`.
 */
export function resolveConfig(config: BtwConfig): ResolvedBtwConfig {
  const unknown = Object.keys(config).filter(key =>
    !['provider', 'toolFilter', 'persona', 'agentOptions', 'maxOutputChars'].includes(key))
  if (unknown.length > 0) {
    throw new Error(`btw: unknown config key(s) ${unknown.join(', ')}`)
  }

  const provider = requireStringField(config.provider ?? 'spawn', 'provider')

  let toolFilter: ResolvedBtwConfig['toolFilter'] = { allow: [] }
  if (config.toolFilter !== undefined) {
    const raw = config.toolFilter
    const unknownFilter = Object.keys(raw).filter(key => !['allow', 'deny'].includes(key))
    if (unknownFilter.length > 0) {
      throw new Error(`btw: unknown toolFilter key(s) ${unknownFilter.join(', ')}`)
    }
    const filter: { allow?: string[]; deny?: string[] } = {}
    if (raw.allow !== undefined) filter.allow = requireToolList(raw.allow, 'toolFilter.allow')
    if (raw.deny !== undefined) filter.deny = requireToolList(raw.deny, 'toolFilter.deny')
    if (filter.allow === undefined && filter.deny === undefined) {
      throw new Error('btw: toolFilter must declare allow and/or deny')
    }
    toolFilter = filter as ResolvedBtwConfig['toolFilter']
  }

  const persona = config.persona === undefined ? undefined : requireStringField(config.persona, 'persona')

  let agentOptions: ResolvedBtwConfig['agentOptions']
  if (config.agentOptions !== undefined) {
    const raw = config.agentOptions
    const unknownAgent = Object.keys(raw).filter(key => !['provider', 'model', 'maxTokens'].includes(key))
    if (unknownAgent.length > 0) {
      throw new Error(`btw: unknown agentOptions key(s) ${unknownAgent.join(', ')}`)
    }
    agentOptions = {}
    if (raw.provider !== undefined) agentOptions.provider = requireStringField(raw.provider, 'agentOptions.provider')
    if (raw.model !== undefined) agentOptions.model = requireStringField(raw.model, 'agentOptions.model')
    if (raw.maxTokens !== undefined) agentOptions.maxTokens = requirePositiveInt(raw.maxTokens, 'agentOptions.maxTokens')
  }

  const maxOutputChars = requirePositiveInt(config.maxOutputChars ?? 8000, 'maxOutputChars')

  return {
    provider,
    toolFilter,
    ...persona === undefined ? {} : { persona },
    ...agentOptions === undefined ? {} : { agentOptions },
    maxOutputChars,
  }
}
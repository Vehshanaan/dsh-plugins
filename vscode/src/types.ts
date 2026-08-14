/**
 * Plugin config types for the `/vscode` open-in-editor plugin.
 * @module dsh-vscode/types
 */

/** User-supplied plugin config; every field is optional with a validated default. */
export interface VscodeConfig {
  /** Editor CLI command name (default `code`). */
  command?: string
  /** Optional extra CLI arguments appended after the target path (e.g. `--reuse-window`). */
  args?: string[]
}

/** Validated config with defaults applied. */
export interface ResolvedVscodeConfig {
  command: string
  args: string[]
}

/**
 * Validate and default the plugin config. Misconfiguration fails loud:
 * unknown keys and blank values throw at load.
 * @param config - loader-validated config (schema defaults already applied).
 * @returns the resolved config consumed by `apply`.
 */
export function resolveConfig(config: VscodeConfig): ResolvedVscodeConfig {
  const unknown = Object.keys(config).filter(key => !['command', 'args'].includes(key))
  if (unknown.length > 0) {
    throw new Error(`vscode: unknown config key(s) ${unknown.join(', ')}`)
  }
  const command = config.command ?? 'code'
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('vscode: `command` must be a non-empty string')
  }
  const args = config.args ?? []
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
    throw new Error('vscode: `args` must be an array of strings')
  }
  return { command, args: [...args] }
}
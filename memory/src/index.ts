/**
 * Claude Code style cross-session memory plugin.
 *
 * Memories are pure Markdown files under `$DSH_HOME/memory` (or a configured
 * root), split into a global scope injected into every session and per-project
 * scopes injected only into that project's sessions — the split is what keeps
 * the injected index small. The model writes entries explicitly through the
 * `memory_save` tool, reads them through `memory_search`, and can review or
 * correct them with `/memory`. Automatic extraction (opt-in) reviews recent
 * conversation with a lightweight model call and proposes new entries.
 *
 * @module memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves `ctx.systemPrompt` and the prompt registry vocabulary.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves `ctx.tools` for the registered tools.
import type {} from '@deepseek-ai/dsh-tools'
import { MemoryStore, projectSlug } from './store.ts'
import { registerMemoryTools } from './tools.ts'
import { registerMemoryCommand } from './command.ts'
import { installAutoExtract } from './auto.ts'
import { resolveConfig, type AutoExtractConfig, type MemoryConfig } from './types.ts'

export type { AutoExtractConfig, MemoryConfig } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'memory'

/** Required services: the tool registry and the prompt registry. */
export const inject = ['tools', 'systemPrompt']

/** Plugin config, validated by this schemastery schema and re-checked fail-loud in {@link resolveConfig}. */
export const Config: z<MemoryConfig> = z.object({
  root: z.string().default(''),
  indexLineLimit: z.number().default(200),
  indexByteLimit: z.number().default(25000),
  maxContentChars: z.number().default(2000),
  injectGlobalIndex: z.boolean().default(true),
  injectProjectIndex: z.boolean().default(true),
  autoExtract: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number().default(1024),
    maxInputChars: z.number().default(12000),
    minIntervalMs: z.number().default(600000),
    perTurnMax: z.number().default(2),
  }),
})

/** Prompt order of the memory index context; after tool guidance, before plugin extras. */
const MEMORY_CONTEXT_ORDER = 150

/** Drift guard: a memory naming a file or function may be stale, so verify first. */
const DRIFT_SENTENCE = 'A memory entry that names a specific file, function, or flag is a claim that it existed when the memory was written — it may have been renamed, removed, or never merged. Verify before recommending it. Use memory_search to read a full entry before relying on it.'

/**
 * Install the plugin: validate config, register the memory tools, the
 * `/memory` command, the index injection, and (when configured) automatic
 * extraction.
 * @param ctx - plugin context carrying the tool and prompt registries.
 * @param config - loader-validated config.
 */
export function apply(ctx: Context, config: MemoryConfig): void {
  const resolved = resolveConfig(config)
  const store = new MemoryStore(resolved.root, {
    lineLimit: resolved.indexLineLimit,
    byteLimit: resolved.indexByteLimit,
  })
  registerMemoryTools(ctx, store, resolved.maxContentChars)
  registerMemoryCommand(ctx, store, resolved.maxContentChars)

  ctx.systemPrompt.context({
    name: 'memory:index',
    order: MEMORY_CONTEXT_ORDER,
    text: (assembleContext) => {
      const agent = assembleContext.agent
      if (agent === undefined) return ''
      const slug = agent.session.header.cwd === undefined
        ? undefined
        : projectSlug(agent.session.header.cwd)
      const parts: string[] = []
      if (resolved.injectGlobalIndex) {
        const global = store.renderIndex('global')
        if (global !== '') parts.push(global)
      }
      if (resolved.injectProjectIndex && slug !== undefined) {
        const project = store.renderIndex('project', slug)
        if (project !== '') parts.push(project)
      }
      if (parts.length === 0) return ''
      parts.push(DRIFT_SENTENCE)
      return parts.join('\n\n')
    },
  })

  if (resolved.autoExtract !== undefined) {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      throw new Error('memory: autoExtract configured, but no llm service is composed')
    }
    installAutoExtract(ctx, store, llm, resolved.autoExtract)
  }
}

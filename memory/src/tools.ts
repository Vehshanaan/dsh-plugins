/**
 * Model-facing memory tools: `memory_save` writes a durable entry (the model
 * chooses the scope), `memory_search` reads entries back. Tool calls and
 * results enter the session log through the ordinary `tool/result` event, so
 * every memory write is reconstructable from the transcript.
 *
 * @module memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectSlug, MEMORY_TYPES, type MemoryScope, type MemoryStore } from './store.ts'

/** Model-facing guidance for choosing the memory scope. */
const SCOPE_GUIDANCE = '`global` when the fact applies beyond this project (user identity, cross-project preferences, general working style); `project` when it is only true inside this project (repo layout, project conventions, project-only decisions). When unsure, prefer `project` — a project-scoped entry never pollutes other projects.'

/** Model-facing guidance for choosing the memory type. */
const TYPE_GUIDANCE = '`user`: who the user is and their preferences; `feedback`: corrections or confirmations of your behavior; `project`: project context not derivable from the code; `reference`: pointers to external systems or documents.'

/** Model-facing description of the save tool. */
const SAVE_DESCRIPTION = `Save a durable cross-session memory. The memory becomes part of an index injected into future sessions (all sessions for global, this project's sessions for project). Save facts the user states or confirms that will matter later — preferences, corrections, project constraints. Never save secrets or credentials. ${SCOPE_GUIDANCE} ${TYPE_GUIDANCE}`

/** Model-facing description of the search tool. */
const SEARCH_DESCRIPTION = 'Search saved memories and read full entries. The injected memory index only lists one-line summaries; use this tool to read a complete entry before relying on its details.'

/** Project slug of one agent's session, or undefined without a working directory. */
function slugOf(agent: { session: { header: { cwd?: string } } } | undefined): string | undefined {
  const cwd = agent?.session.header.cwd
  return cwd === undefined ? undefined : projectSlug(cwd)
}

/**
 * Register the memory tools on the tool registry.
 * @param ctx - registrant context carrying the tool registry.
 * @param store - the file-backed memory store.
 * @param maxContentChars - cap for content returned by `memory_search`.
 */
export function registerMemoryTools(ctx: Context, store: MemoryStore, maxContentChars: number): void {
  ctx.tools.register(defineTool({
    name: 'memory_save',
    description: SAVE_DESCRIPTION,
    parameters: {
      scope: {
        type: 'string',
        required: true,
        enum: ['global', 'project'],
        description: 'Where the memory lives. ' + SCOPE_GUIDANCE,
      },
      title: {
        type: 'string',
        required: true,
        description: 'Short unique title (a few words). Saving again with the same title updates the entry.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'One-line summary shown in the injected index.',
      },
      type: {
        type: 'string',
        required: true,
        enum: [...MEMORY_TYPES],
        description: TYPE_GUIDANCE,
      },
      content: {
        type: 'string',
        required: true,
        description: 'The full memory body, in prose or markdown.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true, enum: ['global', 'project'] },
          title: { type: 'string', required: true },
          fileName: { type: 'string', required: true },
          created: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved ${value.scope} memory "${value.title}" (${value.created ? 'created' : 'updated'}).`,
      }],
    },
    execute(args, exec) {
      if (!exec.agent) {
        throw new Error('memory_save requires an owning agent session')
      }
      const slug = slugOf(exec.agent)
      if (args.scope === 'project' && slug === undefined) {
        throw new Error('memory_save scope "project" requires a session working directory')
      }
      const result = store.save(
        args.scope as MemoryScope,
        {
          title: String(args.title),
          description: String(args.description),
          type: args.type,
          content: String(args.content),
        },
        slug,
      )
      return Promise.resolve({
        scope: args.scope,
        title: String(args.title),
        fileName: result.fileName,
        created: result.created,
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Save memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search words matched against titles, descriptions, and content.',
      },
      scope: {
        type: 'string',
        enum: ['global', 'project', 'all'],
        description: 'Where to search; defaults to `all` (global plus this project).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of results (default 10).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                scope: { type: 'string', required: true, enum: ['global', 'project'] },
                title: { type: 'string', required: true },
                type: { type: 'string', required: true },
                description: { type: 'string', required: true },
                content: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.results.length === 0) return [{ type: 'text', text: 'No matching memories.' }]
        const lines = value.results.map((result: { scope: string; title: string; type: string; description: string }) =>
          `- [${result.scope}] ${result.title} (${result.type}): ${result.description}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute(args, exec) {
      const slug = slugOf(exec.agent)
      const scope = args.scope === undefined ? 'all' : String(args.scope)
      if (scope === 'project' && slug === undefined) {
        throw new Error('memory_search scope "project" requires a session working directory')
      }
      const limit = typeof args.limit === 'number' && Number.isSafeInteger(args.limit) && args.limit > 0
        ? args.limit
        : 10
      const results = store.search(String(args.query), scope as 'global' | 'project' | 'all', slug, limit)
        .map(hit => ({
          scope: hit.scope,
          title: hit.entry.title,
          type: hit.entry.type,
          description: hit.entry.description,
          content: hit.entry.content.length > maxContentChars
            ? `${hit.entry.content.slice(0, maxContentChars)}…[truncated]`
            : hit.entry.content,
        }))
      return Promise.resolve({ results })
    },
    presentCall: args => ({ card: 'generic', title: 'Search memory', kind: 'other', rawInput: args }),
  }))
}

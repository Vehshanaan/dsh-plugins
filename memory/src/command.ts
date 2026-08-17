/**
 * `/memory` user command: list, search, view, delete, and move memories
 * directly, without involving the model. The command registry records only
 * the log-only `command/run`/`command/done` lifecycle events, so memory
 * management never pollutes the conversation history.
 *
 * @module memory/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { projectSlug, type MemoryScope, type MemoryStore } from './store.ts'

/** Project slug of one agent's session, or undefined without a working directory. */
function slugOf(agent: { session: { header: { cwd?: string } } }): string | undefined {
  const cwd = agent.session.header.cwd
  return cwd === undefined ? undefined : projectSlug(cwd)
}

/** Stable failure text for a parse error. */
function usage(): string {
  return '用法：/memory [list|search <词>|view <标题>|delete <标题>|move <标题> <global|project>]'
}

/** Format one index line for the command output. */
function indexLine(scope: MemoryScope, entry: { title: string; description: string; type: string }): string {
  return `[${scope}] ${entry.title} (${entry.type}): ${entry.description}`
}

/**
 * Register the `/memory` command when a command registry is composed.
 * @param ctx - registrant context.
 * @param store - the file-backed memory store.
 * @param maxContentChars - cap for content shown by `view` and `search`.
 */
export function registerMemoryCommand(ctx: Context, store: MemoryStore, maxContentChars: number): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'memory',
      description: '查看、搜索、管理跨会话记忆（list | search <词> | view <标题> | delete <标题> | move <标题> <global|project>）',
      input: { hint: '[list|search <词>|view <标题>|delete <标题>|move <标题> <global|project>]' },
      handler: async (invocation): Promise<CommandResult> => {
        const slug = slugOf(invocation.agent)
        const line = invocation.rawInput.trim()
        const [verb, ...rest] = line.split(/\s+/)
        const first = rest[0] ?? ''
        switch (verb) {
          case '':
          case 'list': {
            const scopeText = first === 'project' || first === 'global' ? first : undefined
            const global = store.list('global').map(entry => ({ scope: 'global' as const, entry }))
            const project = slug === undefined
              ? []
              : store.list('project', slug).map(entry => ({ scope: 'project' as const, entry }))
            const hits = scopeText === 'global' ? global
              : scopeText === 'project' ? project
                : [...global, ...project]
            if (hits.length === 0) return { kind: 'success', text: '（暂无记忆）' }
            const lines = hits.map(hit => indexLine(hit.scope, hit.entry))
            return { kind: 'success', text: lines.join('\n') }
          }
          case 'search': {
            if (first === '') return { kind: 'error', text: '请提供搜索词：/memory search <词>' }
            const hits = store.search(first, 'all', slug, 10)
            if (hits.length === 0) return { kind: 'success', text: '（没有匹配的记忆）' }
            const lines = hits.map(hit => {
              const content = hit.entry.content.length > maxContentChars
                ? `${hit.entry.content.slice(0, maxContentChars)}…[truncated]`
                : hit.entry.content
              return `${indexLine(hit.scope, hit.entry)}\n${content}`
            })
            return { kind: 'success', text: lines.join('\n\n') }
          }
          case 'view': {
            if (first === '') return { kind: 'error', text: '请提供记忆标题：/memory view <标题>' }
            const found = store.get('global', first)
              ?? (slug === undefined ? undefined : store.get('project', first, slug))
            if (found === undefined) return { kind: 'error', text: `未找到记忆 "${first}"` }
            const content = found.content.length > maxContentChars
              ? `${found.content.slice(0, maxContentChars)}…[truncated]`
              : found.content
            return { kind: 'success', text: `[${found.title}] (${found.type})\n${content}` }
          }
          case 'delete': {
            if (first === '') return { kind: 'error', text: '请提供记忆标题：/memory delete <标题>' }
            const removed = store.remove('global', first)
              || (slug === undefined ? false : store.remove('project', first, slug))
            if (!removed) return { kind: 'error', text: `未找到记忆 "${first}"` }
            return { kind: 'success', text: `已删除记忆 "${first}"` }
          }
          case 'move': {
            const title = first
            const target = rest[1] ?? ''
            if (title === '' || (target !== 'global' && target !== 'project')) {
              return { kind: 'error', text: '用法：/memory move <标题> <global|project>' }
            }
            const moved = store.move('global', title, target as MemoryScope, undefined, slug)
              || (slug === undefined ? false : store.move('project', title, target as MemoryScope, slug, target === 'project' ? slug : undefined))
            if (!moved) return { kind: 'error', text: `未找到记忆 "${title}"` }
            return { kind: 'success', text: `已移动记忆 "${title}" 到 ${target}` }
          }
          default:
            return { kind: 'error', text: usage() }
        }
      },
    })
  })
}

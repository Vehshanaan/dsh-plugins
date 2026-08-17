import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as MemoryPlugin from '../src/index.ts'
import { projectSlug } from '../src/store.ts'
import { shouldExtract } from '../src/auto.ts'
import type { MemoryConfig } from '../src/types.ts'
import { MockAdapter, jsonResponse, textResponse } from './mock-adapter.ts'

type Script = (ReturnType<typeof textResponse> | 'hang')[]

/** Real plugins through the agent loop; only the model is mocked. */
async function harness(config: MemoryConfig, script: Script): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(MemoryPlugin, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

let contexts: Context[] = []
let roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  contexts = []
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function freshRoot(): string {
  const root = join(tmpdir(), `dsh-memory-it-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  roots.push(root)
  return root
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

async function callTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: unknown,
): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const result = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    agent,
  }))
  if (result.isError === false) return { ok: true, value: result.value }
  return { ok: false, error: typeof result.content === 'string' ? result.content : JSON.stringify(result.content) }
}

describe('memory plugin through the agent loop', () => {
  it('memory_save writes a global entry and rebuilds the index', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-save'), { provider: 'mock', model: 'mock' }, { cwd: root })

    const result = await callTool(ctx, agent, 'memory_save', {
      scope: 'global',
      title: '中文回复',
      description: '用户偏好中文',
      type: 'user',
      content: '用户希望所有回复使用中文。',
    })

    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ scope: 'global', title: '中文回复', created: true })
    expect(existsSync(join(root, 'global', '中文回复.md'))).toBe(true)
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toContain('- [中文回复](中文回复.md) — user: 用户偏好中文')
  })

  it('memory_save updates an existing title instead of duplicating', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-update'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const args = {
      scope: 'global' as const,
      title: '偏好',
      description: 'd',
      type: 'user' as const,
      content: 'v1',
    }
    await callTool(ctx, agent, 'memory_save', args)
    const second = await callTool(ctx, agent, 'memory_save', { ...args, content: 'v2' })
    expect(second.value).toMatchObject({ created: false })
    expect(readFileSync(join(root, 'global', '偏好.md'), 'utf8')).toContain('v2')
  })

  it('memory_save scope project requires a session working directory', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-nocwd'), { provider: 'mock', model: 'mock' })

    const result = await callTool(ctx, agent, 'memory_save', {
      scope: 'project',
      title: 'x',
      description: 'd',
      type: 'project',
      content: 'y',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('project')
  })

  it('memory_save without an agent is rejected', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('call-no-agent'),
      name: 'memory_save',
      arguments: { scope: 'global', title: 'x', description: 'd', type: 'user', content: 'y' },
    })
    expect(result.isError).toBe(true)
  })

  it('memory_search returns full entries and caps content', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root, maxContentChars: 20 }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-search'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await callTool(ctx, agent, 'memory_save', {
      scope: 'global',
      title: '回复语言',
      description: '用户偏好中文回复',
      type: 'user',
      content: '用户希望所有回复都使用中文，包括代码注释。',
    })

    const hit = await callTool(ctx, agent, 'memory_search', { query: '中文', scope: 'global' })
    expect(hit.ok).toBe(true)
    const results = (hit.value as { results: { scope: string; title: string; content: string }[] }).results
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ scope: 'global', title: '回复语言' })
    expect(results[0]!.content).toContain('[truncated]')

    const miss = await callTool(ctx, agent, 'memory_search', { query: '不存在' })
    expect((miss.value as { results: unknown[] }).results).toHaveLength(0)
  })

  it('injects the global and project indexes plus the drift sentence', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const projectDir = join(root, 'work')
    mkdirSync(projectDir, { recursive: true })
    const agent = ctx.agentLoop.create(SessionId('it-mem-inject'), { provider: 'mock', model: 'mock' }, { cwd: projectDir })
    const slug = projectSlug(projectDir)

    await callTool(ctx, agent, 'memory_save', {
      scope: 'global',
      title: '全局偏好',
      description: '全局描述',
      type: 'user',
      content: '全局内容',
    })
    await callTool(ctx, agent, 'memory_save', {
      scope: 'project',
      title: '项目约定',
      description: '项目描述',
      type: 'project',
      content: '项目内容',
    })

    const assembly = await ctx.systemPrompt.assemble({ agent })
    const context = assembly.contexts.find(entry => entry.name === 'memory:index')
    expect(context).toBeDefined()
    const text = context!.text
    expect(text).toContain('Memory index (global):')
    expect(text).toContain(`Memory index (project ${slug}):`)
    expect(text).toContain('- [全局偏好]')
    expect(text).toContain('- [项目约定]')
    expect(text).toContain('Verify before recommending it')
  })

  it('injects nothing when there are no memories', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-empty'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    expect(assembly.contexts.find(entry => entry.name === 'memory:index')?.text).toBe('')
  })

  it('injects only the global index when project injection is disabled', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root, injectProjectIndex: false }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-no-proj'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await callTool(ctx, agent, 'memory_save', {
      scope: 'global',
      title: '只有全局',
      description: 'd',
      type: 'user',
      content: 'c',
    })
    const assembly = await ctx.systemPrompt.assemble({ agent })
    const text = assembly.contexts.find(entry => entry.name === 'memory:index')!.text
    expect(text).toContain('Memory index (global):')
    expect(text).not.toContain('Memory index (project')
  })

  it('manages memories through the /memory command', async () => {
    const root = freshRoot()
    const { ctx } = await harness({ root }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-cmd'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await callTool(ctx, agent, 'memory_save', {
      scope: 'global',
      title: '命令条目',
      description: '用于命令测试',
      type: 'user',
      content: '命令测试内容。',
    })

    const list = await ctx.commands.execute(agent, '/memory list', new AbortController().signal)
    expect(list?.result.kind).toBe('success')
    expect((list?.result as { text: string }).text).toContain('[global] 命令条目')

    const view = await ctx.commands.execute(agent, '/memory view 命令条目', new AbortController().signal)
    expect((view?.result as { text: string }).text).toContain('命令测试内容')

    const moved = await ctx.commands.execute(agent, '/memory move 命令条目 project', new AbortController().signal)
    expect((moved?.result as { text: string }).text).toContain('已移动')

    const deleted = await ctx.commands.execute(agent, '/memory delete 命令条目', new AbortController().signal)
    expect((deleted?.result as { text: string }).text).toContain('已删除')

    const gone = await ctx.commands.execute(agent, '/memory delete 命令条目', new AbortController().signal)
    expect(gone?.result.kind).toBe('error')

    // The command lifecycle events stay out of model history (log-only).
    const log = agent.session.events
    expect(log.some(e => e.type === 'command/run' && e.data.name === 'memory')).toBe(true)
    expect(log.some(e => e.type === 'turn/start')).toBe(false)
  })

  it('auto-extracts memories after a completed step', async () => {
    const root = freshRoot()
    const { ctx, adapter } = await harness({
      root,
      autoExtract: { provider: 'mock', model: 'mock', minIntervalMs: 0, maxTokens: 512 },
    }, [
      textResponse('好的，已了解。'),
      jsonResponse([{
        title: '自动记忆',
        description: '自动提取的偏好',
        type: 'feedback',
        scope: 'global',
        content: '用户希望回复尽量简洁。',
        shouldSave: true,
      }]),
    ])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-mem-auto'), { provider: 'mock', model: 'mock' }, { cwd: root })

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '以后回复尽量简洁一点。' }],
      source: { kind: 'user' },
    }))
    await idle

    await vi.waitFor(() => {
      expect(adapter.requests.length).toBe(2)
    })
    await vi.waitFor(() => {
      expect(existsSync(join(root, 'global', '自动记忆.md'))).toBe(true)
    })
    expect(readFileSync(join(root, 'global', '自动记忆.md'), 'utf8')).toContain('用户希望回复尽量简洁')
    expect(readFileSync(join(root, 'MEMORY.md'), 'utf8')).toContain('自动记忆')
  })

  it('skips auto-extraction for subagent sessions', async () => {
    const session = Session.create(SessionId('child'), [], {
      version: 0,
      id: SessionId('child'),
      createdAt: 0,
      origin: 'subagent',
    })
    expect(shouldExtract(session, { type: 'step/end' }, undefined, 0, 0)).toBe(false)
  })

  it('respects the extraction interval', () => {
    const session = Session.create(SessionId('root'))
    expect(shouldExtract(session, { type: 'step/end' }, undefined, 10000, 5000)).toBe(true)
    expect(shouldExtract(session, { type: 'step/end' }, 2000, 3000, 5000)).toBe(false)
    expect(shouldExtract(session, { type: 'step/end' }, 2000, 9000, 5000)).toBe(true)
    expect(shouldExtract(session, { type: 'assistant/message' }, undefined, 0, 0)).toBe(false)
  })
})

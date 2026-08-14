import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as VscodePlugin from '../src/index.ts'

/** Real plugins; the command path is exercised without spawning anything. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(VscodePlugin, {})
  return ctx
}

let contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  contexts = []
})

describe('vscode through the command registry', () => {
  it('registers a discoverable /vscode command', async () => {
    const ctx = await harness()
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-vscode-reg'), { provider: 'mock', model: 'mock' })

    const descriptors = ctx.commands.list(agent)
    const vscode = descriptors.find(descriptor => descriptor.name === 'vscode')
    expect(vscode).toBeDefined()
    expect(vscode?.description).toContain('VS Code')
    expect(vscode?.input?.hint).toBe('[相对路径]')
  })

  it('executes the registered handler through the registry without a model turn', async () => {
    const ctx = await harness()
    contexts.push(ctx)
    // No cwd on this agent: the handler fails fast and never spawns.
    const agent = ctx.agentLoop.create(SessionId('it-vscode-nocwd'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/vscode', new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'error', text: '当前会话没有工作目录，无法打开。' })
    // The lifecycle pair is log-only; no turn or user message entered the log.
    const log = agent.session.events
    expect(log.some(e => e.type === 'command/run' && e.data.name === 'vscode')).toBe(true)
    expect(log.some(e => e.type === 'command/done' && e.data.kind === 'error')).toBe(true)
    expect(log.some(e => e.type === 'turn/start')).toBe(false)
    expect(log.some(e => e.type === 'user/message')).toBe(false)
  })

  it('rejects an empty question path with an unknown command shape', async () => {
    const ctx = await harness()
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-vscode-miss'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/nope', new AbortController().signal)
    expect(execution).toBeUndefined()
  })
})



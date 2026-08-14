import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import * as SpawnPlugin from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as BtwPlugin from '../src/index.ts'
import type { BtwConfig } from '../src/types.ts'
import { MockAdapter, maxTokensResponse, textResponse } from './mock-adapter.ts'

type Script = (ReturnType<typeof textResponse> | 'hang')[]

/** Real plugins through the agent loop; only the model is mocked. */
async function harness(config: BtwConfig, script: Script): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SpawnPlugin)
  await ctx.plugin(BtwPlugin, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

let contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.map(ctx => ctx.fiber.dispose()))
  contexts = []
})

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

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('btw through the agent loop', () => {
  it('answers a side question without entering the main conversation', async () => {
    const { ctx, adapter } = await harness({}, [textResponse('答案是 42。')])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-ok'), { provider: 'mock', model: 'mock' })
    const children: Agent[] = []
    // Capture the child inside the notification: the run is disposed before
    // execute() resolves, so the registry no longer serves it afterwards.
    ctx.on('subagent/start', (info: SubagentRunInfo) => {
      const child = ctx.agents.get(info.id)
      if (child !== undefined) children.push(child)
    })

    const execution = await ctx.commands.execute(
      agent, '/btw 这个函数为什么报错？', new AbortController().signal)

    expect(adapter.requests).toHaveLength(1)
    expect(execution?.result).toEqual({ kind: 'success', text: '答案是 42。' })

    const log = agent.session.events
    expect(log.some(e => e.type === 'command/run' && e.data.name === 'btw'
      && e.data.args === ' 这个函数为什么报错？')).toBe(true)
    expect(log.some(e => e.type === 'command/done' && e.data.kind === 'success'
      && e.data.text === '答案是 42。')).toBe(true)
    // Zero main-conversation pollution: no turn, no user message, no request.
    expect(log.some(e => e.type === 'turn/start')).toBe(false)
    expect(log.some(e => e.type === 'user/message')).toBe(false)
    expect(log.some(e => e.type === 'request/header')).toBe(false)
    expect(log.some(e => e.type === 'assistant/message')).toBe(false)

    // The side session carries the full exchange.
    expect(children).toHaveLength(1)
    const childLog = children[0]!.session.events
    expect(childLog.some(e => e.type === 'user/message' && textOf(e.data.content).includes('这个函数为什么报错？'))).toBe(true)
    expect(childLog.some(e => e.type === 'assistant/message' && textOf(e.data.message.content).includes('答案是 42。'))).toBe(true)
    expect(childLog.some(e => e.type === 'subagent/descriptor')).toBe(true)
  })

  it('keeps the main conversation context clean afterwards', async () => {
    const { ctx, adapter } = await harness({}, [textResponse('旁路回答'), textResponse('主对话回答')])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-clean'), { provider: 'mock', model: 'mock' })

    await ctx.commands.execute(agent, '/btw 旁路问题？', new AbortController().signal)
    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '继续主任务' }],
      source: { kind: 'user' },
    }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    const main = adapter.requests[1]!
    const serialized = JSON.stringify(main.messages)
    expect(serialized).not.toContain('旁路问题')
    expect(serialized).not.toContain('旁路回答')
    expect(serialized).toContain('继续主任务')
  })

  it('maps a token ceiling to an error result', async () => {
    const { ctx } = await harness({}, [maxTokensResponse('回答了一半')])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-tokens'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/btw 超长问题？', new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'error', text: '回答达到 token 上限，未能完成。' })
  })

  it('cancels a running side question when the UI signal aborts', async () => {
    const { ctx } = await harness({}, ['hang'])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-cancel'), { provider: 'mock', model: 'mock' })
    const controller = new AbortController()

    const pending = ctx.commands.execute(agent, '/btw 会取消的问题？', controller.signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()

    await expect(pending).rejects.toThrow()
  })

  it('reports a start failure as an error result', async () => {
    const { ctx } = await harness({ provider: 'nope' }, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-start'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/btw 无法启动的问题？', new AbortController().signal)

    expect(execution?.result.kind).toBe('error')
    expect(execution?.result.text).toContain('旁路提问无法启动')
  })

  it('rejects an empty question without touching the model', async () => {
    const { ctx, adapter } = await harness({}, [])
    contexts.push(ctx)
    const agent = ctx.agentLoop.create(SessionId('it-btw-empty'), { provider: 'mock', model: 'mock' })

    const execution = await ctx.commands.execute(agent, '/btw   ', new AbortController().signal)

    expect(execution?.result).toEqual({ kind: 'error', text: '请提供要问的问题，例如：/btw 这个函数为什么报错？' })
    expect(adapter.requests).toHaveLength(0)
  })
})
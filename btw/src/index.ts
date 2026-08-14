/**
 * `/btw` side questions: ask a question that never enters the main
 * conversation history. The command handler starts a fresh one-shot subagent
 * (zero parent context, no tools by default) with the question as its prompt,
 * waits for the answer, and returns it as the command result.
 *
 * The main session log receives only the two log-only lifecycle events the
 * command registry writes (`command/run` and `command/done`). Neither enters
 * model history, so the side question is invisible to the main conversation:
 * no `user/message`, no turn, no context pollution. The side agent's own
 * session records the full question/answer exchange and stays independently
 * inspectable (origin `subagent`, parent = the main session).
 *
 * @module dsh-btw
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: resolves `ctx.commands` and the command vocabulary for the
// conditional command child.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
// Type-only: resolves `ctx.subagents` for the injected service.
import type {} from '@deepseek-ai/dsh-subagent'
import type { SubagentResult, SubagentRun, SubagentStartRequest, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { resolveConfig, type BtwConfig, type ResolvedBtwConfig } from './types.ts'

export type { BtwConfig, ResolvedBtwConfig } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'btw'

/** Required services: the subagent seam runs the side question. */
export const inject = ['subagents']

/** Plugin config, validated by this schemastery schema and re-checked fail-loud in {@link resolveConfig}. */
export const Config = z.object({
  provider: z.string().default('spawn'),
  toolFilter: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  persona: z.string(),
  agentOptions: z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number(),
  }),
  maxOutputChars: z.number().default(8000),
})

/** One-shot subagent label kept in the durable child descriptor. */
const CHILD_LABEL = 'btw'

/** Best-effort message from an arbitrary thrown value; total against hostile values. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    if (typeof error === 'object' && error !== null
      && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
      return (error as { message: string }).message
    }
    return String(error)
  } catch {
    return '<不可打印的错误>'
  }
}

/** Concatenate the text blocks of a model output, skipping non-text blocks. */
export function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Truncate an answer to the configured character cap with a visible marker. */
export function limitText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}…[已截断]`
}

/** Stable user-facing failure text for one non-completed stop reason. */
export function failureText(reason: SubagentStopReason): string {
  switch (reason) {
    case 'completed': return '旁路提问完成。'
    case 'aborted': return '旁路提问已取消。'
    case 'max-tokens': return '回答达到 token 上限，未能完成。'
    case 'refusal': return '模型拒绝了这个问题。'
    case 'error': return '旁路提问失败。'
    default: return `旁路提问异常结束（${String(reason)}）。`
  }
}

/**
 * Map a settled side-agent result to the command outcome. A non-completed
 * stop reason is always an error — partial output is never presented as an
 * answer. An empty answer is an error too.
 * @param result - the settled subagent result.
 * @param maxOutputChars - answer length cap applied to a successful answer.
 * @returns the command result the UI renders.
 */
export function renderAnswer(result: SubagentResult, maxOutputChars: number): CommandResult {
  if (result.stopReason !== 'completed') {
    return { kind: 'error', text: failureText(result.stopReason) }
  }
  const text = blocksToText(result.output).trim()
  if (text === '') return { kind: 'error', text: '模型没有返回回答。' }
  return { kind: 'success', text: limitText(text, maxOutputChars) }
}

/**
 * Run one side question end to end: start the subagent, await its answer,
 * always dispose the run, and map the outcome. Start and infrastructure
 * failures become error results rather than escaped rejections, so the
 * command registry records a stable `command/done`.
 * @param subagents - the composed subagent seam.
 * @param agent - the receiving main agent (the side agent's parent).
 * @param question - the trimmed question text.
 * @param signal - cancellation signal owned by the dispatching UI request.
 * @param resolved - validated plugin config.
 * @returns the command outcome.
 */
export async function runSideQuestion(
  subagents: { start(name: string, request: SubagentStartRequest): Promise<SubagentRun> },
  agent: Agent,
  question: string,
  signal: AbortSignal,
  resolved: ResolvedBtwConfig,
  logger?: Pick<Context['logger'], 'warn'>,
): Promise<CommandResult> {
  let run: SubagentRun
  try {
    run = await subagents.start(resolved.provider, {
      label: CHILD_LABEL,
      prompt: [{ type: 'text', text: question }],
      parent: agent,
      signal,
      toolFilter: resolved.toolFilter,
      ...resolved.persona === undefined ? {} : { persona: resolved.persona },
      ...resolved.agentOptions === undefined ? {} : { agentOptions: resolved.agentOptions },
    })
  } catch (error: unknown) {
    return { kind: 'error', text: `旁路提问无法启动：${errorMessage(error)}` }
  }
  try {
    return renderAnswer(await run.result, resolved.maxOutputChars)
  } catch (error: unknown) {
    return { kind: 'error', text: `旁路提问失败：${errorMessage(error)}` }
  } finally {
    // Disposal failure must not mask the answer or the mapped failure.
    try {
      await run.dispose()
    } catch (error: unknown) {
      logger?.warn(`[btw] side run disposal failed: ${errorMessage(error)}`)
    }
  }
}

/**
 * Install the plugin: validate config, then register the `/btw` command when
 * a command registry is composed (the plan-mode pattern). Without `commands`
 * the plugin stays inert — headless compositions have no command surface.
 * @param ctx - plugin context carrying the subagent seam.
 * @param config - loader-validated config.
 */
export function apply(ctx: Context, config: BtwConfig): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'btw',
      description: '旁路提问：顺手问一个问题，不进对话历史，不影响当前任务',
      input: { hint: '<问题>' },
      handler: (invocation: CommandInvocation): Promise<CommandResult> => {
        const question = invocation.rawInput.trim()
        if (question === '') {
          return Promise.resolve({ kind: 'error', text: '请提供要问的问题，例如：/btw 这个函数为什么报错？' })
        }
        return runSideQuestion(
          ctx.subagents,
          invocation.agent,
          question,
          invocation.signal,
          resolved,
          ctx.logger,
        )
      },
    })
  })
}
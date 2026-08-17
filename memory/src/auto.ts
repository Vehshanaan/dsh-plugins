/**
 * Automatic memory extraction: after each completed step of a top-level
 * session, a lightweight model call reviews the recent user messages and
 * proposes durable memories; proposals are deduplicated against existing
 * titles and written through the same store as explicit saves. Extraction
 * runs asynchronously and never blocks or fails the session.
 *
 * @module memory/auto
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmRuntime, Message } from '@deepseek-ai/dsh-llm'
import { projectSlug, singleLine, MEMORY_TYPES, type MemoryScope, type MemoryStore, type MemoryType } from './store.ts'
import type { ResolvedAutoExtractConfig } from './types.ts'

/** System prompt of one extraction call: what to remember, the closed type vocabulary, and JSON output. */
const EXTRACT_SYSTEM_PROMPT = [
  'You extract durable facts from a conversation so a coding agent can remember them across sessions.',
  'Extract only facts that will still matter later: the user\'s identity and preferences, corrections or confirmations of agent behavior, project constraints and context not derivable from the code, and pointers to external systems. Skip one-off instructions, code details visible in the repo, and anything the user would not want stored.',
  'Never extract credentials, tokens, or secrets.',
  'Scope: use "project" when the fact is only true for the given project; use "global" when it applies beyond it (user preferences, general working style). When unsure, prefer "project".',
  'Do not propose a memory whose title already exists in the provided existing titles list.',
  'Respond with ONLY a JSON array, each item: {"title": string, "description": string (one line), "type": "user"|"feedback"|"project"|"reference", "scope": "global"|"project", "content": string, "shouldSave": boolean}.',
].join('\n')

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
    return '<unprintable error>'
  }
}

/** Text of one user message event, or '' when it has none. */
function userMessageText(event: { type: string; data?: unknown }): string {
  if (event.type !== 'user/message') return ''
  const data = event.data as { source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }
  if (data.source?.kind !== 'user') return ''
  return (data.content ?? [])
    .map(block => block.type === 'text' ? (block.text ?? '') : `[${block.type}]`)
    .join(' ')
    .trim()
}

/** The most recent user messages of a session, oldest first, bounded per call. */
function recentUserMessages(session: Session, perTurnMax: number, maxChars: number): string[] {
  const texts: string[] = []
  const events = session.events
  for (let index = events.length - 1; index >= 0 && texts.length < perTurnMax; index -= 1) {
    const text = userMessageText(events[index]!)
    if (text === '') continue
    texts.push(text.length > maxChars ? `${text.slice(0, maxChars)}…` : text)
  }
  return texts.reverse()
}

/** Parse a JSON array out of a model reply; malformed replies yield no candidates. */
function parseCandidates(text: string): unknown[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** One validated extraction proposal. */
interface Candidate {
  title: string
  description: string
  type: MemoryType
  scope: MemoryScope
  content: string
}

/** Validate one raw proposal against the closed vocabularies; invalid ones are skipped. */
function toCandidate(raw: unknown): Candidate | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  if (record.shouldSave !== true) return undefined
  const title = singleLine(typeof record.title === 'string' ? record.title : '')
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (title === '' || content === '') return undefined
  const type = record.type
  if (typeof type !== 'string' || !MEMORY_TYPES.includes(type as MemoryType)) return undefined
  const scope = record.scope
  if (scope !== 'global' && scope !== 'project') return undefined
  const description = singleLine(typeof record.description === 'string' ? record.description : title)
  return { title, description, type: type as MemoryType, scope, content }
}

/**
 * Whether one session event should trigger extraction: only completed steps
 * of top-level sessions, and only when the per-session interval elapsed.
 */
export function shouldExtract(
  session: Session,
  event: { type: string },
  lastRun: number | undefined,
  now: number,
  minIntervalMs: number,
): boolean {
  if (event.type !== 'step/end') return false
  if (session.header.origin === 'subagent') return false
  if (now - (lastRun ?? 0) < minIntervalMs) return false
  return true
}

/** Run one extraction pass for a session and write accepted proposals. */
export async function runExtraction(
  session: Session,
  store: MemoryStore,
  llm: LlmRuntime,
  config: ResolvedAutoExtractConfig,
  logger: Pick<Context['logger'], 'info' | 'warn'>,
): Promise<void> {
  const window = recentUserMessages(session, config.perTurnMax, Math.floor(config.maxInputChars / 4))
  if (window.length === 0) return
  const slug = session.header.cwd === undefined ? undefined : projectSlug(session.header.cwd)
  const existingTitles = new Set([
    ...store.list('global').map(entry => entry.title),
    ...(slug === undefined ? [] : store.list('project', slug).map(entry => entry.title)),
  ])
  const frame = {
    project: slug ?? null,
    cwd: session.header.cwd ?? null,
    conversation: window,
    existingTitles: [...existingTitles],
  }
  const framed = JSON.stringify(frame)
  if (framed.length > config.maxInputChars) {
    logger.warn('[memory] auto-extract input exceeds maxInputChars %d; skipping', config.maxInputChars)
    return
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framed }],
    source: { kind: 'plugin', plugin: 'memory' },
  })]
  const assembler = new BlockAssembler()
  for await (const chunk of llm.stream({
    provider: config.provider,
    model: config.model,
    messages,
    system: EXTRACT_SYSTEM_PROMPT,
    maxTokens: config.maxTokens,
  })) {
    assembler.push(chunk)
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`auto-extract stream ended with ${finish.failure.message}`)
  }
  const text = assembler.blocks()
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  let saved = 0
  for (const raw of parseCandidates(text)) {
    const candidate = toCandidate(raw)
    if (candidate === undefined) continue
    if (existingTitles.has(candidate.title)) continue
    if (candidate.scope === 'project' && slug === undefined) continue
    store.save(
      candidate.scope,
      {
        title: candidate.title,
        description: candidate.description,
        type: candidate.type,
        content: candidate.content,
      },
      candidate.scope === 'project' ? slug : undefined,
    )
    existingTitles.add(candidate.title)
    saved += 1
  }
  if (saved > 0) {
    logger.info('[memory] auto-extracted %d memory entr%s', saved, saved === 1 ? 'y' : 'ies')
  }
}

/**
 * Install the automatic extraction listener: serialized per session, rate
 * limited by `minIntervalMs`, and isolated from session failures.
 * @param ctx - registrant context carrying the session event firehose.
 * @param store - the file-backed memory store.
 * @param llm - the composed LLM service.
 * @param config - resolved extraction config.
 */
export function installAutoExtract(
  ctx: Context,
  store: MemoryStore,
  llm: LlmRuntime,
  config: ResolvedAutoExtractConfig,
): void {
  const lastRun = new WeakMap<Session, number>()
  const inflight = new WeakMap<Session, Promise<void>>()
  ctx.on('session/event', (session: Session, event) => {
    if (!shouldExtract(session, event, lastRun.get(session), Date.now(), config.minIntervalMs)) return
    lastRun.set(session, Date.now())
    const chain = (inflight.get(session) ?? Promise.resolve())
      .then(() => runExtraction(session, store, llm, config, ctx.logger))
      .catch((error: unknown) => {
        ctx.logger.warn('[memory] auto-extract failed: %s', errorMessage(error))
      })
    inflight.set(session, chain)
  })
}

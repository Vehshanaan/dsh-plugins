import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** One scripted model reply: a chunk list, a computing function, or a hang-until-abort marker. */
export type MockScriptEntry = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]) | 'hang'

/** Helpers to write scripted responses tersely. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => ({ type: 'text-delta', index: 0, text: char })),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Adapter driven by a script: each model call consumes the next entry and
 * records the request for assertions. `hang` streams one chunk and waits for
 * the caller's abort — a stand-in for a stalled provider.
 */
export class MockAdapter extends LlmAdapter {
  requests: GenerateOptions[] = []

  constructor(private script: MockScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => reject(new Error('aborted'))
        if (options.signal?.aborted) { fail(); return }
        options.signal?.addEventListener('abort', fail, { once: true })
      })
      return
    }
    const chunks = typeof entry === 'function' ? entry(options) : entry
    for (const chunk of chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}
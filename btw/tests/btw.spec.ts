import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import {
  blocksToText,
  failureText,
  limitText,
  renderAnswer,
} from '../src/index.ts'
import { resolveConfig, type BtwConfig } from '../src/types.ts'

const DEFAULT = resolveConfig({})

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    expect(DEFAULT).toEqual({
      provider: 'spawn',
      toolFilter: { allow: [] },
      maxOutputChars: 8000,
    })
  })

  it('keeps every provided field', () => {
    const config: BtwConfig = {
      provider: 'fork',
      toolFilter: { allow: ['read'], deny: ['bash'] },
      persona: 'answer tersely',
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 100 },
      maxOutputChars: 120,
    }
    expect(resolveConfig(config)).toEqual(config)
  })

  it('accepts a deny-only toolFilter', () => {
    expect(resolveConfig({ toolFilter: { deny: ['bash'] } }).toolFilter).toEqual({ deny: ['bash'] })
  })

  it.each([
    ['unknown top-level key', { provider: undefined, nope: 1 }],
    ['blank provider', { provider: '  ' }],
    ['empty toolFilter', { toolFilter: {} }],
    ['blank toolFilter.allow entry', { toolFilter: { allow: [''] } }],
    ['unknown toolFilter key', { toolFilter: { allow: [], nope: [] } }],
    ['blank persona', { persona: '' }],
    ['unknown agentOptions key', { agentOptions: { nope: 1 } }],
    ['zero maxTokens', { agentOptions: { maxTokens: 0 } }],
    ['zero maxOutputChars', { maxOutputChars: 0 }],
    ['fractional maxOutputChars', { maxOutputChars: 1.5 }],
  ])('fails loud on %s', (_label, config) => {
    expect(() => resolveConfig(config as BtwConfig)).toThrow(/^btw: /)
  })
})

describe('blocksToText', () => {
  it('joins text blocks and skips non-text blocks', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'hello ' },
      { type: 'reasoning', text: 'hidden reasoning' },
      { type: 'text', text: 'world' },
    ]
    expect(blocksToText(blocks)).toBe('hello world')
  })

  it('returns an empty string for no text blocks', () => {
    expect(blocksToText([])).toBe('')
  })
})

describe('limitText', () => {
  it('keeps text at or under the cap', () => {
    expect(limitText('abc', 3)).toBe('abc')
    expect(limitText('abc', 10)).toBe('abc')
  })

  it('truncates over-long text with a visible marker', () => {
    expect(limitText('abcdef', 3)).toBe('abc…[已截断]')
  })
})

describe('failureText', () => {
  it('names every known stop reason', () => {
    expect(failureText('aborted')).toBe('旁路提问已取消。')
    expect(failureText('max-tokens')).toBe('回答达到 token 上限，未能完成。')
    expect(failureText('refusal')).toBe('模型拒绝了这个问题。')
    expect(failureText('error')).toBe('旁路提问失败。')
  })

  it('falls through for an unknown reason', () => {
    expect(failureText('mystery' as never)).toBe('旁路提问异常结束（mystery）。')
  })
})

describe('renderAnswer', () => {
  function result(stopReason: SubagentResult['stopReason'], blocks: ContentBlock[]): SubagentResult {
    return { output: blocks, stopReason }
  }

  it('returns a successful answer for a completed run with text', () => {
    expect(renderAnswer(result('completed', [{ type: 'text', text: ' 答案 ' }]), 8000))
      .toEqual({ kind: 'success', text: '答案' })
  })

  it('trims and truncates the answer', () => {
    expect(renderAnswer(result('completed', [{ type: 'text', text: '12345' }]), 3))
      .toEqual({ kind: 'success', text: '123…[已截断]' })
  })

  it('errors on an empty completed answer', () => {
    expect(renderAnswer(result('completed', []), 8000))
      .toEqual({ kind: 'error', text: '模型没有返回回答。' })
  })

  it.each(['aborted', 'max-tokens', 'refusal', 'error'] as const)(
    'errors on a non-completed stop reason (%s)',
    (stopReason) => {
      const answer = renderAnswer(result(stopReason, [{ type: 'text', text: 'partial' }]), 8000)
      expect(answer.kind).toBe('error')
      expect(answer).toEqual({ kind: 'error', text: failureText(stopReason) })
    },
  )
})
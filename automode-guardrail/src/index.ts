import type { Context } from '@deepseek-ai/cordis'

export const name = 'automode-guardrail'

// Loadable stub: the instruction-classifier implementation lands in a separate session.
export function apply(ctx: Context) {
  console.log('[automode-guardrail] plugin loaded (stub)')
}

/**
 * Package-owned invariant companion for `automode-guardrail`.
 * @module automode-guardrail/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'automode-guardrail'

/** Cordis companion plugin name. */
export const name = 'automode-guardrail-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the guardrail appends no package-owned session events.
 * Every model-visible denial is the ordinary `tool/result` event the tools
 * pipeline writes and its own invariants already validate; the decision
 * metadata lives in host logs, which the invariant service does not inspect.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
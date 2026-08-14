/**
 * Package-owned invariant companion for `dsh-btw`.
 * @module dsh-btw/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-btw'

/** Cordis companion plugin name. */
export const name = 'btw-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin owns no independent event sequence or
 * mutable data relation. Command lifecycle pairing is enforced by the
 * `@deepseek-ai/dsh-commands` invariant over the same session log, and the
 * side child session's lifecycle is owned by the `@deepseek-ai/dsh-subagent`
 * seam.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
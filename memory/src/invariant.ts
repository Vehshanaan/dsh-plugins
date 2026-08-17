/**
 * Package-owned invariant companion for `dsh-memory`.
 * @module memory/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-memory'

/** Cordis companion plugin name. */
export const name = 'memory-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No independent session-event sequence: memory writes enter the session log
 * through the ordinary `tool/result` and `command/done` events owned by the
 * `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-commands` invariants, and the
 * on-disk index is rebuilt atomically from the entry directory on every write,
 * so file/index consistency needs no cross-event relation to check.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))

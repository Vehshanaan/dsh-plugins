/**
 * `/vscode` open-in-editor command: open the current session's workspace
 * directory in VS Code (`code <path>`). The command runs entirely on the
 * host — no model turn, no session events beyond the two log-only lifecycle
 * records the command registry writes.
 *
 * Bare `/vscode` opens the session working directory (the "workspace" the
 * session belongs to); `/vscode <relative path>` opens a subpath inside it.
 * Targets are resolved against the session cwd and must stay inside it, so a
 * command can never hand the editor an arbitrary host path.
 *
 * @module dsh-vscode
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
// Type-only: resolves `ctx.commands` and the command vocabulary for the
// conditional command child.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveConfig, type ResolvedVscodeConfig, type VscodeConfig } from './types.ts'

export type { ResolvedVscodeConfig, VscodeConfig } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'vscode'

/** No injected services: the command spawns the editor directly. */
export const inject: string[] = []

/** Plugin config, validated by this schemastery schema and re-checked fail-loud in {@link resolveConfig}. */
export const Config = z.object({
  command: z.string().default('code'),
  args: z.array(z.string()).default([]),
})

/** Spawn signature the command uses; injectable for tests. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** The default spawn: detached fire-and-forget so the editor outlives the host. */
function defaultSpawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  const child = spawn(command, [...args], {
    ...options,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return child
}

/**
 * Resolve a command target inside the workspace. A blank input resolves to
 * the cwd itself; a relative input must stay inside it. Absolute inputs and
 * `..` escapes are rejected.
 * @param cwd - the session working directory.
 * @param rawInput - the command's raw suffix.
 * @returns the absolute target path.
 * @throws when the input escapes the workspace.
 */
export function resolveTargetPath(cwd: string, rawInput: string): string {
  const raw = rawInput.trim()
  const target = raw === '' ? cwd : resolve(cwd, raw)
  const rel = relative(cwd, target)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`目标路径超出工作区：${raw}`)
  }
  return target
}

/**
 * Spawn the editor for one target path. Resolves once the child started;
 * rejects when the spawn itself fails (e.g. the editor CLI is missing).
 * @param command - the editor CLI command.
 * @param extraArgs - configured extra CLI arguments.
 * @param target - the absolute path to open.
 * @param spawnFn - injectable spawn; defaults to the detached fire-and-forget spawn.
 * @returns once the child process started.
 */
export function openInEditor(
  command: string,
  extraArgs: readonly string[],
  target: string,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<void> {
  return new Promise<void>((resolveSpawned, reject) => {
    const child = spawnFn(command, [...extraArgs, target], {
      shell: process.platform === 'win32',
    })
    child.once('error', (error: Error) => { reject(error) })
    child.once('spawn', () => { resolveSpawned() })
  })
}

/** Best-effort message from an arbitrary thrown value. */
function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message
    return String(error)
  } catch {
    return '<不可打印的错误>'
  }
}

/** Stable user-facing failure text for one spawn failure. */
export function spawnFailureText(error: unknown): string {
  const message = errorMessage(error)
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT') {
    return `未检测到编辑器命令（ENOENT）。请确认已安装 VS Code 且 \`code\` 命令可用（macOS 需装 code 命令到 PATH；Windows 使用 \`code.cmd\`）。`
  }
  return `打开失败：${message}`
}

/** One full command execution against a session cwd. */
export interface VscodeInvocation {
  /** The receiving agent (session cwd source). */
  readonly agent: Agent
  /** Exact text following the command name. */
  readonly rawInput: string
}

/**
 * Build the `/vscode` command handler. The spawn is injectable so tests run
 * the full handler without touching the host process table.
 * @param resolved - validated plugin config.
 * @param spawnFn - injectable spawn (defaults to the detached editor spawn).
 * @returns the command handler.
 */
export function createVscodeHandler(
  resolved: ResolvedVscodeConfig,
  spawnFn: SpawnFn = defaultSpawn,
): (invocation: CommandInvocation) => Promise<CommandResult> {
  return async (invocation: CommandInvocation): Promise<CommandResult> => {
    const cwd = invocation.agent.session.header.cwd
    if (cwd === undefined) {
      return { kind: 'error', text: '当前会话没有工作目录，无法打开。' }
    }
    let target: string
    try {
      target = resolveTargetPath(cwd, invocation.rawInput)
    } catch (error: unknown) {
      return { kind: 'error', text: `路径无效：${errorMessage(error)}` }
    }
    try {
      await openInEditor(resolved.command, resolved.args, target, spawnFn)
    } catch (error: unknown) {
      return { kind: 'error', text: spawnFailureText(error) }
    }
    return { kind: 'success', text: `已在 VSCode 中打开 ${target}` }
  }
}

/**
 * Install the plugin: validate config, then register the `/vscode` command
 * when a command registry is composed (the plan-mode pattern).
 * @param ctx - plugin context.
 * @param config - loader-validated config.
 */
export function apply(ctx: Context, config: VscodeConfig): void {
  const resolved = resolveConfig(config)
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'vscode',
      description: '在 VS Code 中打开当前工作区（可带相对路径）',
      input: { hint: '[相对路径]' },
      handler: createVscodeHandler(resolved),
    })
  })
}
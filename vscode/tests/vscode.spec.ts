import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import {
  createVscodeHandler,
  openInEditor,
  resolveTargetPath,
  spawnFailureText,
} from '../src/index.ts'
import { resolveConfig } from '../src/types.ts'

/** Fake spawn result: records the call and lets the test settle either event. */
function fakeChild() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    unref: () => {},
    emitSpawn: () => { emitter.emit('spawn') },
    emitError: (error: Error) => { emitter.emit('error', error) },
  }) as unknown as ChildProcess & { emitSpawn: () => void; emitError: (error: Error) => void }
}

describe('resolveConfig', () => {
  it('applies defaults for an empty config', () => {
    expect(resolveConfig({})).toEqual({ command: 'code', args: [] })
  })

  it('keeps provided fields', () => {
    expect(resolveConfig({ command: 'codium', args: ['--reuse-window'] }))
      .toEqual({ command: 'codium', args: ['--reuse-window'] })
  })

  it.each([
    ['unknown key', { nope: 1 }],
    ['blank command', { command: '  ' }],
    ['non-string args', { args: [1] }],
  ])('fails loud on %s', (_label, config) => {
    expect(() => resolveConfig(config as never)).toThrow(/^vscode: /)
  })
})

describe('resolveTargetPath', () => {
  const cwd = resolve('/work/proj')

  it('resolves a blank input to the cwd itself', () => {
    expect(resolveTargetPath(cwd, '')).toBe(cwd)
    expect(resolveTargetPath(cwd, '   ')).toBe(cwd)
  })

  it('resolves a relative subpath inside the workspace', () => {
    expect(resolveTargetPath(cwd, 'src/app.ts')).toBe(resolve(cwd, 'src/app.ts'))
  })

  it('rejects parent escapes', () => {
    expect(() => resolveTargetPath(cwd, '..')).toThrow(/超出工作区/)
    expect(() => resolveTargetPath(cwd, '../other')).toThrow(/超出工作区/)
  })

  it('rejects absolute inputs outside the workspace', () => {
    const otherRoot = process.platform === 'win32' ? 'C:\\other' : '/other'
    expect(() => resolveTargetPath(cwd, otherRoot)).toThrow(/超出工作区/)
  })
})

describe('spawnFailureText', () => {
  it('names a missing editor CLI', () => {
    const error = Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' })
    expect(spawnFailureText(error)).toContain('未检测到编辑器命令')
    expect(spawnFailureText(error)).toContain('ENOENT')
  })

  it('reports other failures with the raw message', () => {
    expect(spawnFailureText(new Error('boom'))).toBe('打开失败：boom')
  })
})

describe('openInEditor', () => {
  it('resolves when the child spawns', async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const child = fakeChild()
    const spawned = openInEditor('code', ['--reuse-window'], resolve('/work/proj'), (command, args) => {
      calls.push({ command, args: [...args] })
      return child
    })
    child.emitSpawn()
    await spawned
    expect(calls).toEqual([{ command: 'code', args: ['--reuse-window', resolve('/work/proj')] }])
  })

  it('rejects on a spawn error (ENOENT)', async () => {
    const child = fakeChild()
    const spawned = openInEditor('code', [], '/x', () => child)
    child.emitError(Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' }))
    await expect(spawned).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('createVscodeHandler', () => {
  const cwd = resolve('/work/proj')
  const agent = { session: { header: { cwd } } } as never

  it('opens the workspace root for a blank input', async () => {
    const calls: string[][] = []
    const child = fakeChild()
    const handler = createVscodeHandler(resolveConfig({}), (command, args) => {
      calls.push([command, ...args])
      return child
    })
    const pending = handler({ agent, rawInput: '  ' } as never)
    child.emitSpawn()
    const result = await pending
    expect(result).toEqual({ kind: 'success', text: `已在 VSCode 中打开 ${cwd}` })
    expect(calls).toEqual([['code', cwd]])
  })

  it('opens a relative subpath', async () => {
    const calls: string[][] = []
    const child = fakeChild()
    const handler = createVscodeHandler(resolveConfig({}), (command, args) => {
      calls.push([command, ...args])
      return child
    })
    const pending = handler({ agent, rawInput: 'src/main.ts' } as never)
    child.emitSpawn()
    await pending
    expect(calls).toEqual([['code', resolve(cwd, 'src/main.ts')]])
  })

  it('rejects a path escaping the workspace', async () => {
    const handler = createVscodeHandler(resolveConfig({}))
    const result = await handler({ agent, rawInput: '../secret' } as never)
    expect(result.kind).toBe('error')
    expect(result.text).toContain('路径无效')
  })

  it('reports a missing editor CLI', async () => {
    const child = fakeChild()
    const handler = createVscodeHandler(resolveConfig({}), () => child)
    const pending = handler({ agent, rawInput: '' } as never)
    child.emitError(Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' }))
    const result = await pending
    expect(result.kind).toBe('error')
    expect(result.text).toContain('未检测到编辑器命令')
  })

  it('errors when the session has no working directory', async () => {
    const noCwdAgent = { session: { header: {} } } as never
    const handler = createVscodeHandler(resolveConfig({}))
    const result = await handler({ agent: noCwdAgent, rawInput: '' } as never)
    expect(result).toEqual({ kind: 'error', text: '当前会话没有工作目录，无法打开。' })
  })
})
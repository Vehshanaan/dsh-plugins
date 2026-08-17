import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MemoryStore,
  gitRoot,
  projectSlug,
  singleLine,
  slugify,
  utf8Truncate,
} from '../src/store.ts'

let root: string

beforeEach(() => {
  root = join(tmpdir(), `dsh-memory-store-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function store(overrides: { lineLimit?: number; byteLimit?: number } = {}): MemoryStore {
  return new MemoryStore(root, { lineLimit: overrides.lineLimit ?? 200, byteLimit: overrides.byteLimit ?? 25000 })
}

const BASE = { title: '中文回复', description: '用户偏好中文', type: 'user' as const, content: '用户希望所有回复使用中文。' }

describe('slugify', () => {
  it('collapses separators and strips edges', () => {
    expect(slugify('  Hello, World!  ')).toBe('hello-world')
  })
  it('keeps CJK letters', () => {
    expect(slugify('中文 偏好')).toBe('中文-偏好')
  })
  it('falls back to a fixed name for empty input', () => {
    expect(slugify('!!!')).toBe('memory')
  })
  it('bounds length', () => {
    expect(slugify('a'.repeat(200))).toHaveLength(60)
  })
})

describe('singleLine', () => {
  it('collapses whitespace runs', () => {
    expect(singleLine('  a\n\t b  ')).toBe('a b')
  })
})

describe('utf8Truncate', () => {
  it('keeps text under the byte cap untouched', () => {
    expect(utf8Truncate('abc', 10)).toBe('abc')
  })
  it('does not split a multibyte character', () => {
    const cut = utf8Truncate('中文', 4)
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(4)
    expect(cut).toBe('中')
  })
})

describe('gitRoot / projectSlug', () => {
  it('finds the nearest .git ancestor', () => {
    mkdirSync(join(root, 'repo', 'a', 'b'), { recursive: true })
    mkdirSync(join(root, 'repo', '.git'))
    expect(gitRoot(join(root, 'repo', 'a', 'b'))).toBe(join(root, 'repo'))
  })
  it('falls back to the starting directory without a .git', () => {
    expect(gitRoot(join(root, 'nested'))).toBe(join(root, 'nested'))
  })
  it('produces a stable human-readable slug', () => {
    const slug = projectSlug(join(root, 'repo'))
    expect(slug).toMatch(/^repo-[0-9a-f]{8}$/)
    expect(projectSlug(join(root, 'repo'))).toBe(slug)
  })
})

describe('MemoryStore.save', () => {
  it('writes a frontmatter entry and rebuilds the index', () => {
    const result = store().save('global', BASE)
    expect(result.created).toBe(true)
    const file = join(root, 'global', '中文回复.md')
    expect(existsSync(file)).toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('name: 中文回复')
    expect(text).toContain('type: user')
    expect(text).toContain('用户希望所有回复使用中文。')
    const index = readFileSync(join(root, 'MEMORY.md'), 'utf8')
    expect(index).toContain('Memory index (global):')
    expect(index).toContain('- [中文回复](中文回复.md) — user: 用户偏好中文')
  })

  it('updates an existing title in place and keeps created', async () => {
    const s = store()
    const first = s.save('global', BASE)
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = s.save('global', { ...BASE, content: '更新后的内容。' })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    const entry = s.get('global', '中文回复')
    expect(entry?.content).toBe('更新后的内容。')
    expect(entry?.created).toBeLessThan(entry?.updated ?? 0)
    expect(entry?.created).toBeGreaterThan(0)
    const files = s.list('global')
    expect(files).toHaveLength(1)
  })

  it('rejects empty titles and content', () => {
    const s = store()
    expect(() => s.save('global', { ...BASE, title: '   ' })).toThrow(/title/)
    expect(() => s.save('global', { ...BASE, content: '  ' })).toThrow(/content/)
  })

  it('requires a project slug for the project scope', () => {
    const s = store()
    expect(() => s.save('project', BASE)).toThrow(/project slug/)
  })

  it('isolates project entries per slug', () => {
    const s = store()
    s.save('project', BASE, 'repo-a1b2c3d4')
    s.save('project', { ...BASE, title: '另一个', description: '', type: 'reference', content: 'x' }, 'repo-e5f6a7b8')
    expect(s.list('project', 'repo-a1b2c3d4')).toHaveLength(1)
    expect(s.list('project', 'repo-e5f6a7b8')).toHaveLength(1)
    expect(s.list('global')).toHaveLength(0)
  })
})

describe('MemoryStore.remove / move', () => {
  it('removes an entry and rebuilds the index', () => {
    const s = store()
    s.save('global', BASE)
    expect(s.remove('global', '中文回复')).toBe(true)
    expect(s.remove('global', '中文回复')).toBe(false)
    expect(s.list('global')).toHaveLength(0)
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(false)
  })

  it('moves an entry between scopes keeping created', () => {
    const s = store()
    s.save('global', BASE)
    expect(s.move('global', '中文回复', 'project', undefined, 'repo-a1b2c3d4')).toBe(true)
    expect(s.get('global', '中文回复')).toBeUndefined()
    const moved = s.get('project', '中文回复', 'repo-a1b2c3d4')
    expect(moved?.content).toBe(BASE.content)
    expect(moved?.created).toBeGreaterThan(0)
  })
})

describe('MemoryStore.search', () => {
  it('matches title, description, and content case-insensitively', () => {
    const s = store()
    s.save('global', { ...BASE, title: 'Reply Language', description: 'user prefers Chinese', type: 'user', content: 'always answer in Chinese' })
    expect(s.search('chinese', 'all')).toHaveLength(1)
    expect(s.search('prefers', 'all')).toHaveLength(1)
    expect(s.search('REPLY', 'all')).toHaveLength(1)
    expect(s.search('missing')).toHaveLength(0)
    expect(s.search('')).toHaveLength(0)
  })

  it('searches global plus the project scope', () => {
    const s = store()
    s.save('global', BASE)
    s.save('project', { ...BASE, title: '构建', description: 'pnpm', type: 'project', content: 'pnpm workspace' }, 'repo-a1b2c3d4')
    expect(s.search('中文', 'all', 'repo-a1b2c3d4')).toHaveLength(1)
    expect(s.search('pnpm', 'all', 'repo-a1b2c3d4')).toHaveLength(1)
    expect(s.search('pnpm', 'global', 'repo-a1b2c3d4')).toHaveLength(0)
    expect(s.search('pnpm', 'project', 'repo-a1b2c3d4')).toHaveLength(1)
  })

  it('honors the limit and newest-first order', () => {
    const s = store()
    s.save('global', { ...BASE, title: 'a', description: '', type: 'user', content: 'same' })
    s.save('global', { ...BASE, title: 'b', description: '', type: 'user', content: 'same' })
    expect(s.search('same', 'all', undefined, 1)).toHaveLength(1)
    expect(s.search('same', 'all')[0]?.entry.title).toBe('b')
  })
})

describe('renderIndex limits', () => {
  it('truncates by line limit with a marker', () => {
    const s = store({ lineLimit: 2 })
    s.save('global', { ...BASE, title: '一', description: 'x', type: 'user', content: '1' })
    s.save('global', { ...BASE, title: '二', description: 'x', type: 'user', content: '2' })
    s.save('global', { ...BASE, title: '三', description: 'x', type: 'user', content: '3' })
    const text = s.renderIndex('global')
    expect(text).toContain('truncated: kept 2 of 3 entries')
  })

  it('truncates by byte limit with a marker', () => {
    const s = store({ byteLimit: 120 })
    s.save('global', BASE)
    s.save('global', { ...BASE, title: '很长的标题', description: 'd', type: 'user', content: 'x' })
    const text = s.renderIndex('global')
    expect(text).toContain('truncated: byte limit')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(120)
  })

  it('returns empty text for an empty scope', () => {
    expect(store().renderIndex('global')).toBe('')
  })
})

describe('hand-edited entries', () => {
  it('appear in renderIndex immediately', () => {
    const dir = join(root, 'global')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manual.md'), [
      '---',
      'name: 手写记忆',
      'description: 手工添加',
      'type: user',
      'created: 1',
      'updated: 1',
      '---',
      '',
      '手动写的内容。',
      '',
    ].join('\n'))
    const s = store()
    const text = s.renderIndex('global')
    expect(text).toContain('- [手写记忆](manual.md) — user: 手工添加')
    expect(s.get('global', '手写记忆')?.content).toBe('手动写的内容。')
  })

  it('skips malformed files without crashing', () => {
    const dir = join(root, 'global')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.md'), 'no frontmatter here')
    expect(store().renderIndex('global')).toBe('')
  })
})

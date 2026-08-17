/**
 * File-backed memory storage: global and per-project Markdown entries plus a
 * rendered index. Pure Markdown, no database — humans can read and edit every
 * file directly. All writes are atomic (temp file + rename) and rebuild the
 * owning scope's index from the directory, so the index can never drift from
 * the entries.
 *
 * @module memory/store
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Where a memory lives: `global` crosses every project, `project` is scoped to one project. */
export type MemoryScope = 'global' | 'project'

/** Closed classification vocabulary mirroring Claude Code's auto-memory types. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference'

/** Valid scope values, as a runtime list for input narrowing. */
export const MEMORY_SCOPES: readonly MemoryScope[] = ['global', 'project']

/** Valid type values, as a runtime list for input narrowing. */
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference']

/** Index file name inside each memory directory. */
export const INDEX_FILE = 'MEMORY.md'

/** One parsed memory entry. */
export interface MemoryEntry {
  /** Unique display title; also the stable file-name key (same title updates the same file). */
  title: string
  /** One-line description shown in the index. */
  description: string
  type: MemoryType
  /** Free-form markdown body. */
  content: string
  /** First-write epoch milliseconds; preserved across updates. */
  created: number
  /** Last-write epoch milliseconds. */
  updated: number
  /** Entry file name inside its scope directory. */
  fileName: string
}

/** Result of one save. */
export interface MemoryWriteResult {
  fileName: string
  /** Whether a new file was created (false = an existing entry with the same title was updated). */
  created: boolean
}

/** Index render limits applied on every rebuild. */
export interface IndexLimits {
  lineLimit: number
  byteLimit: number
}

/** One search hit: the entry plus the scope it was found in. */
export interface MemorySearchHit {
  scope: MemoryScope
  entry: MemoryEntry
}

/** Collapse runs of non-letter/non-digit characters to `-` and bound the length. */
export function slugify(text: string): string {
  const slug = text.toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug === '' ? 'memory' : slug
}

/** Find the nearest ancestor directory containing a `.git` entry (dir or worktree file). */
export function gitRoot(start: string): string {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

/**
 * Stable human-readable project key: `<dirName>-<hash8>` over the git root
 * (or the cwd when no git root exists). Case-folded on Windows-style paths so
 * one checkout maps to one directory on every platform.
 */
export function projectSlug(cwd: string): string {
  const root = gitRoot(cwd)
  const base = slugify(basename(root))
  const hash = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 8)
  return `${base}-${hash}`
}

/** Collapse whitespace runs to single spaces and trim — entry headers are single-line. */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** UTF-8-safe truncation to at most `bytes` bytes without splitting a character. */
export function utf8Truncate(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= bytes) return text
  return buffer.subarray(0, bytes).toString('utf8').replace(/\uFFFD+$/g, '')
}

/** Parse one entry file into a {@link MemoryEntry}; malformed files are skipped. */
function parseEntryFile(filePath: string, fileName: string): MemoryEntry | undefined {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  if (!text.startsWith('---\n')) return undefined
  const headerEnd = text.indexOf('\n---\n', 4)
  if (headerEnd < 0) return undefined
  const fields: Record<string, string> = {}
  for (const line of text.slice(4, headerEnd).split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  const title = fields['name'] ?? ''
  const type = fields['type'] as MemoryType | undefined
  const created = Number(fields['created'])
  const updated = Number(fields['updated'])
  if (title === '' || type === undefined || !MEMORY_TYPES.includes(type)
    || !Number.isSafeInteger(created) || created < 0
    || !Number.isSafeInteger(updated) || updated < 0) {
    return undefined
  }
  const body = text.slice(headerEnd + 5).replace(/^\n+|\s+$/g, '')
  return {
    title,
    description: fields['description'] ?? '',
    type,
    content: body,
    created,
    updated,
    fileName,
  }
}

/**
 * Render the model-facing index text for a scope: a heading line, one line
 * per entry (newest first), with the configured line/byte limits enforced.
 */
export function renderIndexText(entries: readonly MemoryEntry[], heading: string, limits: IndexLimits): string {
  if (entries.length === 0) return ''
  const lineFor = (entry: MemoryEntry): string =>
    `- [${entry.title.replace(/[[\]]/g, '')}](${entry.fileName}) — ${entry.type}: ${entry.description}`
  let lines = entries.map(lineFor)
  let text = `${heading}\n${lines.join('\n')}`
  if (lines.length > limits.lineLimit) {
    lines = lines.slice(0, limits.lineLimit)
    text = `${heading}\n${lines.join('\n')}\n- (memory index truncated: kept ${lines.length} of ${entries.length} entries)`
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > limits.byteLimit) {
    const marker = '\n(memory index truncated: byte limit)'
    const kept = utf8Truncate(text, Math.max(limits.byteLimit - Buffer.byteLength(marker, 'utf8'), 1))
    text = `${kept}${marker}`
  }
  return text
}

/** Write via a sibling temp file then rename — atomic on the same filesystem. */
function writeAtomic(filePath: string, content: string): void {
  const temp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temp, content, 'utf8')
  renameSync(temp, filePath)
}

/** Delete one file, ignoring absence. */
function removeFile(filePath: string): void {
  try {
    rmSync(filePath)
  } catch {
    // absence or a transient error: the index rebuild below stays consistent
  }
}

/** Serialize one entry to its file content. */
function serializeEntry(entry: { title: string; description: string; type: MemoryType; created: number; updated: number; content: string }): string {
  const header = [
    '---',
    `name: ${entry.title}`,
    `description: ${entry.description}`,
    `type: ${entry.type}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    '---',
    '',
  ].join('\n')
  return `${header}${entry.content}\n`
}

/**
 * File-backed memory store over one root directory.
 *
 * Layout:
 * ```
 * <root>/MEMORY.md                 global index (rendered, human-readable)
 * <root>/global/<title>.md         global entries
 * <root>/projects/<slug>/MEMORY.md project index
 * <root>/projects/<slug>/<title>.md project entries
 * ```
 */
export class MemoryStore {
  /**
   * Create one store.
   * @param root - absolute memory root (see `ResolvedConfig.root`).
   * @param limits - index render limits.
   */
  constructor(
    readonly root: string,
    readonly limits: IndexLimits,
  ) {}

  /** Absolute directory owning the entries of one scope. */
  dirFor(scope: MemoryScope, project?: string): string {
    return scope === 'global'
      ? join(this.root, 'global')
      : join(this.root, 'projects', project ?? '')
  }

  /** Absolute path of one scope's rendered index file (the global index lives at the root). */
  indexFile(scope: MemoryScope, project?: string): string {
    return scope === 'global'
      ? join(this.root, INDEX_FILE)
      : join(this.dirFor('project', project), INDEX_FILE)
  }

  /** Heading line for one scope's index. */
  private headingFor(scope: MemoryScope, project?: string): string {
    return scope === 'global'
      ? 'Memory index (global):'
      : `Memory index (project ${project ?? ''}):`
  }

  /** List every parsed entry of one scope, newest-updated first. */
  list(scope: MemoryScope, project?: string): MemoryEntry[] {
    const dir = this.dirFor(scope, project)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const entries: MemoryEntry[] = []
    for (const name of names) {
      if (name === INDEX_FILE || !name.endsWith('.md')) continue
      const entry = parseEntryFile(join(dir, name), name)
      if (entry !== undefined) entries.push(entry)
    }
    return entries.sort((a, b) => b.updated - a.updated)
  }

  /** Find one entry by exact title. */
  get(scope: MemoryScope, title: string, project?: string): MemoryEntry | undefined {
    const wanted = title.trim()
    if (wanted === '') return undefined
    return this.list(scope, project).find(entry => entry.title === wanted)
  }

  /**
   * Save one entry. A title already present in the scope updates that entry
   * (the file name is the slugified title) and keeps the original `created`.
   * @param scope - target scope.
   * @param input - entry fields; title and content must be non-empty after trimming.
   * @param project - required project slug when `scope` is `project`.
   * @returns the write result.
   */
  save(
    scope: MemoryScope,
    input: { title: string; description: string; type: MemoryType; content: string },
    project?: string,
  ): MemoryWriteResult {
    if (scope === 'project' && (project === undefined || project === '')) {
      throw new Error('memory save: scope "project" requires a project slug')
    }
    const title = singleLine(input.title)
    const description = singleLine(input.description)
    const content = input.content.trim()
    if (title === '') throw new Error('memory save: title must be a non-empty string')
    if (content === '') throw new Error('memory save: content must be a non-empty string')
    const dir = this.dirFor(scope, project)
    mkdirSync(dir, { recursive: true })
    const fileName = `${slugify(title)}.md`
    const filePath = join(dir, fileName)
    const existing = this.get(scope, title, project)
    const created = existing === undefined
    const now = Date.now()
    writeAtomic(filePath, serializeEntry({
      title,
      description,
      type: input.type,
      created: existing?.created ?? now,
      updated: now,
      content,
    }))
    this.rebuildIndex(scope, project)
    return { fileName, created }
  }

  /**
   * Delete one entry by title.
   * @returns whether an entry was removed.
   */
  remove(scope: MemoryScope, title: string, project?: string): boolean {
    const entry = this.get(scope, title, project)
    if (entry === undefined) return false
    removeFile(join(this.dirFor(scope, project), entry.fileName))
    this.rebuildIndex(scope, project)
    return true
  }

  /**
   * Move one entry to another scope (and optionally another project), keeping
   * its creation timestamp. Source and target indexes are both rebuilt.
   * @returns whether an entry was moved.
   */
  move(
    scope: MemoryScope,
    title: string,
    targetScope: MemoryScope,
    project?: string,
    targetProject?: string,
  ): boolean {
    const entry = this.get(scope, title, project)
    if (entry === undefined) return false
    if (targetScope === 'project' && (targetProject === undefined || targetProject === '')) {
      throw new Error('memory move: target scope "project" requires a project slug')
    }
    const targetDir = this.dirFor(targetScope, targetProject)
    mkdirSync(targetDir, { recursive: true })
    writeAtomic(join(targetDir, entry.fileName), serializeEntry(entry))
    removeFile(join(this.dirFor(scope, project), entry.fileName))
    this.rebuildIndex(scope, project)
    this.rebuildIndex(targetScope, targetProject)
    return true
  }

  /**
   * Case-insensitive substring search over title, description, and content.
   * @param query - the search words; an empty query matches nothing.
   * @param scope - `all` searches global plus the project scope when `project` is given.
   * @param project - project slug for the project scope.
   * @param limit - maximum results (default 10).
   */
  search(
    query: string,
    scope: MemoryScope | 'all' = 'all',
    project?: string,
    limit = 10,
  ): MemorySearchHit[] {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    const hits: MemorySearchHit[] = [
      ...this.list('global').map(entry => ({ scope: 'global' as const, entry })),
      ...(scope === 'all' || scope === 'project') && project !== undefined
        ? this.list('project', project).map(entry => ({ scope: 'project' as const, entry }))
        : [],
    ]
    return hits
      .filter(hit => hit.entry.title.toLowerCase().includes(needle)
        || hit.entry.description.toLowerCase().includes(needle)
        || hit.entry.content.toLowerCase().includes(needle))
      .sort((a, b) => b.entry.updated - a.entry.updated)
      .slice(0, limit)
  }

  /**
   * Render one scope's index as model-facing text. Rendered live from the
   * directory, so hand-edited entries appear immediately.
   */
  renderIndex(scope: MemoryScope, project?: string): string {
    return renderIndexText(this.list(scope, project), this.headingFor(scope, project), this.limits)
  }

  /** Rebuild one scope's on-disk index file from its directory listing. */
  private rebuildIndex(scope: MemoryScope, project?: string): void {
    const dir = this.dirFor(scope, project)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    const entries: MemoryEntry[] = []
    for (const name of names) {
      if (name === INDEX_FILE || !name.endsWith('.md')) continue
      const entry = parseEntryFile(join(dir, name), name)
      if (entry !== undefined) entries.push(entry)
    }
    entries.sort((a, b) => b.updated - a.updated)
    const text = renderIndexText(entries, this.headingFor(scope, project), this.limits)
    if (text === '') {
      removeFile(this.indexFile(scope, project))
      return
    }
    writeAtomic(this.indexFile(scope, project), `${text}\n`)
  }
}

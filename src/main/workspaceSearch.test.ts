import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { ripgrepPath } from './ripgrep'
import {
  QUERY_MAX,
  WorkspaceSearch,
  folderPaths,
  nameHits,
  parseSearchRequest,
} from './workspaceSearch'

const RG = ripgrepPath(resolve(__dirname, '../..'), process.platform, process.arch)

const request = (root: string, text: string, extra: Record<string, unknown> = {}) => ({
  root,
  text,
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  includeIgnored: false,
  ...extra,
})

describe('parseSearchRequest', () => {
  it('keeps only booleans that are true and refuses an empty or oversized text', () => {
    expect(parseSearchRequest({ root: '/r', text: 'a', regex: 'yes' })).toEqual(request('/r', 'a'))
    expect(parseSearchRequest({ root: '/r', text: '  ' })).toBeNull()
    expect(parseSearchRequest({ root: '/r', text: 'x'.repeat(QUERY_MAX + 1) })).toBeNull()
    expect(parseSearchRequest({ text: 'a' })).toBeNull()
    expect(parseSearchRequest(null)).toBeNull()
  })
})

describe('folderPaths', () => {
  it('lists every folder that holds a file, once', () => {
    expect(folderPaths(['src/main/a.ts', 'src/main/b.ts', 'README.md']).sort()).toEqual([
      'src',
      'src/main',
    ])
  })
})

describe('nameHits', () => {
  const files = ['src/main/search.ts', 'src/renderer/Search.tsx', 'docs/readme.md']

  it('matches files and folders by name', () => {
    const hits = nameHits('main', files, 10)
    expect(hits[0]).toMatchObject({ path: 'src/main', dir: true })
    expect(hits.some((h) => h.path === 'src/main/search.ts' && !h.dir)).toBe(true)
  })

  it('matches only folders when the query ends in /', () => {
    const hits = nameHits('src/', files, 10)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.dir)).toBe(true)
  })

  it('stops at the limit', () => {
    expect(nameHits('s', files, 2)).toHaveLength(2)
  })
})

describe('WorkspaceSearch', () => {
  let home: string
  let root: string

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'ostia-search-'))
    root = join(home, 'project')
    mkdirSync(join(root, 'src', 'notes'), { recursive: true })
    mkdirSync(join(root, 'build'))
    writeFileSync(join(root, 'src', 'notes', 'todo.md'), 'first line\nfind the needle here\n')
    writeFileSync(join(root, 'build', 'out.txt'), 'needle in a built file\n')
    writeFileSync(join(root, '.gitignore'), 'build/\n')
    writeFileSync(join(root, 'src', 'paper.PDF'), '%PDF-1.4\n')
    mkdirSync(join(root, '.git'))
  })

  it('finds folder names, file names and text in one run', async () => {
    const search = new WorkspaceSearch(RG, [home])
    const res = await search.run(1, request(root, 'notes'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.results.root).toBe(root)
    expect(res.results.names[0]).toMatchObject({ path: 'src/notes', dir: true })

    const text = await search.run(1, request(root, 'needle'))
    if (!text.ok) throw new Error(text.message)
    expect(text.results.files).toEqual([
      {
        path: 'src/notes/todo.md',
        matches: [{ line: 2, column: 10, text: 'find the needle here', ranges: [[9, 15]] }],
      },
    ])
  })

  it('lists the PDFs under the folder with their size and time', async () => {
    const search = new WorkspaceSearch(RG, [home])
    const res = await search.run(1, request(root, 'paper'))
    if (!res.ok) throw new Error(res.message)
    expect(res.results.pdfs).toEqual([
      { path: 'src/paper.PDF', size: 9, mtimeMs: expect.any(Number) },
    ])
  })

  it('searches gitignored files only when asked', async () => {
    const search = new WorkspaceSearch(RG, [home])
    const res = await search.run(1, request(root, 'needle', { includeIgnored: true }))
    if (!res.ok) throw new Error(res.message)
    expect(res.results.files.map((f) => f.path)).toEqual(['build/out.txt', 'src/notes/todo.md'])
  })

  it('refuses a folder outside the allowed roots', async () => {
    const search = new WorkspaceSearch(RG, [root])
    expect(await search.run(1, request(home, 'needle'))).toMatchObject({
      ok: false,
      error: 'outside-roots',
    })
  })

  it('reports an invalid regex', async () => {
    const search = new WorkspaceSearch(RG, [home])
    expect(await search.run(1, request(root, 'bad(', { regex: true }))).toMatchObject({
      ok: false,
      error: 'invalid-pattern',
    })
  })

  it('cancels a caller’s earlier search when it starts a new one', async () => {
    const search = new WorkspaceSearch(RG, [home])
    const first = search.run(7, request(root, 'needle'))
    const second = search.run(7, request(root, 'line'))
    expect(await first).toMatchObject({ ok: false, error: 'cancelled' })
    expect((await second).ok).toBe(true)
  })
})

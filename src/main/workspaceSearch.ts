import { statSync } from 'node:fs'
import { ipcMain } from 'electron'
import type { SearchNameHit, SearchOutcome, SearchRequest, SearchResults } from '../shared/search'
import { fuzzyMatch } from './fuzzyPaths'
import { resolveSafe } from './pathGuard'
import { type FileList, type RgOutcome, listFiles, searchText } from './ripgrep'

export const QUERY_MAX = 1000
export const NAME_LIMIT = 50
const FILE_LIST_TTL_MS = 10_000

export function parseSearchRequest(raw: unknown): SearchRequest | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.root !== 'string' || !r.root) return null
  if (typeof r.text !== 'string' || !r.text.trim() || r.text.length > QUERY_MAX) return null
  return {
    root: r.root,
    text: r.text,
    regex: r.regex === true,
    caseSensitive: r.caseSensitive === true,
    wholeWord: r.wholeWord === true,
    includeIgnored: r.includeIgnored === true,
  }
}

export function folderPaths(files: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const file of files) {
    let slash = file.indexOf('/')
    while (slash > 0) {
      folders.add(file.slice(0, slash))
      slash = file.indexOf('/', slash + 1)
    }
  }
  return [...folders]
}

export function nameHits(text: string, files: readonly string[], limit: number): SearchNameHit[] {
  const foldersOnly = text.trimEnd().endsWith('/')
  const query = foldersOnly ? text.trimEnd().replace(/\/+$/, '') : text
  if (!query.trim()) return []
  const candidates = [
    ...folderPaths(files).map((path) => ({ path, dir: true })),
    ...(foldersOnly ? [] : files.map((path) => ({ path, dir: false }))),
  ]
  const hits: (SearchNameHit & { score: number })[] = []
  for (const { path, dir } of candidates) {
    const hit = fuzzyMatch(query, path)
    if (hit) hits.push({ path, dir, positions: hit.positions, score: hit.score })
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return hits.slice(0, limit).map(({ score: _score, ...hit }) => hit)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export class WorkspaceSearch {
  private lists = new Map<string, { at: number; list: Promise<RgOutcome<FileList>> }>()
  private running = new Map<number, AbortController>()

  constructor(
    private readonly bin: string,
    private readonly roots: string[],
  ) {}

  private fileList(root: string, includeIgnored: boolean): Promise<RgOutcome<FileList>> {
    const key = `${includeIgnored ? 'all' : 'tracked'}:${root}`
    const cached = this.lists.get(key)
    if (cached && Date.now() - cached.at < FILE_LIST_TTL_MS) return cached.list
    const list = listFiles(this.bin, root, includeIgnored)
    this.lists.set(key, { at: Date.now(), list })
    void list.then((res) => {
      if (!res.ok && this.lists.get(key)?.list === list) this.lists.delete(key)
    })
    return list
  }

  async run(caller: number, raw: unknown): Promise<SearchOutcome> {
    const req = parseSearchRequest(raw)
    if (!req) return { ok: false, error: 'failed', message: 'invalid search' }
    const root = resolveSafe(req.root, this.roots)
    if (root === null || !isDirectory(root)) {
      return { ok: false, error: 'outside-roots', message: '' }
    }
    this.running.get(caller)?.abort()
    const controller = new AbortController()
    this.running.set(caller, controller)
    try {
      const [list, text] = await Promise.all([
        this.fileList(root, req.includeIgnored),
        searchText(this.bin, root, req, controller.signal),
      ])
      if (!text.ok) return text
      if (!list.ok) return list
      const results: SearchResults = {
        root,
        names: nameHits(req.text, list.value.paths, NAME_LIMIT),
        files: text.value.files,
        matches: text.value.matches,
        truncated: text.value.truncated,
      }
      return { ok: true, results }
    } finally {
      if (this.running.get(caller) === controller) this.running.delete(caller)
    }
  }
}

export function registerSearchIpc(bin: string, roots: string[]): void {
  const search = new WorkspaceSearch(bin, roots)
  ipcMain.handle('search:run', (e, req: unknown) => search.run(e.sender.id, req))
}

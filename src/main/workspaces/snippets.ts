import { lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  parseSnippet,
  type Snippet,
  type SnippetEntry,
  type SnippetListing,
  type SnippetProblem,
  type SnippetSaveResult,
  type SnippetSource,
  snippetDocument,
  snippetFileStem,
} from '@aurigax-ai/ostia-extension-sdk/contract/snippets'
import { ipcMain } from 'electron'
import { parseAllDocuments, stringify } from 'yaml'
import { registerControlMethod } from '../control/controlServer'
import { PROJECT_DIR } from '../platform/jsonStore'
import { resolveSafe } from '../platform/pathGuard'
import { readRegularFileSync } from '../platform/regularFileSync'

export const SNIPPET_FILE_MAX_BYTES = 64 * 1024
export const SNIPPET_FILES_MAX = 200
const SNIPPETS_PER_FILE_MAX = 50
const SNIPPET_FILE = /\.ya?ml$/i
const SAVE_ATTEMPTS = 100

interface ExtensionSnippets {
  extId: string
  snippets: Snippet[]
}

export interface SnippetSources {
  userDir: string
  workDir?: string
  extensions: ExtensionSnippets[]
}

export function workspaceSnippetsDir(workDir: string): string {
  return join(workDir, PROJECT_DIR, 'snippets')
}

function workspaceSnippets(workDir: string): SnippetListing {
  let real: string
  try {
    real = realpathSync(workDir)
  } catch {
    return { snippets: [], problems: [] }
  }
  if (!isRealDir(join(real, PROJECT_DIR))) return { snippets: [], problems: [] }
  return readSnippetDir(workspaceSnippetsDir(real), 'workspace')
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function parseSnippetFile(text: string): Snippet[] | Error {
  const docs = parseAllDocuments(text)
  if (!Array.isArray(docs)) return new Error('not a YAML document stream')
  const out: Snippet[] = []
  for (const doc of docs) {
    if (doc.errors.length > 0) return new Error(doc.errors[0].message.split('\n')[0])
    let value: unknown
    try {
      value = doc.toJS({ maxAliasCount: 0 })
    } catch (err) {
      return err as Error
    }
    if (value === null || value === undefined) continue
    const items = Array.isArray(value) ? value : [value]
    for (const [i, item] of items.entries()) {
      const snippet = parseSnippet(item)
      if (snippet instanceof Error) {
        return items.length > 1 ? new Error(`item ${i + 1}: ${snippet.message}`) : snippet
      }
      out.push(snippet)
    }
  }
  if (out.length > SNIPPETS_PER_FILE_MAX) {
    return new Error(`more than ${SNIPPETS_PER_FILE_MAX} snippets in one file`)
  }
  return out
}

const READ_ERRORS = {
  unreadable: 'not readable',
  'not-a-file': 'not a regular file',
  moved: 'symbolic links are not read',
  'too-large': `larger than ${SNIPPET_FILE_MAX_BYTES / 1024} KiB`,
} as const

function readFile(path: string): string | Error {
  const read = readRegularFileSync(path, SNIPPET_FILE_MAX_BYTES)
  return read.ok ? read.body.toString('utf8') : new Error(READ_ERRORS[read.error])
}

export function readSnippetDir(dir: string, source: SnippetSource): SnippetListing {
  const listing: SnippetListing = { snippets: [], problems: [] }
  if (!isRealDir(dir)) return listing
  let base: string
  let names: string[]
  try {
    base = realpathSync(dir)
    names = readdirSync(base)
      .filter((n) => SNIPPET_FILE.test(n))
      .sort()
  } catch {
    return listing
  }
  if (names.length > SNIPPET_FILES_MAX) {
    listing.problems.push({
      source,
      origin: basename(dir),
      error: `only the first ${SNIPPET_FILES_MAX} files are read`,
    })
    names = names.slice(0, SNIPPET_FILES_MAX)
  }
  for (const name of names) {
    const text = readFile(join(base, name))
    const parsed = text instanceof Error ? text : parseSnippetFile(text)
    if (parsed instanceof Error) {
      listing.problems.push({ source, origin: name, error: parsed.message })
      continue
    }
    for (const w of parsed) listing.snippets.push({ ...w, source, origin: name })
  }
  return listing
}

export function loadSnippets(sources: SnippetSources): SnippetListing {
  const parts: SnippetListing[] = []
  if (sources.workDir) parts.push(workspaceSnippets(sources.workDir))
  parts.push(readSnippetDir(sources.userDir, 'user'))
  const snippets: SnippetEntry[] = parts.flatMap((p) => p.snippets)
  const problems: SnippetProblem[] = parts.flatMap((p) => p.problems)
  for (const ext of sources.extensions) {
    for (const w of ext.snippets) snippets.push({ ...w, source: 'extension', origin: ext.extId })
  }
  return { snippets, problems }
}

export function saveSnippet(userDir: string, raw: unknown): SnippetSaveResult {
  const snippet = parseSnippet(raw)
  if (snippet instanceof Error) return { ok: false, error: snippet.message }
  try {
    mkdirSync(userDir, { recursive: true, mode: 0o700 })
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  if (!isRealDir(userDir)) return { ok: false, error: 'the snippets folder is not a directory' }
  const text = stringify(snippetDocument(snippet), { lineWidth: 0 })
  const stem = snippetFileStem(snippet.name)
  for (let n = 1; n <= SAVE_ATTEMPTS; n++) {
    const file = n === 1 ? `${stem}.yaml` : `${stem}-${n}.yaml`
    try {
      writeFileSync(join(userDir, file), text, { flag: 'wx', mode: 0o600 })
      return { ok: true, file }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, error: (err as Error).message }
      }
    }
  }
  return { ok: false, error: 'too many snippets with this name' }
}

export interface SnippetDeps {
  userDir: string
  roots: () => string[]
  workDirForWorkspace: (workspaceId?: string) => string | undefined
  extensionSnippets: () => ExtensionSnippets[]
}

function listFor(deps: SnippetDeps, workspaceId: string | null | undefined): SnippetListing {
  const workDir = deps.workDirForWorkspace(workspaceId ?? undefined)
  const safe = workDir ? resolveSafe(workDir, deps.roots()) : null
  return loadSnippets({
    userDir: deps.userDir,
    workDir: safe ?? undefined,
    extensions: deps.extensionSnippets(),
  })
}

export function ownSnippets(deps: SnippetDeps, workspaceId: string | undefined): SnippetEntry[] {
  return listFor({ ...deps, extensionSnippets: () => [] }, workspaceId).snippets
}

export function registerSnippetIpc(deps: SnippetDeps): void {
  ipcMain.handle('snippets:list', (_e, workspaceId: unknown) =>
    listFor(deps, typeof workspaceId === 'string' ? workspaceId : null),
  )
  ipcMain.handle('snippets:save', (_e, doc: unknown) => saveSnippet(deps.userDir, doc))
}

export function registerSnippetMethods(deps: SnippetDeps): void {
  registerControlMethod('snippet.list', {
    cap: 'read-board',
    handler: (_params, ctx) => listFor(deps, ctx.identity.workspaceId),
  })
}

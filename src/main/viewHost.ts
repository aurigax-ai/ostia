import { type FSWatcher, lstatSync, mkdirSync, readFileSync, readdirSync, watch } from 'node:fs'
import { join } from 'node:path'
import { debounce } from 'es-toolkit'
import {
  VIEW_FILES_MAX,
  VIEW_FILE_MAX_BYTES,
  type ViewDoc,
  type ViewInfo,
  type ViewListing,
  type ViewProblem,
  type ViewStatus,
  parseViewText,
  viewNameOf,
} from '../shared/views'
import { loadJson, saveJson } from './jsonStore'

const RESCAN_DEBOUNCE_MS = 150

export interface ViewRecord {
  enabled: boolean
}

function sanitize(raw: unknown): Record<string, ViewRecord> {
  const out: Record<string, ViewRecord> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (viewNameOf(`${name}.json`) === null) continue
    if (typeof value !== 'object' || value === null) continue
    Object.defineProperty(out, name, {
      value: { enabled: (value as { enabled?: unknown }).enabled === true },
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

export class ViewStore {
  private records: Record<string, ViewRecord>

  constructor(private readonly path: string) {
    this.records = sanitize(loadJson<unknown>(path, {}))
  }

  get(name: string): ViewRecord | undefined {
    return Object.hasOwn(this.records, name) ? this.records[name] : undefined
  }

  set(name: string, record: ViewRecord): void {
    this.records = { ...this.records, [name]: record }
    saveJson(this.path, this.records)
  }
}

interface LoadedFile {
  name: string
  file: string
  doc: ViewDoc | null
  problems: ViewProblem[]
}

export function readViewFile(path: string): { text: string } | { error: string } {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (err) {
    return { error: (err as Error).message }
  }
  if (stat.isSymbolicLink()) return { error: 'symbolic links are not read' }
  if (!stat.isFile()) return { error: 'not a regular file' }
  if (stat.size > VIEW_FILE_MAX_BYTES) {
    return { error: `larger than ${VIEW_FILE_MAX_BYTES / 1024} KiB` }
  }
  try {
    return { text: readFileSync(path, 'utf8') }
  } catch (err) {
    return { error: (err as Error).message }
  }
}

function loadFile(dir: string, fileName: string, name: string): LoadedFile {
  const file = join(dir, fileName)
  const read = readViewFile(file)
  if ('error' in read) {
    return { name, file, doc: null, problems: [{ path: '(file)', message: read.error }] }
  }
  const parsed = parseViewText(read.text)
  return parsed.ok
    ? { name, file, doc: parsed.doc, problems: [] }
    : { name, file, doc: null, problems: parsed.problems }
}

function isRealDir(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export interface ViewHostDeps {
  dir: string
  store: ViewStore
  onChange: (listing: ViewListing) => void
  log?: (line: string) => void
}

export class ViewHost {
  private files = new Map<string, LoadedFile>()
  private lastGood = new Map<string, ViewDoc>()
  private watcher: FSWatcher | null = null
  private readonly schedule = debounce(() => this.rescan(), RESCAN_DEBOUNCE_MS)
  private signature = ''

  constructor(private readonly deps: ViewHostDeps) {
    this.scan()
  }

  private scanFiles(): Map<string, LoadedFile> {
    const out = new Map<string, LoadedFile>()
    if (!isRealDir(this.deps.dir)) return out
    let names: string[]
    try {
      names = readdirSync(this.deps.dir).sort()
    } catch {
      return out
    }
    for (const fileName of names) {
      const name = viewNameOf(fileName)
      if (!name) continue
      if (out.size >= VIEW_FILES_MAX) {
        this.deps.log?.(`only the first ${VIEW_FILES_MAX} view files are read`)
        break
      }
      out.set(name, loadFile(this.deps.dir, fileName, name))
    }
    return out
  }

  scan(): boolean {
    this.files = this.scanFiles()
    for (const [name, loaded] of this.files) {
      if (loaded.doc) this.lastGood.set(name, loaded.doc)
    }
    for (const name of [...this.lastGood.keys()]) {
      if (!this.files.has(name)) this.lastGood.delete(name)
    }
    const signature = JSON.stringify(this.list())
    const changed = signature !== this.signature
    this.signature = signature
    return changed
  }

  private status(name: string): ViewStatus {
    const record = this.deps.store.get(name)
    if (!record) return 'pending'
    return record.enabled ? 'enabled' : 'disabled'
  }

  info(name: string): ViewInfo | null {
    const loaded = this.files.get(name)
    if (!loaded) return null
    const status = this.status(name)
    const shown = loaded.doc ?? this.lastGood.get(name) ?? null
    return {
      name,
      file: loaded.file,
      status,
      title: shown?.title ?? name,
      placement: shown?.placement ?? null,
      ...(shown?.icon ? { icon: shown.icon } : {}),
      ...(shown?.description ? { description: shown.description } : {}),
      doc: status === 'enabled' ? shown : null,
      stale: loaded.doc === null && shown !== null,
      problems: loaded.problems,
    }
  }

  list(): ViewInfo[] {
    return [...this.files.keys()].flatMap((name) => this.info(name) ?? [])
  }

  listing(): ViewListing {
    return { dir: this.deps.dir, views: this.list() }
  }

  setEnabled(name: string, enabled: boolean): ViewListing {
    if (this.files.has(name)) {
      this.deps.store.set(name, { enabled })
      this.signature = JSON.stringify(this.list())
      this.deps.onChange(this.listing())
    }
    return this.listing()
  }

  pathOf(name: string): string | null {
    return this.files.get(name)?.file ?? null
  }

  rescan(): void {
    if (this.scan()) this.deps.onChange(this.listing())
  }

  watch(): void {
    try {
      mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 })
    } catch (err) {
      this.deps.log?.(`cannot create ${this.deps.dir}: ${(err as Error).message}`)
    }
    this.rescan()
    if (!isRealDir(this.deps.dir)) return
    try {
      this.watcher = watch(this.deps.dir, () => this.schedule())
      this.watcher.on('error', () => this.schedule())
    } catch (err) {
      this.deps.log?.(`cannot watch ${this.deps.dir}: ${(err as Error).message}`)
    }
  }

  stop(): void {
    this.watcher?.close()
    this.watcher = null
    this.schedule.cancel()
  }
}

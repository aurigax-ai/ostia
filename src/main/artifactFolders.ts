import {
  type Dirent,
  type FSWatcher,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  watch,
} from 'node:fs'
import { extname, join, sep } from 'node:path'
import { ipcMain, shell } from 'electron'
import {
  ARTIFACT_KEEP_CLOSED_MS,
  ARTIFACT_LIST_MAX,
  type ArtifactChange,
  type ArtifactEntry,
  type ArtifactListing,
  PAD_FILE,
  artifactChanges,
} from '../shared/artifacts'

const FOLDER_NAME = 'artifacts'
const CLOSED_DIR = '.closed'
const CLOSED_NAME = /^(.+)-(\d+)$/
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const WATCH_DEBOUNCE_MS = 150
const SNAPSHOT_MAX = 20_000

export interface ArtifactFolderDeps {
  root: string
  scratchDirOf: (workspaceId: string) => string | null
  scratchDirs: () => string[]
  now?: () => number
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function regularFile(path: string, name: string): ArtifactEntry | null {
  try {
    const st = lstatSync(path)
    return st.isFile() ? { name, path, size: st.size, modified: st.mtimeMs } : null
  } catch {
    return null
  }
}

function privateDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch {
    return false
  }
  return isRealDir(dir)
}

export function listArtifacts(dir: string, max: number = ARTIFACT_LIST_MAX): ArtifactEntry[] {
  const found: ArtifactEntry[] = []
  for (const entry of entriesOf(dir)) {
    const path = join(dir, entry.name)
    if (entry.isFile()) {
      const file = regularFile(path, entry.name)
      if (file && entry.name !== PAD_FILE) found.push(file)
    } else if (entry.isDirectory()) {
      for (const child of entriesOf(path)) {
        if (!child.isFile()) continue
        const file = regularFile(join(path, child.name), `${entry.name}/${child.name}`)
        if (file) found.push(file)
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name)).slice(0, max)
}

function freeName(dir: string, name: string): string {
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let candidate = name
  for (let n = 2; pathExists(join(dir, candidate)); n += 1) candidate = `${stem}-${n}${ext}`
  return candidate
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

export class ArtifactFolders {
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number

  private readonly seen = new Map<string, Map<string, number>>()

  constructor(
    private readonly deps: ArtifactFolderDeps,
    private readonly changed: (workspaceId: string, changes: ArtifactChange[]) => void = () => {},
  ) {
    this.now = deps.now ?? Date.now
  }

  get root(): string {
    return this.deps.root
  }

  dirOf(workspaceId: string): string | null {
    if (!WORKSPACE_ID.test(workspaceId)) return null
    const scratch = this.deps.scratchDirOf(workspaceId)
    return scratch ? join(scratch, FOLDER_NAME) : join(this.deps.root, workspaceId)
  }

  ensure(workspaceId: string): string | null {
    const dir = this.dirOf(workspaceId)
    if (!dir || !privateDir(dir)) return null
    this.watch(workspaceId, dir)
    return dir
  }

  followed(workspaceId: string): string | null {
    const dir = this.dirOf(workspaceId)
    if (!dir) return null
    if (!pathExists(dir)) return dir
    if (!isRealDir(dir)) return null
    this.watch(workspaceId, dir)
    return dir
  }

  holds(path: string): boolean {
    const closed = join(this.deps.root, CLOSED_DIR)
    if (path === closed || path.startsWith(`${closed}${sep}`)) return false
    if (path.startsWith(`${this.deps.root}${sep}`)) return true
    return this.deps.scratchDirs().some((scratch) => {
      const folder = join(scratch, FOLDER_NAME)
      return path === folder || path.startsWith(`${folder}${sep}`)
    })
  }

  padOf(workspaceId: string): string | null {
    const dir = this.dirOf(workspaceId)
    return dir ? join(dir, PAD_FILE) : null
  }

  ensurePad(workspaceId: string): string | null {
    const dir = this.ensure(workspaceId)
    if (!dir) return null
    const pad = join(dir, PAD_FILE)
    try {
      closeSync(openSync(pad, 'wx', 0o600))
    } catch {}
    return regularFile(pad, PAD_FILE) ? pad : null
  }

  listing(workspaceId: string): ArtifactListing | null {
    const dir = this.ensure(workspaceId)
    if (!dir) return null
    const pad = join(dir, PAD_FILE)
    return {
      dir,
      pad,
      padModified: regularFile(pad, PAD_FILE)?.modified ?? null,
      entries: listArtifacts(dir),
    }
  }

  private watch(workspaceId: string, dir: string): void {
    if (this.watchers.has(workspaceId)) return
    try {
      const watcher = watch(dir, { recursive: true }, () => this.schedule(workspaceId))
      watcher.on('error', () => this.unwatch(workspaceId))
      this.watchers.set(workspaceId, watcher)
      this.seen.set(workspaceId, this.snapshot(dir))
    } catch {}
  }

  private snapshot(dir: string): Map<string, number> {
    const files = new Map(
      listArtifacts(dir, SNAPSHOT_MAX).map((entry) => [entry.name, entry.modified]),
    )
    const pad = regularFile(join(dir, PAD_FILE), PAD_FILE)
    if (pad) files.set(PAD_FILE, pad.modified)
    return files
  }

  private report(workspaceId: string): void {
    const dir = this.dirOf(workspaceId)
    if (!dir) return
    const after = this.snapshot(dir)
    const changes = artifactChanges(this.seen.get(workspaceId) ?? new Map(), after)
    this.seen.set(workspaceId, after)
    this.changed(workspaceId, changes)
  }

  private schedule(workspaceId: string): void {
    if (this.timers.has(workspaceId)) return
    this.timers.set(
      workspaceId,
      setTimeout(() => {
        this.timers.delete(workspaceId)
        if (this.watchers.has(workspaceId)) this.report(workspaceId)
      }, WATCH_DEBOUNCE_MS),
    )
  }

  private unwatch(workspaceId: string): void {
    this.watchers.get(workspaceId)?.close()
    this.watchers.delete(workspaceId)
    this.seen.delete(workspaceId)
    const timer = this.timers.get(workspaceId)
    if (timer) clearTimeout(timer)
    this.timers.delete(workspaceId)
  }

  close(workspaceId: string): void {
    this.unwatch(workspaceId)
    const dir = this.dirOf(workspaceId)
    if (!dir || this.deps.scratchDirOf(workspaceId) || !isRealDir(dir)) return
    if (entriesOf(dir).length === 0) {
      try {
        rmdirSync(dir)
      } catch {}
      return
    }
    const closed = join(this.deps.root, CLOSED_DIR)
    if (!privateDir(closed)) return
    try {
      renameSync(dir, join(closed, `${workspaceId}-${this.now()}`))
    } catch {}
  }

  merge(sourceId: string, targetId: string): void {
    const source = this.dirOf(sourceId)
    if (!source || !isRealDir(source)) return
    const target = this.ensure(targetId)
    if (!target) return
    for (const entry of entriesOf(source)) {
      if (entry.name === PAD_FILE || (!entry.isFile() && !entry.isDirectory())) continue
      try {
        renameSync(join(source, entry.name), join(target, freeName(target, entry.name)))
      } catch {}
    }
    this.report(targetId)
  }

  sweep(): string[] {
    const closed = join(this.deps.root, CLOSED_DIR)
    const removed: string[] = []
    for (const entry of entriesOf(closed)) {
      const match = CLOSED_NAME.exec(entry.name)
      if (!match || this.now() - Number(match[2]) < ARTIFACT_KEEP_CLOSED_MS) continue
      const dir = join(closed, entry.name)
      rmSync(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }

  dispose(): void {
    for (const workspaceId of [...this.watchers.keys()]) this.unwatch(workspaceId)
  }
}

export interface ArtifactIpcDeps {
  folders: ArtifactFolders
  ownsWorkspace: (windowId: string, workspaceId: string) => boolean
}

export function registerArtifactIpc(deps: ArtifactIpcDeps): void {
  const owned = (
    e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
    id: unknown,
  ): id is string => typeof id === 'string' && deps.ownsWorkspace(String(e.sender.id), id)

  ipcMain.handle('artifacts:list', (e, workspaceId: unknown): ArtifactListing | null =>
    owned(e, workspaceId) ? deps.folders.listing(workspaceId) : null,
  )
  ipcMain.handle('artifacts:pad', (e, workspaceId: unknown): string | null =>
    owned(e, workspaceId) ? deps.folders.ensurePad(workspaceId) : null,
  )
  ipcMain.on('artifacts:reveal', (e, workspaceId: unknown) => {
    const dir = owned(e, workspaceId) ? deps.folders.ensure(workspaceId) : null
    if (dir) void shell.openPath(dir)
  })
}

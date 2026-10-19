import { randomBytes } from 'node:crypto'
import { type Dirent, lstatSync, mkdirSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { ipcMain, shell } from 'electron'
import { processAlive } from '../platform/processAlive'

export const SCRATCH_HISTORY_FILE = `.${PRODUCT_NAME}_history`

const FOLDER_NAME = /^(\d+)-[0-9a-f]{12}$/
const COUNT_CAP = 10_000
const REMOVE_RETRIES = 4
const REMOVE_RETRY_STEP_MS = 25
const RETRYABLE = new Set(['ENOTEMPTY', 'EBUSY'])

export interface ScratchFailure {
  dir: string
  code: string
}

interface ScratchFolder {
  dir: string
  windowId: string
  workspaceId?: string
}

function isRealDir(path: string): boolean {
  try {
    const st = lstatSync(path)
    return st.isDirectory() && !st.isSymbolicLink()
  } catch {
    return false
  }
}

function entries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

async function removeDir(dir: string): Promise<ScratchFailure | null> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return null
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      if (attempt >= REMOVE_RETRIES || !RETRYABLE.has(code)) return { dir, code }
      await pause(REMOVE_RETRY_STEP_MS * (attempt + 1))
    }
  }
}

export function countScratchFiles(dir: string): number {
  let count = 0
  const pending = [dir]
  while (pending.length > 0 && count < COUNT_CAP) {
    const current = pending.pop() as string
    for (const entry of entries(current)) {
      if (current === dir && entry.name === SCRATCH_HISTORY_FILE) continue
      if (entry.isDirectory()) pending.push(join(current, entry.name))
      else count += 1
      if (count >= COUNT_CAP) break
    }
  }
  return count
}

export class ScratchFolders {
  private readonly folders = new Map<string, ScratchFolder>()
  private readonly removing = new Set<Promise<ScratchFailure | null>>()

  constructor(
    readonly root: string,
    private readonly pid: number = process.pid,
    private readonly alive: (pid: number) => boolean = processAlive,
  ) {}

  create(windowId: string): string {
    const dir = join(this.root, `${this.pid}-${randomBytes(6).toString('hex')}`)
    mkdirSync(dir, { mode: 0o700 })
    if (!isRealDir(dir)) throw new Error(`refusing to use ${dir}: not a directory`)
    this.folders.set(dir, { dir, windowId })
    return dir
  }

  bind(workspaceId: string, dir: string, windowId: string): boolean {
    const folder = this.folders.get(dir)
    if (!folder || folder.windowId !== windowId || folder.workspaceId) return false
    if (this.folderOf(workspaceId)) return false
    folder.workspaceId = workspaceId
    return true
  }

  private folderOf(workspaceId: string): ScratchFolder | undefined {
    for (const folder of this.folders.values()) {
      if (folder.workspaceId === workspaceId) return folder
    }
    return undefined
  }

  dirOf(workspaceId: string | undefined): string | null {
    return workspaceId ? (this.folderOf(workspaceId)?.dir ?? null) : null
  }

  isScratch(workspaceId: string | undefined): boolean {
    return this.dirOf(workspaceId) !== null
  }

  historyFile(workspaceId: string | undefined): string | null {
    const dir = this.dirOf(workspaceId)
    return dir ? join(dir, SCRATCH_HISTORY_FILE) : null
  }

  dirs(): string[] {
    return [...this.folders.keys()]
  }

  workspaceIds(): string[] {
    return [...this.folders.values()].flatMap((f) => (f.workspaceId ? [f.workspaceId] : []))
  }

  countFiles(workspaceId: string): number {
    const dir = this.dirOf(workspaceId)
    return dir && isRealDir(dir) ? countScratchFiles(dir) : 0
  }

  private track(dir: string): Promise<ScratchFailure | null> {
    const removal = removeDir(dir).finally(() => this.removing.delete(removal))
    this.removing.add(removal)
    return removal
  }

  remove(workspaceId: string): Promise<ScratchFailure | null> {
    const folder = this.folderOf(workspaceId)
    if (!folder) return Promise.resolve(null)
    this.folders.delete(folder.dir)
    return this.track(folder.dir)
  }

  async removeAll(): Promise<ScratchFailure[]> {
    const dirs = [...this.folders.keys()]
    this.folders.clear()
    const pending = [...this.removing, ...dirs.map((dir) => this.track(dir))]
    const results = await Promise.all(pending)
    return results.filter((failure): failure is ScratchFailure => failure !== null)
  }

  async sweep(): Promise<string[]> {
    const removed: string[] = []
    for (const entry of entries(this.root)) {
      const match = FOLDER_NAME.exec(entry.name)
      if (!match) continue
      const pid = Number(match[1])
      if (pid === this.pid || this.alive(pid)) continue
      const dir = join(this.root, entry.name)
      await rm(dir, { recursive: true, force: true })
      removed.push(dir)
    }
    return removed
  }
}

export function registerScratchIpc(folders: ScratchFolders): void {
  ipcMain.handle('scratch:create', (e): string | null => {
    try {
      return folders.create(String(e.sender.id))
    } catch (err) {
      console.error('[scratch] folder could not be created', err)
      return null
    }
  })
  ipcMain.handle('scratch:files', (_e, workspaceId: unknown): number =>
    typeof workspaceId === 'string' ? folders.countFiles(workspaceId) : 0,
  )
  ipcMain.on('scratch:reveal', (_e, workspaceId: unknown) => {
    const dir = typeof workspaceId === 'string' ? folders.dirOf(workspaceId) : null
    if (dir) void shell.openPath(dir)
  })
}

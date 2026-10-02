import { randomBytes } from 'node:crypto'
import { type Dirent, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain, shell } from 'electron'
import { processAlive } from './processAlive'

export const SCRATCH_HISTORY_FILE = '.pine_history'

const FOLDER_NAME = /^(\d+)-[0-9a-f]{12}$/
const COUNT_CAP = 10_000

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

  workspaceIds(): string[] {
    return [...this.folders.values()].flatMap((f) => (f.workspaceId ? [f.workspaceId] : []))
  }

  countFiles(workspaceId: string): number {
    const dir = this.dirOf(workspaceId)
    return dir && isRealDir(dir) ? countScratchFiles(dir) : 0
  }

  remove(workspaceId: string): void {
    const folder = this.folderOf(workspaceId)
    if (!folder) return
    this.folders.delete(folder.dir)
    rmSync(folder.dir, { recursive: true, force: true })
  }

  removeAll(): void {
    for (const dir of this.folders.keys()) rmSync(dir, { recursive: true, force: true })
    this.folders.clear()
  }

  sweep(): string[] {
    const removed: string[] = []
    for (const entry of entries(this.root)) {
      const match = FOLDER_NAME.exec(entry.name)
      if (!match) continue
      const pid = Number(match[1])
      if (pid === this.pid || this.alive(pid)) continue
      const dir = join(this.root, entry.name)
      rmSync(dir, { recursive: true, force: true })
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

import { createHash } from 'node:crypto'
import {
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { ipcMain } from 'electron'
import {
  type ArtifactRestore,
  type ArtifactVersion,
  type ArtifactVersionContent,
  PAD_FILE,
} from '../../shared/artifacts/artifacts'
import type { PreviewTheme } from '../../shared/artifacts/htmlPreview'
import { PORTABLE_LIMITS, portableType } from '../../shared/artifacts/portable'
import type { PreviewBuild } from './htmlPreview'
import { type PreviewSource, readRegularFile } from './previewFiles'

export const HISTORY_DIR = '.history'
const HISTORY_LIMITS = {
  quietMs: 2_000,
  perArtifact: 20,
  workspaceBytes: 64 * 1024 * 1024,
} as const

const COPIED = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.pdf'])
const VERSION_NAME = /^(\d+)-([0-9a-f]{16})(\.\w+)$/
const MANIFEST = /<script type="application\/json" id="ostia-artifact">([^<]*)<\/script>/
const SRCDOC = /<iframe [^>]*srcdoc="([^"]*)"/
const WRITE_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW

export interface ArtifactHistoryDeps {
  root: string
  folderOf: (workspaceId: string) => string | null
  isScratch: (workspaceId: string) => boolean
  make: (file: string) => Promise<string | null>
  now?: () => number
  quietMs?: number
}

interface StoredVersion extends ArtifactVersion {
  path: string
  hash: string
}

interface Manifest {
  hash?: string
  sources?: Record<string, string>
}

function sha(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function unescapeAttribute(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

function manifestOf(text: string): Manifest | null {
  const raw = MANIFEST.exec(text)?.[1]
  if (!raw) return null
  try {
    return JSON.parse(raw) as Manifest
  } catch {
    return null
  }
}

function isRegular(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

function isCopied(name: string): boolean {
  return COPIED.has(extname(name).toLowerCase())
}

function keeps(name: string): boolean {
  return name !== PAD_FILE && (portableType(name) !== null || isCopied(name))
}

export class ArtifactHistory {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, Promise<boolean>>()
  private readonly now: () => number

  constructor(private readonly deps: ArtifactHistoryDeps) {
    this.now = deps.now ?? Date.now
  }

  get root(): string {
    return join(this.deps.root, HISTORY_DIR)
  }

  dirOf(workspaceId: string): string {
    return join(this.root, workspaceId)
  }

  holds(path: string): boolean {
    return path === this.root || path.startsWith(`${this.root}${sep}`)
  }

  private nameOf(workspaceId: string, path: string): string | null {
    const folder = this.deps.folderOf(workspaceId)
    if (!folder || dirname(path) !== folder) return null
    const name = basename(path)
    return keeps(name) ? name : null
  }

  private versionsDir(workspaceId: string, name: string): string {
    return join(this.dirOf(workspaceId), encodeURIComponent(name))
  }

  changed(workspaceId: string, path: string): void {
    if (!this.nameOf(workspaceId, path)) return
    const key = `${workspaceId}\0${path}`
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key)
        void this.snapshot(workspaceId, path)
      }, this.deps.quietMs ?? HISTORY_LIMITS.quietMs),
    )
  }

  snapshot(workspaceId: string, path: string): Promise<boolean> {
    const key = `${workspaceId}\0${path}`
    const before = this.running.get(key) ?? Promise.resolve(false)
    const next = before.then(() => this.take(workspaceId, path))
    this.running.set(key, next)
    void next.finally(() => {
      if (this.running.get(key) === next) this.running.delete(key)
    })
    return next
  }

  private async take(workspaceId: string, path: string): Promise<boolean> {
    const name = this.nameOf(workspaceId, path)
    if (!name || !isRegular(path)) return false
    let body: Buffer
    let hash: string
    if (isCopied(name)) {
      const read = await readRegularFile(path, PORTABLE_LIMITS.fileBytes)
      if (!read.ok) return false
      body = read.body
      hash = sha(read.body)
    } else {
      const text = await this.deps.make(path).catch(() => null)
      if (!text) return false
      body = Buffer.from(text)
      hash = manifestOf(text)?.hash ?? sha(text)
    }
    const short = hash.slice(0, 16)
    if (this.stored(workspaceId, name)[0]?.hash === short) return false
    const dir = this.versionsDir(workspaceId, name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const extension = isCopied(name) ? extname(name).toLowerCase() : '.html'
    await writeFile(join(dir, `${this.now()}-${short}${extension}`), body, { mode: 0o600 })
    this.prune(workspaceId, name)
    return true
  }

  private stored(workspaceId: string, name: string): StoredVersion[] {
    const dir = this.versionsDir(workspaceId, name)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const versions = names.flatMap((file): StoredVersion[] => {
      const match = VERSION_NAME.exec(file)
      if (!match) return []
      const path = join(dir, file)
      try {
        const size = statSync(path).size
        return [{ id: file, time: Number(match[1]), size, hash: match[2], path, current: false }]
      } catch {
        return []
      }
    })
    versions.sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
    if (versions[0]) versions[0].current = true
    return versions
  }

  private allStored(workspaceId: string): StoredVersion[] {
    let names: string[]
    try {
      names = readdirSync(this.dirOf(workspaceId))
    } catch {
      return []
    }
    return names.flatMap((encoded) => {
      try {
        return this.stored(workspaceId, decodeURIComponent(encoded))
      } catch {
        return []
      }
    })
  }

  bytes(workspaceId: string): number {
    return this.allStored(workspaceId).reduce((sum, version) => sum + version.size, 0)
  }

  private prune(workspaceId: string, name: string): void {
    for (const old of this.stored(workspaceId, name).slice(HISTORY_LIMITS.perArtifact)) {
      rmSync(old.path, { force: true })
    }
    const all = this.allStored(workspaceId).sort((a, b) => a.time - b.time)
    let total = all.reduce((sum, version) => sum + version.size, 0)
    for (const old of all) {
      if (total <= HISTORY_LIMITS.workspaceBytes) break
      rmSync(old.path, { force: true })
      total -= old.size
    }
  }

  list(workspaceId: string, path: string): ArtifactVersion[] {
    const name = this.nameOf(workspaceId, path)
    if (!name) return []
    return this.stored(workspaceId, name).map(({ id, time, size, current }) => ({
      id,
      time,
      size,
      current,
    }))
  }

  version(workspaceId: string, path: string, id: string): ArtifactVersionContent | null {
    const name = this.nameOf(workspaceId, path)
    if (!name) return null
    const found = this.stored(workspaceId, name).find((version) => version.id === id)
    if (!found) return null
    const type = portableType(name) ?? extname(name).slice(1).toLowerCase()
    if (isCopied(name)) return { file: found.path, type, sources: {} }
    const manifest = manifestOf(readFileSync(found.path, 'utf8'))
    return { file: found.path, type, sources: manifest?.sources ?? {} }
  }

  document(file: string): string | null {
    if (!this.holds(file) || !isRegular(file)) return null
    const raw = SRCDOC.exec(readFileSync(file, 'utf8'))?.[1]
    return raw === undefined ? null : unescapeAttribute(raw)
  }

  async restore(workspaceId: string, path: string, id: string): Promise<ArtifactRestore | null> {
    const folder = this.deps.folderOf(workspaceId)
    const name = this.nameOf(workspaceId, path)
    if (!folder || !name) return null
    const found = this.stored(workspaceId, name).find((version) => version.id === id)
    if (!found) return null
    await this.snapshot(workspaceId, path)
    const sources: [string, string | Buffer][] = isCopied(name)
      ? [[name, readFileSync(found.path)]]
      : Object.entries(manifestOf(readFileSync(found.path, 'utf8'))?.sources ?? {})
    const restored: string[] = []
    const refused: string[] = []
    for (const [rel, body] of sources) {
      const target = join(folder, rel)
      const inside = relative(folder, normalize(target))
      const escapes = isAbsolute(rel) || inside === '' || inside.startsWith('..')
      if (!escapes && !rel.includes('\0') && (await writeInside(folder, target, body))) {
        restored.push(rel)
      } else {
        refused.push(rel)
      }
    }
    await this.snapshot(workspaceId, path)
    return { restored, refused }
  }

  close(workspaceId: string, closedDir: string | null): void {
    const dir = this.dirOf(workspaceId)
    if (!existsSync(dir)) return
    if (this.deps.isScratch(workspaceId) || !closedDir) {
      rmSync(dir, { recursive: true, force: true })
      return
    }
    try {
      renameSync(dir, join(closedDir, HISTORY_DIR))
    } catch {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  merge(source: string, target: string, renames: readonly [string, string][]): void {
    const from = this.dirOf(source)
    if (!existsSync(from)) return
    for (const [before, after] of renames) {
      const old = join(from, encodeURIComponent(before))
      if (!existsSync(old)) continue
      const next = join(this.dirOf(target), encodeURIComponent(after))
      mkdirSync(next, { recursive: true, mode: 0o700 })
      for (const file of readdirSync(old)) {
        try {
          renameSync(join(old, file), join(next, file))
        } catch {}
      }
    }
    rmSync(from, { recursive: true, force: true })
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}

async function writeInside(folder: string, target: string, body: string | Buffer) {
  for (let dir = dirname(target); dir.startsWith(`${folder}${sep}`); dir = dirname(dir)) {
    if (existsSync(dir) && !lstatSync(dir).isDirectory()) return false
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target) && !lstatSync(target).isFile()) return false
    const handle = await open(target, WRITE_FLAGS, 0o600)
    try {
      await handle.writeFile(body)
    } finally {
      await handle.close()
    }
    return true
  } catch {
    return false
  }
}

export function previewBuild(
  history: ArtifactHistory,
  build: (source: PreviewSource, theme: PreviewTheme) => Promise<PreviewBuild>,
): (source: PreviewSource, theme: PreviewTheme) => Promise<PreviewBuild> {
  return async (source, theme) => {
    if (!history.holds(source.file)) return build(source, theme)
    return { document: history.document(source.file) ?? '', inputs: [source.file] }
  }
}

export interface ArtifactHistoryIpcDeps {
  history: ArtifactHistory
  ownsWorkspace: (windowId: string, workspaceId: string) => boolean
}

export function registerArtifactHistoryIpc(deps: ArtifactHistoryIpcDeps): void {
  const owned = (e: Electron.IpcMainInvokeEvent, workspaceId: unknown, path: unknown): boolean =>
    typeof workspaceId === 'string' &&
    typeof path === 'string' &&
    deps.ownsWorkspace(String(e.sender.id), workspaceId)
  ipcMain.handle('artifacts:versions', (e, workspaceId: unknown, path: unknown) =>
    owned(e, workspaceId, path) ? deps.history.list(String(workspaceId), String(path)) : null,
  )
  ipcMain.handle('artifacts:version', (e, workspaceId: unknown, path: unknown, id: unknown) =>
    owned(e, workspaceId, path) && typeof id === 'string'
      ? deps.history.version(String(workspaceId), String(path), id)
      : null,
  )
  ipcMain.handle('artifacts:restore', (e, workspaceId: unknown, path: unknown, id: unknown) =>
    owned(e, workspaceId, path) && typeof id === 'string'
      ? deps.history.restore(String(workspaceId), String(path), id)
      : null,
  )
}

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { ipcMain } from 'electron'

export interface ArtifactProducersDeps {
  file: (workspaceId: string) => string
  folderOf: (workspaceId: string) => string | null
}

function isRegular(path: string): boolean {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

export class ArtifactProducers {
  private readonly loaded = new Map<string, Map<string, string>>()

  constructor(private readonly deps: ArtifactProducersDeps) {}

  private load(workspaceId: string): Map<string, string> {
    const held = this.loaded.get(workspaceId)
    if (held) return held
    let entries: [string, string][] = []
    try {
      const raw = JSON.parse(readFileSync(this.deps.file(workspaceId), 'utf8')) as unknown
      if (raw && typeof raw === 'object') {
        entries = Object.entries(raw).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
      }
    } catch {}
    const map = new Map(entries)
    this.loaded.set(workspaceId, map)
    return map
  }

  private save(workspaceId: string): void {
    const file = this.deps.file(workspaceId)
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify(Object.fromEntries(this.load(workspaceId))), {
        mode: 0o600,
      })
    } catch {}
  }

  private holds(workspaceId: string, path: string): boolean {
    const folder = this.deps.folderOf(workspaceId)
    if (!folder) return false
    const inside = relative(folder, path)
    if (inside === '' || inside.startsWith('..') || inside.split(sep).length > 2) return false
    return isRegular(path)
  }

  note(workspaceId: string, paneId: string, path: string): boolean {
    if (!this.holds(workspaceId, path)) return false
    const map = this.load(workspaceId)
    if (map.has(path)) return false
    map.set(path, paneId)
    this.save(workspaceId)
    return true
  }

  of(workspaceId: string): Record<string, string> {
    const map = this.load(workspaceId)
    let pruned = false
    for (const path of [...map.keys()]) {
      if (this.holds(workspaceId, path)) continue
      map.delete(path)
      pruned = true
    }
    if (pruned) this.save(workspaceId)
    return Object.fromEntries(map)
  }

  paneClosed(paneId: string): void {
    for (const [workspaceId, map] of this.loaded) {
      let changed = false
      for (const [path, owner] of [...map]) {
        if (owner !== paneId) continue
        map.delete(path)
        changed = true
      }
      if (changed) this.save(workspaceId)
    }
  }

  merge(source: string, target: string, moved: readonly [string, string][]): void {
    const from = this.load(source)
    const into = this.load(target)
    const sourceFolder = this.deps.folderOf(source)
    const targetFolder = this.deps.folderOf(target)
    if (sourceFolder && targetFolder) {
      const renamed = new Map(moved)
      for (const [path, owner] of from) {
        const [first, ...rest] = relative(sourceFolder, path).split(sep)
        const after = renamed.get(first)
        if (!after) continue
        const next = join(targetFolder, after, ...rest)
        if (!into.has(next)) into.set(next, owner)
      }
    }
    this.loaded.delete(source)
    this.save(target)
  }
}

export function registerArtifactProducersIpc(deps: {
  producers: ArtifactProducers
  ownsWorkspace: (windowId: string, workspaceId: string) => boolean
}): void {
  ipcMain.handle('artifacts:producers', (e, workspaceId: unknown) =>
    typeof workspaceId === 'string' && deps.ownsWorkspace(String(e.sender.id), workspaceId)
      ? deps.producers.of(workspaceId)
      : null,
  )
}

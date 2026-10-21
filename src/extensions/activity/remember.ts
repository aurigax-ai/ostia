import {
  closeSync,
  constants,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { storableWorkspaceId } from './archive'
import {
  isExpired,
  parseRememberItem,
  REMEMBER_VERSION,
  type RememberItem,
  type RememberState,
  startOf,
} from './rememberItem'

export const REMEMBER_DIR = 'remember'
const FILE_SUFFIX = '.json'
const FILE_MODE = 0o600
const DIR_MODE = 0o700

interface WorkspaceItems {
  items: RememberItem[]
  onDisk: boolean
}

export interface RememberOptions {
  dir: string | null
  now: () => number
}

export class RememberStore {
  private readonly byWorkspace = new Map<string, WorkspaceItems>()
  private readonly revisions = new Map<string, number>()
  private sequence = 0
  private readonly dir: string | null

  constructor(private readonly options: RememberOptions) {
    this.dir = options.dir ? join(options.dir, REMEMBER_DIR) : null
  }

  load(): void {
    if (!this.dir) return
    let names: string[] = []
    try {
      names = readdirSync(this.dir)
    } catch {
      return
    }
    for (const name of names) {
      const workspaceId = name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : ''
      if (!storableWorkspaceId(workspaceId)) continue
      const items = this.readFile(workspaceId)
      if (items) this.byWorkspace.set(workspaceId, { items, onDisk: true })
    }
  }

  revision(workspaceId: string): number {
    return this.revisions.get(workspaceId) ?? 0
  }

  workspaceIds(): string[] {
    return [...this.byWorkspace.keys()]
  }

  items(workspaceId: string): readonly RememberItem[] {
    return this.byWorkspace.get(workspaceId)?.items ?? []
  }

  find(workspaceId: string, id: string): RememberItem | null {
    return this.items(workspaceId).find((item) => item.id === id) ?? null
  }

  openBySession(workspaceId: string): Map<string, number> {
    const counts = new Map<string, number>()
    for (const item of this.items(workspaceId)) {
      if (item.state === 'open') counts.set(item.session, (counts.get(item.session) ?? 0) + 1)
    }
    return counts
  }

  openCount(workspaceId: string): number {
    return this.items(workspaceId).filter((item) => item.state === 'open').length
  }

  add(workspaceId: string, item: RememberItem, persist: boolean): void {
    const entry = this.byWorkspace.get(workspaceId) ?? this.create(workspaceId, persist)
    if (entry.onDisk && !persist) {
      entry.onDisk = false
      this.removeFile(workspaceId)
    }
    entry.items.push(item)
    this.save(workspaceId, entry)
  }

  setState(workspaceId: string, id: string, state: RememberState, at: number): RememberItem | null {
    const entry = this.byWorkspace.get(workspaceId)
    const index = entry?.items.findIndex((item) => item.id === id) ?? -1
    const found = entry?.items[index]
    if (!entry || !found) return null
    if (found.state === state) return found
    const { doneAt: _done, archivedAt: _archived, ...kept } = found
    const next: RememberItem = { ...kept, state }
    if (state === 'done') next.doneAt = at
    if (state === 'archived') next.archivedAt = at
    if (state === 'open') next.restoredAt = at
    entry.items[index] = next
    this.save(workspaceId, entry)
    return next
  }

  adopt(workspaceId: string, pane: string, agent: string, session: string): number {
    const entry = this.byWorkspace.get(workspaceId)
    if (!entry) return 0
    let moved = 0
    entry.items = entry.items.map((item) => {
      if (item.state !== 'open' || item.pane !== pane || item.agent !== agent) return item
      if (item.session === session) return item
      moved++
      return { ...item, session }
    })
    if (moved > 0) this.save(workspaceId, entry)
    return moved
  }

  forSession(workspaceId: string, session: string, now: number, days: number): RememberItem[] {
    return this.items(workspaceId)
      .filter(
        (item) => item.state === 'open' && item.session === session && !isExpired(item, now, days),
      )
      .sort((a, b) => startOf(b) - startOf(a))
  }

  expire(now: number, days: number): boolean {
    let changed = false
    for (const [workspaceId, entry] of this.byWorkspace) {
      let moved = false
      entry.items = entry.items.map((item) => {
        if (item.state !== 'open' || !isExpired(item, now, days)) return item
        moved = true
        const { doneAt: _done, ...rest } = item
        return { ...rest, state: 'archived' as const, archivedAt: now }
      })
      if (moved) {
        this.save(workspaceId, entry)
        changed = true
      }
    }
    return changed
  }

  dropClosedMemory(open: ReadonlySet<string>): boolean {
    let dropped = false
    for (const [workspaceId, entry] of this.byWorkspace) {
      if (entry.onDisk || open.has(workspaceId)) continue
      this.byWorkspace.delete(workspaceId)
      this.touch(workspaceId)
      dropped = true
    }
    return dropped
  }

  private create(workspaceId: string, persist: boolean): WorkspaceItems {
    const entry = {
      items: [],
      onDisk: persist && this.dir !== null && storableWorkspaceId(workspaceId),
    }
    this.byWorkspace.set(workspaceId, entry)
    return entry
  }

  private touch(workspaceId: string): void {
    this.revisions.set(workspaceId, ++this.sequence)
  }

  private save(workspaceId: string, entry: WorkspaceItems): void {
    this.touch(workspaceId)
    if (!entry.onDisk || !this.dir) return
    try {
      writeFileAtomic(
        join(this.dir, `${workspaceId}${FILE_SUFFIX}`),
        `${JSON.stringify({ v: REMEMBER_VERSION, items: entry.items })}\n`,
        { mode: FILE_MODE, dirMode: DIR_MODE },
      )
    } catch {
      entry.onDisk = false
    }
  }

  private readFile(workspaceId: string): RememberItem[] | null {
    if (!this.dir) return null
    let fd: number
    try {
      fd = openSync(
        join(this.dir, `${workspaceId}${FILE_SUFFIX}`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    } catch {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!isRecord(parsed) || parsed.v !== REMEMBER_VERSION || !Array.isArray(parsed.items)) {
        return this.setAside(workspaceId)
      }
      return parsed.items.flatMap((raw) => {
        const item = parseRememberItem(raw)
        return item ? [item] : []
      })
    } catch {
      return this.setAside(workspaceId)
    } finally {
      closeSync(fd)
    }
  }

  private setAside(workspaceId: string): null {
    if (!this.dir) return null
    const file = join(this.dir, `${workspaceId}${FILE_SUFFIX}`)
    try {
      renameSync(file, `${file}.unreadable-${this.options.now()}`)
    } catch {}
    return null
  }

  private removeFile(workspaceId: string): void {
    if (!this.dir || !storableWorkspaceId(workspaceId)) return
    try {
      rmSync(join(this.dir, `${workspaceId}${FILE_SUFFIX}`), { force: true })
    } catch {}
  }
}

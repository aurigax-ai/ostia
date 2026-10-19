import { ipcMain } from 'electron'
import type { WorktreeShareMap } from '../../shared/agents/worktreeShareApi'
import type { PaneIdentity } from '../control/idRegistry'
import type { PaneEntry } from './paneList'

const DEBOUNCE_MS = 400

export interface WorktreeShareDeps {
  panes: () => Promise<PaneEntry[]>
  key: (cwd: string) => Promise<string | undefined>
  identity: (externalId: string) => PaneIdentity | undefined
  remote: (paneId: string) => boolean
  publish: (map: WorktreeShareMap) => void
}

interface Cached {
  cwd: string
  session: string | undefined
  key: string | undefined
}

export class WorktreeShare {
  private readonly keys = new Map<string, Cached>()
  private shared = new Map<string, string[]>()
  private map: WorktreeShareMap = {}
  private timer: NodeJS.Timeout | undefined

  constructor(private readonly deps: WorktreeShareDeps) {}

  schedule(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined
      void this.check().catch(() => undefined)
    }, DEBOUNCE_MS)
    this.timer.unref()
  }

  others(externalId: string): string[] {
    return this.shared.get(externalId) ?? []
  }

  current(): WorktreeShareMap {
    return this.map
  }

  async check(): Promise<void> {
    const entries = (await this.deps.panes()).filter(
      (pane) => pane.agent && !pane.hibernated && pane.cwd,
    )
    const live = new Set(entries.map((pane) => pane.paneId))
    for (const id of this.keys.keys()) if (!live.has(id)) this.keys.delete(id)
    const groups = new Map<string, string[]>()
    for (const pane of entries) {
      const identity = this.deps.identity(pane.paneId)
      if (!identity || !pane.cwd || this.deps.remote(identity.paneId)) continue
      const known = this.keys.get(pane.paneId)
      const same = known?.cwd === pane.cwd && known.session === pane.agentSessionId
      const key = same ? known.key : await this.deps.key(pane.cwd)
      if (!same) this.keys.set(pane.paneId, { cwd: pane.cwd, session: pane.agentSessionId, key })
      if (key) groups.set(key, [...(groups.get(key) ?? []), pane.paneId])
    }
    const shared = new Map<string, string[]>()
    for (const members of groups.values()) {
      if (members.length < 2) continue
      for (const member of members)
        shared.set(
          member,
          members.filter((other) => other !== member),
        )
    }
    const map: WorktreeShareMap = {}
    for (const [externalId, others] of shared) {
      const own = this.deps.identity(externalId)
      if (!own) continue
      map[own.paneId] = others.flatMap((other) => this.deps.identity(other)?.paneId ?? [])
    }
    this.shared = shared
    if (JSON.stringify(map) === JSON.stringify(this.map)) return
    this.map = map
    this.deps.publish(map)
  }
}

export function registerWorktreeShareIpc(share: WorktreeShare): void {
  ipcMain.handle('agents:worktree-snapshot', () => share.current())
}

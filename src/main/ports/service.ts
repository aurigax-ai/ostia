import type { ExtensionSidebarItem, PaneChip, WorkspaceChip } from '../../shared/extensions'
import { type CoreItems, NO_CORE_ITEMS, PORTS_SOURCE } from '../../shared/git'
import type { PortsSettings } from '../../shared/ports'
import type { PaneEntry } from '../paneList'
import { WatchSets } from '../watchSets'
import { paneChipValues, workspaceChipValues } from './chips'
import { type TreeInfo, scanTrees } from './scan'
import { type WorkspaceProcesses, groupByWorkspace, sidebarEntries, terminalPids } from './sidebar'

const REFRESH_DEBOUNCE_MS = 400
const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  'command.started',
  'command.finished',
  'pane.created',
  'pane.closed',
])

export const PORTS_ITEMS_CHANNEL = 'ports:items'

export type TreeScan = (roots: number[], hostPid: number) => Promise<Map<number, TreeInfo>>

export interface PortsServiceDeps {
  settings: () => PortsSettings
  listPanes: () => Promise<PaneEntry[]>
  rendererPaneId: (externalPaneId: string) => string | undefined
  send: (windowId: string, channel: string, payload: unknown) => void
  scan?: TreeScan
  hostPid?: number
  log?: (line: string) => void
}

export interface WorkspacePorts {
  workspaceId: string
  ports: number[]
  ssh: string[]
}

export class PortsService {
  private watches = new WatchSets()
  private settings: PortsSettings
  private timer: ReturnType<typeof setTimeout> | null = null
  private poll: ReturnType<typeof setInterval> | null = null
  private pollMs = 0
  private focused = true
  private running = false
  private sent = new Map<string, string>()

  constructor(private readonly deps: PortsServiceDeps) {
    this.settings = deps.settings()
  }

  get active(): boolean {
    return this.settings.enabled && !this.watches.empty
  }

  get polling(): boolean {
    return this.poll !== null
  }

  get pending(): boolean {
    return this.timer !== null
  }

  watch(windowId: string, workspaceIds: unknown): void {
    if (this.watches.set(windowId, workspaceIds)) this.apply()
  }

  windowGone(windowId: string): void {
    this.sent.delete(windowId)
    if (this.watches.drop(windowId)) this.apply()
  }

  settingsChanged(): void {
    this.settings = this.deps.settings()
    this.apply()
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return
    this.focused = focused
    if (!this.active) return
    this.armPoll()
    if (focused) this.schedule(0)
  }

  activity(type: string): void {
    if (this.active && REFRESH_EVENTS.has(type)) this.schedule()
  }

  stop(): void {
    this.halt()
  }

  async list(): Promise<WorkspacePorts[]> {
    const groups = await this.scanned(await this.deps.listPanes())
    return [...groups.groups].map(([workspaceId, group]) => ({
      workspaceId,
      ports: group.ports,
      ssh: group.ssh,
    }))
  }

  private async scanned(
    panes: PaneEntry[],
  ): Promise<{ trees: Map<number, TreeInfo>; groups: Map<string, WorkspaceProcesses> }> {
    const scan = this.deps.scan ?? scanTrees
    const trees = await scan(terminalPids(panes), this.deps.hostPid ?? process.pid)
    return { trees, groups: groupByWorkspace(panes, trees) }
  }

  private apply(): void {
    if (!this.active) {
      this.halt()
      this.clear()
      return
    }
    this.armPoll()
    this.schedule(0)
  }

  private halt(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private clear(): void {
    for (const windowId of this.sent.keys()) {
      this.deps.send(windowId, PORTS_ITEMS_CHANNEL, NO_CORE_ITEMS)
    }
    this.sent.clear()
  }

  private armPoll(): void {
    const ms = this.settings.intervalSeconds * 1000
    if (this.poll && this.focused && this.pollMs === ms) return
    if (this.poll) clearInterval(this.poll)
    this.pollMs = ms
    this.poll = this.focused ? setInterval(() => void this.refresh(), ms) : null
  }

  private schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  async refresh(): Promise<void> {
    if (!this.active || this.running) return
    this.running = true
    try {
      const watched = this.watches.union()
      const panes = (await this.deps.listPanes()).filter((p) => watched.has(p.workspaceId))
      const { trees, groups } = await this.scanned(panes)
      if (this.active) this.publish(panes, trees, groups)
    } catch (err) {
      this.deps.log?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
    }
  }

  private publish(
    panes: PaneEntry[],
    trees: Map<number, TreeInfo>,
    groups: Map<string, WorkspaceProcesses>,
  ): void {
    const workspaceOf = new Map(panes.map((p) => [p.paneId, p.workspaceId]))
    const sidebar: ExtensionSidebarItem[] = sidebarEntries(groups).map((entry) => ({
      extId: PORTS_SOURCE,
      tone: 'neutral',
      ...entry,
    }))
    const paneChips: (PaneChip & { workspaceId: string })[] = []
    for (const chip of paneChipValues(panes, trees)) {
      const paneId = this.deps.rendererPaneId(chip.paneId)
      const workspaceId = workspaceOf.get(chip.paneId)
      if (!paneId || !workspaceId) continue
      paneChips.push({ extId: PORTS_SOURCE, tone: 'neutral', ...chip, paneId, workspaceId })
    }
    const workspaceChips: WorkspaceChip[] = workspaceChipValues(groups, this.settings.portHost).map(
      (chip) => ({ extId: PORTS_SOURCE, tone: 'neutral', ...chip }),
    )
    const watching = new Map(this.watches.windows())
    for (const windowId of [...this.sent.keys()]) {
      if (watching.has(windowId)) continue
      this.sent.delete(windowId)
      this.deps.send(windowId, PORTS_ITEMS_CHANNEL, NO_CORE_ITEMS)
    }
    for (const [windowId, ids] of watching) {
      const items: CoreItems = {
        sidebar: sidebar.filter((i) => i.workspaceId !== undefined && ids.has(i.workspaceId)),
        paneChips: paneChips
          .filter((c) => ids.has(c.workspaceId))
          .map(({ workspaceId: _workspaceId, ...chip }) => chip),
        workspaceChips: workspaceChips.filter((c) => ids.has(c.workspaceId)),
      }
      const text = JSON.stringify(items)
      if (this.sent.get(windowId) === text) continue
      this.sent.set(windowId, text)
      this.deps.send(windowId, PORTS_ITEMS_CHANNEL, items)
    }
  }
}

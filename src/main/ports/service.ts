import type {
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PORTS_SOURCE } from '@aurigax-ai/ostia-extension-sdk/manifest/coreNames'
import type { CoreItems } from '../../shared/boards/git'
import type { PortsSettings } from '../../shared/boards/ports'
import type { PaneEntry } from '../panes/paneList'
import { WatchedRefresher } from '../platform/watchedRefresher'
import { paneChipValues, workspaceChipValues } from './chips'
import type { ListeningPort } from './procfs'
import { scanTrees, type TreeInfo } from './scan'
import { groupByWorkspace, sidebarEntries, terminalPids, type WorkspaceProcesses } from './sidebar'

const REFRESH_DEBOUNCE_MS = 400
const REFRESH_EVENTS: ReadonlySet<string> = new Set([
  'command.started',
  'command.finished',
  'pane.created',
  'pane.closed',
])

export const PORTS_ITEMS_CHANNEL = 'ports:items'

type TreeScan = (roots: number[], hostPid: number) => Promise<Map<number, TreeInfo>>

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
  ports: ListeningPort[]
  ssh: string[]
}

type PortChip = PaneChip & { workspaceId: string }

interface PortsData extends Omit<CoreItems, 'paneChips'> {
  paneChips: PortChip[]
}

export class PortsService extends WatchedRefresher<PortsData> {
  private settings: PortsSettings

  constructor(private readonly deps: PortsServiceDeps) {
    super({
      channel: PORTS_ITEMS_CHANNEL,
      debounceMs: REFRESH_DEBOUNCE_MS,
      events: REFRESH_EVENTS,
      send: deps.send,
      log: deps.log,
    })
    this.settings = deps.settings()
  }

  protected enabled(): boolean {
    return this.settings.enabled
  }

  protected pollMs(): number {
    return this.settings.intervalSeconds * 1000
  }

  settingsChanged(): void {
    this.settings = this.deps.settings()
    this.apply()
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

  protected async read(watched: ReadonlySet<string>): Promise<PortsData> {
    const panes = (await this.deps.listPanes()).filter((p) => watched.has(p.workspaceId))
    const { trees, groups } = await this.scanned(panes)
    return this.items(panes, trees, groups)
  }

  private items(
    panes: PaneEntry[],
    trees: Map<number, TreeInfo>,
    groups: Map<string, WorkspaceProcesses>,
  ): PortsData {
    const workspaceOf = new Map(panes.map((p) => [p.paneId, p.workspaceId]))
    const sidebar: ExtensionSidebarItem[] = sidebarEntries(groups).map((entry) => ({
      extId: PORTS_SOURCE,
      tone: 'neutral',
      ...entry,
    }))
    const paneChips: PortChip[] = []
    for (const chip of paneChipValues(panes, trees)) {
      const paneId = this.deps.rendererPaneId(chip.paneId)
      const workspaceId = workspaceOf.get(chip.paneId)
      if (!paneId || !workspaceId) continue
      paneChips.push({ extId: PORTS_SOURCE, tone: 'neutral', ...chip, paneId, workspaceId })
    }
    const workspaceChips: WorkspaceChip[] = workspaceChipValues(groups, this.settings.portHost).map(
      (chip) => ({ extId: PORTS_SOURCE, tone: 'neutral', ...chip }),
    )
    return { sidebar, paneChips, workspaceChips }
  }

  protected itemsFor(ids: ReadonlySet<string>, all: PortsData): CoreItems {
    return {
      sidebar: all.sidebar.filter((i) => i.workspaceId !== undefined && ids.has(i.workspaceId)),
      paneChips: all.paneChips
        .filter((c) => ids.has(c.workspaceId))
        .map(({ workspaceId: _workspaceId, ...chip }) => chip),
      workspaceChips: all.workspaceChips.filter((c) => ids.has(c.workspaceId)),
    }
  }
}

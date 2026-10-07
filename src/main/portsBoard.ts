import { isEqual } from 'es-toolkit'
import {
  chipSlot,
  paneChipValues,
  workspaceChipSlot,
  workspaceChipValues,
} from '../extensions/ports/chips'
import { type TreeInfo, scanTrees } from '../extensions/ports/scan'
import {
  type PortHost,
  type SidebarEntry,
  groupByWorkspace,
  sidebarEntries,
  slotOf,
  terminalPids,
} from '../extensions/ports/sidebar'
import {
  type PaneChipValue,
  type PaneInfo,
  type WorkspaceChipValue,
  numberSetting,
} from '../extensions/sdk'
import { nextBackoff } from '../extensions/sdk/tool'
import type {
  ExtensionEventType,
  ExtensionResult,
  ExtensionSettingValues,
} from '../shared/extensions'

export const PORTS_EXTENSION = 'ports'
const POLL_SECONDS = { min: 1, max: 60 }
const DEFAULT_POLL_SECONDS = 3
const REFRESH_DEBOUNCE_MS = 400
const CHIP_RETRY_MS = 300
const CHIP_RETRY_MAX_MS = 5000
const REFRESH_EVENTS: ReadonlySet<ExtensionEventType> = new Set([
  'command.started',
  'command.finished',
  'pane.created',
  'pane.closed',
])

export interface PortsBoardHost {
  isEnabled: (extId: string) => boolean
  settingValuesOf: (extId: string) => ExtensionSettingValues
  publishSidebarItem: (extId: string, params: unknown) => ExtensionResult
  publishPaneChip: (extId: string, params: unknown) => ExtensionResult
  publishWorkspaceChip: (extId: string, params: unknown) => ExtensionResult
  onEvent: (listener: (type: ExtensionEventType, payload: unknown) => void) => () => void
  watch: (extId: string, listener: () => void) => () => void
}

export interface PortsBoardDeps {
  host: PortsBoardHost
  listPanes: () => Promise<PaneInfo[]>
  scan?: (roots: number[], hostPid: number) => Promise<Map<number, TreeInfo>>
  hostPid?: number
  log?: (line: string) => void
}

export class PortsBoard {
  private shown = new Map<string, SidebarEntry>()
  private chips = new Map<string, PaneChipValue>()
  private workspaceChips = new Map<string, WorkspaceChipValue>()
  private chipRefusals = 0
  private poll: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private focused = true
  private pollMs = DEFAULT_POLL_SECONDS * 1000
  private portHost: PortHost = 'localhost'
  private unsubscribe: (() => void)[] = []

  constructor(private readonly deps: PortsBoardDeps) {}

  start(): void {
    if (this.unsubscribe.length > 0) return
    this.unsubscribe = [
      this.deps.host.onEvent((type, payload) => {
        if (type === 'focus.changed') this.setFocused((payload as { focused: boolean }).focused)
        else if (REFRESH_EVENTS.has(type)) this.schedule()
      }),
      this.deps.host.watch(PORTS_EXTENSION, () => this.configure()),
    ]
    this.configure()
    this.schedule(0)
  }

  stop(): void {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.unsubscribe.length === 0) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  private configure(): void {
    const values = this.deps.host.settingValuesOf(PORTS_EXTENSION)
    const pollMs =
      numberSetting(values, 'intervalSeconds', DEFAULT_POLL_SECONDS, POLL_SECONDS) * 1000
    const portHost: PortHost = values.portHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'
    const changed = pollMs !== this.pollMs || portHost !== this.portHost || !this.poll
    this.pollMs = pollMs
    this.portHost = portHost
    if (changed) this.restartPoll()
    this.schedule()
  }

  private setFocused(focused: boolean): void {
    this.focused = focused
    this.restartPoll()
    if (focused) this.schedule(0)
  }

  private restartPoll(): void {
    if (this.poll) clearInterval(this.poll)
    this.poll = this.focused ? setInterval(() => void this.refresh(), this.pollMs) : null
  }

  async refresh(): Promise<void> {
    if (!this.deps.host.isEnabled(PORTS_EXTENSION)) {
      this.shown.clear()
      this.chips.clear()
      this.workspaceChips.clear()
      return
    }
    if (this.running) return
    this.running = true
    try {
      const panes = await this.deps.listPanes()
      const roots = terminalPids(panes)
      const scan = this.deps.scan ?? scanTrees
      const trees = await scan(roots, this.deps.hostPid ?? process.pid)
      const groups = groupByWorkspace(panes, trees)
      this.syncSidebar(sidebarEntries(groups))
      this.syncChips(paneChipValues(panes, trees))
      this.syncWorkspaceChips(workspaceChipValues(groups, this.portHost))
    } catch (err) {
      this.deps.log?.(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
    }
  }

  private syncSidebar(entries: SidebarEntry[]): void {
    const next = new Map(entries.map((e) => [slotOf(e), e]))
    for (const [slot, entry] of this.shown) {
      if (next.has(slot)) continue
      this.deps.host.publishSidebarItem(PORTS_EXTENSION, {
        workspaceId: entry.workspaceId,
        key: entry.key,
        text: '',
      })
    }
    for (const [slot, entry] of next) {
      if (isEqual(this.shown.get(slot), entry)) continue
      this.deps.host.publishSidebarItem(PORTS_EXTENSION, entry)
    }
    this.shown = next
  }

  private syncChips(chips: PaneChipValue[]): void {
    const next = new Map(chips.map((c) => [chipSlot(c), c]))
    for (const [slot, chip] of this.chips) {
      if (next.has(slot)) continue
      this.deps.host.publishPaneChip(PORTS_EXTENSION, {
        paneId: chip.paneId,
        id: chip.id,
        text: '',
      })
    }
    for (const [slot, chip] of next) {
      if (isEqual(this.chips.get(slot), chip)) continue
      this.deps.host.publishPaneChip(PORTS_EXTENSION, chip)
    }
    this.chips = next
  }

  private syncWorkspaceChips(chips: WorkspaceChipValue[]): void {
    const next = new Map(chips.map((c) => [workspaceChipSlot(c), c]))
    for (const [slot, chip] of this.workspaceChips) {
      if (next.has(slot)) continue
      this.deps.host.publishWorkspaceChip(PORTS_EXTENSION, {
        workspaceId: chip.workspaceId,
        id: chip.id,
        text: '',
      })
    }
    const accepted = new Map<string, WorkspaceChipValue>()
    for (const [slot, chip] of next) {
      if (isEqual(this.workspaceChips.get(slot), chip)) {
        accepted.set(slot, chip)
        continue
      }
      if (this.deps.host.publishWorkspaceChip(PORTS_EXTENSION, chip).ok) accepted.set(slot, chip)
    }
    this.workspaceChips = accepted
    this.chipRefusals = accepted.size < next.size ? this.chipRefusals + 1 : 0
    if (this.chipRefusals > 0) {
      this.schedule(nextBackoff(this.chipRefusals, CHIP_RETRY_MS, CHIP_RETRY_MAX_MS))
    }
  }
}

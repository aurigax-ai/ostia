import { isEqual } from 'es-toolkit'
import {
  type CommandHandler,
  type ExtensionSettingValues,
  type OstiaExtension,
  type PaneChipValue,
  type WorkspaceChipValue,
  cliArgs,
  connect,
  failure,
  nextBackoff,
  numberSetting,
  ok,
  parseFlags,
} from '../sdk'
import { chipSlot, paneChipValues, workspaceChipSlot, workspaceChipValues } from './chips'
import { scanTrees } from './scan'
import {
  type PortHost,
  type SidebarEntry,
  type WorkspaceProcesses,
  groupByWorkspace,
  sidebarEntries,
  slotOf,
  terminalPids,
} from './sidebar'

const POLL_SECONDS = { min: 1, max: 60 }
const DEFAULT_POLL_SECONDS = 3
const REFRESH_DEBOUNCE_MS = 400
const CHIP_RETRY_MS = 300
const CHIP_RETRY_MAX_MS = 5000

class PortsExtension {
  private shown = new Map<string, SidebarEntry>()
  private chips = new Map<string, PaneChipValue>()
  private workspaceChips = new Map<string, WorkspaceChipValue>()
  private chipRefusals = 0
  private groups = new Map<string, WorkspaceProcesses>()
  private poll: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private focused = false
  private pollMs = DEFAULT_POLL_SECONDS * 1000
  private host: PortHost = 'localhost'

  constructor(private readonly ext: OstiaExtension) {}

  configure(values: ExtensionSettingValues): void {
    this.pollMs =
      numberSetting(values, 'intervalSeconds', DEFAULT_POLL_SECONDS, POLL_SECONDS) * 1000
    this.host = values.portHost === '127.0.0.1' ? '127.0.0.1' : 'localhost'
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
    this.setFocused(this.focused)
  }

  setFocused(focused: boolean): void {
    this.focused = focused
    if (focused && !this.poll) {
      this.poll = setInterval(() => void this.refresh(), this.pollMs)
      this.schedule(0)
    } else if (!focused && this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
  }

  schedule(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.refresh()
    }, delay)
  }

  async refresh(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const panes = await this.ext.listPanes()
      const trees = await scanTrees(terminalPids(panes), process.ppid)
      this.groups = groupByWorkspace(panes, trees)
      await this.sync(sidebarEntries(this.groups))
      await this.syncChips(paneChipValues(panes, trees))
      await this.syncWorkspaceChips(workspaceChipValues(this.groups, this.host))
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
    } finally {
      this.running = false
    }
  }

  private async sync(entries: SidebarEntry[]): Promise<void> {
    const next = new Map(entries.map((e) => [slotOf(e), e]))
    for (const [slot, entry] of this.shown) {
      if (next.has(slot)) continue
      await this.ext.setSidebarItem({ workspaceId: entry.workspaceId, key: entry.key, text: '' })
    }
    for (const [slot, entry] of next) {
      if (isEqual(this.shown.get(slot), entry)) continue
      await this.ext.setSidebarItem(entry)
    }
    this.shown = next
  }

  private async syncChips(chips: PaneChipValue[]): Promise<void> {
    const next = new Map(chips.map((c) => [chipSlot(c), c]))
    for (const [slot, chip] of this.chips) {
      if (next.has(slot)) continue
      await this.ext.clearPaneChip(chip.paneId, chip.id)
    }
    for (const [slot, chip] of next) {
      if (isEqual(this.chips.get(slot), chip)) continue
      await this.ext.setPaneChip(chip)
    }
    this.chips = next
  }

  private async syncWorkspaceChips(chips: WorkspaceChipValue[]): Promise<void> {
    const next = new Map(chips.map((c) => [workspaceChipSlot(c), c]))
    for (const [slot, chip] of this.workspaceChips) {
      if (next.has(slot)) continue
      await this.ext.clearWorkspaceChip(chip.workspaceId, chip.id)
    }
    const accepted = new Map<string, WorkspaceChipValue>()
    for (const [slot, chip] of next) {
      if (isEqual(this.workspaceChips.get(slot), chip)) {
        accepted.set(slot, chip)
        continue
      }
      const res = await this.ext.setWorkspaceChip(chip)
      if (res.ok) accepted.set(slot, chip)
    }
    this.workspaceChips = accepted
    this.chipRefusals = accepted.size < next.size ? this.chipRefusals + 1 : 0
    if (this.chipRefusals > 0) {
      this.schedule(nextBackoff(this.chipRefusals, CHIP_RETRY_MS, CHIP_RETRY_MAX_MS))
    }
  }

  handlers(): Record<string, CommandHandler> {
    return {
      ls: async (args, caller) => {
        const cli = cliArgs(args)
        const all = cli ? parseFlags(cli.argv, [], ['all']).bools.has('all') : false
        if (all && !caller.capabilities.includes('all-workspaces')) {
          return failure('needs-elevation', 'all-workspaces')
        }
        if (!all && !caller.workspaceId)
          return failure('no-workspace', 'no workspace for this caller')
        await this.refresh()
        const workspaces = [...this.groups]
          .filter(([id]) => all || id === caller.workspaceId)
          .map(([workspaceId, group]) => ({ workspaceId, ports: group.ports, ssh: group.ssh }))
        return ok(undefined, { workspaces })
      },
    }
  }
}

async function main(): Promise<void> {
  const ext = await connect()
  const ports = new PortsExtension(ext)
  ext.onSettingsChanged((values) => ports.configure(values))
  ports.configure(await ext.getSettings())
  await ext.subscribe(
    ['command.started', 'command.finished', 'pane.created', 'pane.closed', 'focus.changed'],
    (type, payload) => {
      if (type === 'focus.changed') ports.setFocused((payload as { focused: boolean }).focused)
      else ports.schedule()
    },
  )
  await ext.registerCommands(ports.handlers())
  ports.setFocused(true)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

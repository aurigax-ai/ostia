import {
  type CommandHandler,
  type PineExtension,
  cliArgs,
  connect,
  failure,
  ok,
  parseFlags,
} from '../sdk'
import { scanTrees } from './scan'
import {
  type SidebarEntry,
  type WorkspaceProcesses,
  groupByWorkspace,
  sidebarEntries,
  slotOf,
  terminalPids,
} from './sidebar'

const POLL_MS = 3000
const REFRESH_DEBOUNCE_MS = 400

class PortsExtension {
  private shown = new Map<string, SidebarEntry>()
  private groups = new Map<string, WorkspaceProcesses>()
  private poll: ReturnType<typeof setInterval> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private readonly ext: PineExtension) {}

  setFocused(focused: boolean): void {
    if (focused && !this.poll) {
      this.poll = setInterval(() => void this.refresh(), POLL_MS)
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
      this.groups = groupByWorkspace(panes, await scanTrees(terminalPids(panes), process.ppid))
      await this.sync(sidebarEntries(this.groups))
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
      if (JSON.stringify(this.shown.get(slot)) === JSON.stringify(entry)) continue
      await this.ext.setSidebarItem(entry)
    }
    this.shown = next
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

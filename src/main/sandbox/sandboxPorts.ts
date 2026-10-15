import { approvals } from '../approvals/approvals'
import { getByPaneId } from '../control/idRegistry'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { KeptHostMeta } from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxServer'
import { PortForwarder, type SandboxListener, type SandboxPane } from './portForwarder'
import { PortRequests } from './portRequests'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

interface SandboxPortsDeps {
  ptys: Map<string, PtyEntry>
  workspaceSandboxes: WorkspaceSandboxes
  keptHostPanes: Map<string, { pane: TmuxPane; meta: KeptHostMeta }>
  paneForWorkspace: (workspaceId: string) => string | undefined
}

export function createSandboxPorts({
  ptys,
  workspaceSandboxes,
  keptHostPanes,
  paneForWorkspace,
}: SandboxPortsDeps) {
  function syncKeptExposed(workspaceId: string, listening?: readonly SandboxListener[]): void {
    const host = keptHostPanes.get(workspaceId)
    if (!host) return
    const exposed = portRequests.exposures(workspaceId, listening)
    if (JSON.stringify(exposed) === JSON.stringify(host.meta.exposed)) return
    host.meta = { ...host.meta, exposed }
    host.pane.setMeta(host.meta)
  }

  function sandboxedPanes(workspaceId: string): SandboxPane[] {
    const panes: SandboxPane[] = []
    for (const entry of ptys.values()) {
      if (entry.workspaceId === workspaceId && entry.sandboxed) {
        panes.push({ pid: entry.pty.pid, bridge: entry.portBridge })
      }
    }
    return panes
  }

  const portForwarder = new PortForwarder({
    onChange: (workspaceId) => syncKeptExposed(workspaceId),
    panesOf: sandboxedPanes,
    unixSocketsOff: (workspaceId) => !workspaceSandboxes.resolved(workspaceId).switches.unixSockets,
  })

  const portRequests: PortRequests = new PortRequests({
    platform: process.platform,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    policy: (workspaceId) => workspaceSandboxes.resolved(workspaceId).portsPolicy,
    ask: async ({ workspaceId, paneId, port, process: owner, origin }) => {
      const pane = paneId ? getByPaneId(paneId) : undefined
      const identity = pane ?? getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind: 'sandbox-port',
        subject: String(port),
        action:
          origin === 'agent' ? `ostia sandbox expose ${port}` : `a server started on port ${port}`,
        detail: owner ?? '',
      })
    },
    forwarder: portForwarder,
  })

  function scanSandboxPorts(): void {
    const workspaces = new Set<string>()
    for (const entry of ptys.values()) if (entry.sandboxed) workspaces.add(entry.workspaceId)
    for (const workspaceId of workspaces) {
      void portRequests.scan(workspaceId).then(() => syncKeptExposed(workspaceId))
    }
  }

  return { syncKeptExposed, portForwarder, portRequests, scanSandboxPorts }
}

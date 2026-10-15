import { approvals } from '../approvals/approvals'
import { getByPaneId } from '../control/idRegistry'
import { PackageRequests } from '../sandboxPackages/packageRequests'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { DomainRequests } from './domainRequests'
import type { WorkspaceSandboxes } from './workspaceSandboxes'

interface SandboxRequestsDeps {
  ptys: Map<string, PtyEntry>
  workspaceSandboxes: WorkspaceSandboxes
}

export function createSandboxRequests({ ptys, workspaceSandboxes }: SandboxRequestsDeps) {
  function paneForWorkspace(workspaceId: string): string | undefined {
    for (const [paneId, entry] of ptys) {
      if (entry.workspaceId === workspaceId && entry.sandboxed) return paneId
    }
    return undefined
  }

  const domainRequests: DomainRequests = new DomainRequests({
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    blockedDomains: (workspaceId) => workspaceSandboxes.resolved(workspaceId).deniedDomains,
    ask: async ({ workspaceId, paneId, host, origin }) => {
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
        kind: 'sandbox-domain',
        subject: host,
        action: origin === 'agent' ? `ostia sandbox request-domain ${host}` : `connect to ${host}`,
        detail: '',
      })
    },
    allowWorkspace: (workspaceId, domain) => {
      workspaceSandboxes.update(workspaceId, (current) => ({
        ...current,
        domains: current.domains.includes(domain) ? current.domains : [...current.domains, domain],
      }))
    },
    allowUntilRestart: (workspaceId, domain) =>
      workspaceSandboxes.allowUntilRestart(workspaceId, domain),
    now: Date.now,
  })

  const PACKAGE_BATCH_MS = 600

  const packageRequests: PackageRequests = new PackageRequests({
    batchMs: PACKAGE_BATCH_MS,
    ask: async ({ workspaceId, kind, packages }) => {
      const identity = getByPaneId(paneForWorkspace(workspaceId) ?? '')
      const queue = approvals()
      if (!identity || !queue) return 'deny'
      const names = packages.map((p) => `${p.ref.name}@${p.ref.version}`)
      return queue.request({
        externalId: identity.externalId,
        windowId: identity.windowId,
        paneId: identity.paneId,
        workspaceId,
        caps: [],
        kind,
        subject: names.join(', '),
        action: `install ${names.length} package${names.length === 1 ? '' : 's'}`,
        detail: packages
          .map((p) => `${p.ref.ecosystem} ${p.ref.name}@${p.ref.version}: ${p.reason}`)
          .join('\n'),
      })
    },
    allowWorkspace: (workspaceId, key) => workspaceSandboxes.allowPackage(workspaceId, key, true),
    allowUntilRestart: (workspaceId, key) =>
      workspaceSandboxes.allowPackage(workspaceId, key, false),
  })

  return { paneForWorkspace, domainRequests, packageRequests }
}

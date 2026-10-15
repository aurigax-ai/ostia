import { getByPaneId } from '../control/idRegistry'
import { BrowserFence } from '../sandbox/browserFence'
import type { DomainRequests } from '../sandbox/domainRequests'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { BrowserProfiles } from './browserProfiles'

interface GuestProfilesDeps {
  scratchFolders: ScratchFolders
  workspaceSandboxes: WorkspaceSandboxes
  domainRequests: DomainRequests
  browserPanes: Map<string, number>
}

export type GuestProfiles = ReturnType<typeof createGuestProfiles>

export function createGuestProfiles({
  scratchFolders,
  workspaceSandboxes,
  domainRequests,
  browserPanes,
}: GuestProfilesDeps) {
  const browserProfiles = new BrowserProfiles({
    ownerOf: (paneId) => {
      const identity = getByPaneId(paneId)
      return identity ? { windowId: identity.windowId, workspaceId: identity.workspaceId } : null
    },
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  })

  const browserFence = new BrowserFence({
    policy: (workspaceId) => {
      if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return null
      const resolved = workspaceSandboxes.resolved(workspaceId)
      return {
        browser: resolved.controls.browser,
        domains: resolved.domains,
        denied: resolved.deniedDomains,
      }
    },
    requestDomain: async (workspaceId, host) =>
      (await domainRequests.request(workspaceId, '', host)).ok,
  })

  function workspaceOfGuest(guest: Electron.WebContents): string | undefined {
    for (const [paneId, wcId] of browserPanes) {
      if (wcId === guest.id) return getByPaneId(paneId)?.workspaceId
    }
    return undefined
  }

  function fenceBrowserGuest(guest: Electron.WebContents): void {
    const guard = (e: Electron.Event, url: string): void => {
      const workspaceId = workspaceOfGuest(guest)
      if (!workspaceId || browserFence.allowedNow(workspaceId, url)) return
      e.preventDefault()
      void browserFence.check(workspaceId, url).then((ok) => {
        if (ok && !guest.isDestroyed()) void guest.loadURL(url).catch(() => {})
      })
    }
    guest.on('will-navigate', guard)
    guest.on('will-redirect', guard)
  }

  return { browserProfiles, browserFence, fenceBrowserGuest }
}

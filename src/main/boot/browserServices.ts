import { createBrowserGuests } from '../browser/browserGuests'
import { createGuestProfiles } from '../browser/guestProfiles'
import { setCapFilter } from '../control/controlAuth'
import { resolveExternal } from '../control/idRegistry'
import type { ConfinedContext } from './confinedServices'

export function createBrowserServices(ctx: ConfinedContext) {
  const {
    browserPanes,
    consoleBuffers,
    domainRequests,
    errorBuffers,
    mainStrings,
    openExternalSafe,
    scratchFolders,
    services,
    windows,
    workspaceSandboxes,
  } = ctx

  const { browserProfiles, browserFence, fenceBrowserGuest } = createGuestProfiles({
    scratchFolders,
    workspaceSandboxes,
    domainRequests,
    browserPanes,
  })

  const {
    extensionOfPartition,
    browserAgentsOf,
    instrumentBrowserGuest,
    attachBrowserMenu,
    allowHumanPopups,
    hardenExtensionGuest,
    isHumanProfile,
  } = createBrowserGuests({
    contextMenuText: () => mainStrings().native.contextMenu,
    consoleBuffers,
    errorBuffers,
    windows,
    services,
    openExternalSafe,
  })

  setCapFilter((conn, cap) => {
    if (cap !== 'all-workspaces') return true
    const workspaceId = resolveExternal(conn.externalId)?.workspaceId || conn.workspaceId
    if (!workspaceId || !workspaceSandboxes.isEnabled(workspaceId)) return true
    return workspaceSandboxes.resolved(workspaceId).controls.allWorkspaces
  })

  return {
    browserProfiles,
    browserFence,
    fenceBrowserGuest,
    extensionOfPartition,
    browserAgentsOf,
    instrumentBrowserGuest,
    attachBrowserMenu,
    allowHumanPopups,
    hardenExtensionGuest,
    isHumanProfile,
  }
}

export type BrowserContext = ConfinedContext & ReturnType<typeof createBrowserServices>

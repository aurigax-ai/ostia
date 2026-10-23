import { homedir } from 'node:os'
import { app, session } from 'electron'
import { SHARED_BROWSER_PARTITION } from '../../shared/browser/browserProfile'
import type { OriginReach } from '../agents/originAgents'
import type { Reach } from '../approvals/reach'
import type { PreviewHost } from '../artifacts/htmlPreview'
import type { CommandBridge } from '../control/commandBridge'
import type { Redactor } from '../privacy/redaction'
import type { WindowSend } from '../windows/windowSend'
import { registerBrowseMethods } from './browse'
import { captureGuestOf, ownedGuest } from './browseGuests'
import type { ConsoleEntry } from './browseMethod'
import { registerPickIpc, registerPickMethods } from './browsePick'
import { registerRegionIpc } from './browseRegion'
import type { BrowserGuests } from './browserGuests'
import { registerBrowserStorageIpc } from './browserStorage'
import { registerDeviceIpc } from './guestDevice'
import type { GuestProfiles } from './guestProfiles'
import { registerLoginFill } from './loginFill'

interface BrowserWiringDeps {
  browserAgentsOf: BrowserGuests['browserAgentsOf']
  browserProfiles: GuestProfiles['browserProfiles']
  browserFence: GuestProfiles['browserFence']
  browserPanes: Map<string, number>
  execCommand: CommandBridge['execCommand']
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  reach: Reach
  broadcast: WindowSend['broadcast']
  reachesPane: OriginReach
  redactor: Redactor
  previews: Pick<PreviewHost, 'captureGuestId'>
}

export function registerBrowserWiring({
  browserAgentsOf,
  browserProfiles,
  browserFence,
  browserPanes,
  execCommand,
  consoleBuffers,
  errorBuffers,
  reach,
  broadcast,
  reachesPane,
  redactor,
  previews,
}: BrowserWiringDeps) {
  const guestOf = captureGuestOf(browserPanes, (windowId, paneId) =>
    previews.captureGuestId(windowId, paneId),
  )
  const sharedBrowser = session.fromPartition(SHARED_BROWSER_PARTITION)
  const sharedAgents = browserAgentsOf(sharedBrowser)
  const isSharedPane = (paneId: string): boolean => browserProfiles.isShared(paneId)
  registerBrowseMethods({
    allowNavigation: (workspaceId, url) => browserFence.check(workspaceId, url),
    browserPanes,
    isSharedPane,
    execCommand,
    screenshotRoots: [homedir(), app.getPath('userData')],
    consoleBuffers,
    errorBuffers,
    reach,
  })
  registerPickMethods({ browserPanes, isSharedPane, errorBuffers, broadcast, reach })
  registerPickIpc(
    { browserPanes, isSharedPane, errorBuffers, broadcast, reach },
    guestOf,
    reachesPane,
    redactor.text,
  )
  registerRegionIpc(guestOf, reachesPane, redactor.text)
  registerDeviceIpc(browserPanes, sharedAgents.metadata)
  registerBrowserStorageIpc((paneId, senderWindowId) =>
    ownedGuest(browserPanes, paneId, senderWindowId),
  )
  registerLoginFill({
    browserPanes,
    isSharedPane,
    ownedGuest: (paneId, senderWindowId) => ownedGuest(browserPanes, paneId, senderWindowId),
    reach,
  })
}

import { homedir } from 'node:os'
import { app, session } from 'electron'
import { SHARED_BROWSER_PARTITION } from '../../shared/browser/browserProfile'
import type { CommandTarget } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { OriginReach } from '../agents/originAgents'
import type { Reach } from '../approvals/reach'
import type { Redactor } from '../privacy/redaction'
import type { BrowserFence } from '../sandbox/browserFence'
import { registerBrowseMethods } from './browse'
import { ownedGuest } from './browseGuests'
import type { ConsoleEntry } from './browseMethod'
import { registerPickIpc, registerPickMethods } from './browsePick'
import { registerRegionIpc } from './browseRegion'
import type { BrowserProfiles } from './browserProfiles'
import { registerBrowserStorageIpc } from './browserStorage'
import { registerLoginFill } from './loginFill'
import type { BrowserAgents } from './signinUserAgent'

interface BrowserWiringDeps {
  browserAgentsOf: (target: Electron.Session) => BrowserAgents
  browserProfiles: BrowserProfiles
  browserFence: BrowserFence
  browserPanes: Map<string, number>
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  consoleBuffers: Map<number, ConsoleEntry[]>
  errorBuffers: Map<number, ConsoleEntry[]>
  reach: Reach
  broadcast: (channel: string, payload: unknown) => void
  reachesPane: OriginReach
  redactor: Redactor
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
}: BrowserWiringDeps) {
  const sharedBrowser = session.fromPartition(SHARED_BROWSER_PARTITION)
  browserAgentsOf(sharedBrowser)
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
    reachesPane,
    redactor.text,
  )
  registerRegionIpc(browserPanes, reachesPane, redactor.text)
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

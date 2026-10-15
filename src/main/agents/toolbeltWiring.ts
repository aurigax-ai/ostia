import type { Reach } from '../approvals/reach'
import type { ArtifactProducers } from '../artifacts/artifactProducers'
import { announceBusMessage } from '../attention/busNotice'
import type { CommandBridge } from '../control/commandBridge'
import { registerDocsMethods } from '../control/docs'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { OpenFileGrants } from '../files/openFileGrants'
import { registerOpenFileMethods } from '../files/openFileMethods'
import type { OpenWaits } from '../files/openWaits'
import type { ManagerLimiter } from '../manager/managerMethods'
import { listPanes, listWorkspaces } from '../panes/paneList'
import type { PaneMethodsWiring } from '../panes/paneMethodsWiring'
import { resolveSafe } from '../platform/pathGuard'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { registerVaultMethods } from '../secrets/vault'
import type { WindowSend } from '../windows/windowSend'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { registerBusMethods } from './bus'

interface ToolbeltWiringDeps {
  services: {
    extensionHost: ExtensionHost | null
    managerLimiter: ManagerLimiter | null
    telemetry: Telemetry | null
  }
  workspaceSandboxes: WorkspaceSandboxes
  openFileGrants: OpenFileGrants
  scratchFolders: ScratchFolders
  fileRoots: () => string[]
  openWaits: OpenWaits
  execCommand: CommandBridge['execCommand']
  artifactProducers: ArtifactProducers
  artifactsChanged: (workspaceId: string) => void
  reach: Reach
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  paneHibernated: PaneMethodsWiring['paneHibernated']
}

export function registerToolbeltWiring({
  services,
  workspaceSandboxes,
  openFileGrants,
  scratchFolders,
  fileRoots,
  openWaits,
  execCommand,
  artifactProducers,
  artifactsChanged,
  reach,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  paneHibernated,
}: ToolbeltWiringDeps) {
  registerDocsMethods({ extensions: () => services.extensionHost?.listForAgents() ?? [] })
  registerVaultMethods({ isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId) })
  registerOpenFileMethods({
    grants: openFileGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    confineFolder: (path) => resolveSafe(path, fileRoots()),
    waits: openWaits,
    execCommand,
    opened: (workspaceId, paneId, paths) => {
      const noted = paths.filter((path) => artifactProducers.note(workspaceId, paneId, path))
      if (noted.length > 0) artifactsChanged(workspaceId)
    },
  })
  registerBusMethods({
    inScope: reach.inScope,
    managerSendAllowed: () => services.managerLimiter?.busAllowed() ?? true,
    sent: () => services.telemetry?.count('agents', 'bus_message'),
    announce: (from, to, text) => {
      void announceBusMessage(
        {
          execCommand,
          listPanes: () =>
            listPanes({
              execCommand,
              getTerminalState,
              ptyPid,
              windowIds,
              waking: isWaking,
            }),
          listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
        },
        from,
        to,
        text,
      ).catch(() => {})
    },
    hibernated: paneHibernated,
  })
}

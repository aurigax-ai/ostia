import type {
  BusEndpoint,
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { parseAgentHooks } from '../../shared/agents/agentHooks'
import { isResumableAgent } from '../../shared/agents/agentResume'
import type { ArtifactProducers } from '../artifacts/artifactProducers'
import { announceBusMessage } from '../attention/busNotice'
import type { CommandBridge } from '../control/commandBridge'
import { registerDocsMethods } from '../control/docs'
import { resolveExternal } from '../control/idRegistry'
import type { AgentJournal } from '../diagnostics/agentJournal'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { OpenFileGrants } from '../files/openFileGrants'
import { registerOpenFileMethods } from '../files/openFileMethods'
import type { OpenWaits } from '../files/openWaits'
import type { ManagerLimiter } from '../manager/managerMethods'
import { listPanes, listWorkspaces } from '../panes/paneList'
import type { PaneMethodsWiring } from '../panes/paneMethodsWiring'
import { resolveSafe } from '../platform/pathGuard'
import { readSettingsFile } from '../platform/settingsFile'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { registerVaultMethods } from '../secrets/vault'
import type { WindowSend } from '../windows/windowSend'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { registerBusMethods } from './busMethods'
import { registerMailIpc } from './mailIpc'
import { mailPending } from './mailPending'

interface ToolbeltWiringDeps {
  services: {
    extensionHost: ExtensionHost | null
    managerLimiter: ManagerLimiter | null
    telemetry: Telemetry | null
    agentJournal: AgentJournal | null
  }
  workspaceSandboxes: WorkspaceSandboxes
  openFileGrants: OpenFileGrants
  scratchFolders: ScratchFolders
  fileRoots: () => string[]
  openWaits: OpenWaits
  execCommand: CommandBridge['execCommand']
  artifactProducers: ArtifactProducers
  artifactsChanged: (workspaceId: string) => void
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  paneReachDeps: PaneMethodsWiring['paneReachDeps']
  broadcast: WindowSend['broadcast']
  emitPaneEvent: <T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]) => void
}

function endpointOf(id: string): BusEndpoint {
  const target = resolveExternal(id)
  return target?.kind === 'pane' ? { id, workspaceId: target.workspaceId } : { id }
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
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  paneReachDeps,
  broadcast,
  emitPaneEvent,
}: ToolbeltWiringDeps) {
  registerMailIpc(broadcast)
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
    reach: paneReachDeps,
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
    pending: async (pane) =>
      mailPending(
        (
          await listPanes({
            execCommand,
            getTerminalState,
            ptyPid,
            windowIds,
            waking: isWaking,
          })
        ).find((entry) => entry.paneId === pane.externalId),
        (agent) =>
          isResumableAgent(agent) && parseAgentHooks(readSettingsFile().agents?.hooks)[agent],
      ),
    journal: services.agentJournal ?? undefined,
    observe: (observation) =>
      emitPaneEvent('bus.message', {
        ...observation,
        from: endpointOf(observation.from),
        to: endpointOf(observation.to),
      }),
  })
}

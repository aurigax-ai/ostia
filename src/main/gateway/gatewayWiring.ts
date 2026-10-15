import { hostname } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { OPEN_FILES_COMMAND } from '../../shared/files/openFiles'
import type { CommandDescriptor, CommandTarget, TerminalStateSnapshot } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { AskHub } from '../approvals/asks'
import type { Reach } from '../approvals/reach'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import type { AppLog } from '../diagnostics/appLog'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  registerPaneListMethods,
} from '../panes/paneList'
import { processStatusOf } from '../panes/processManager'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { createBonjourPublisher } from './announce'
import {
  configureAnnouncer,
  configureTailnet,
  onTailnetChange,
  registerGatewayIpc,
  registerGatewayMethods,
} from './gatewayIpc'
import { listPairRequests, onPairRequestsChanged } from './pairRequests'
import { configureGatewayControl } from './server'
import { createTailnet, tailnetNodeName, tsnetHelperPath } from './tailnet'
import type { PhoneFileScope } from './workspaceFiles'

interface GatewayStartDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  ptyPid: (paneId: string) => number | undefined
  windowIds: () => string[]
  isWaking: (paneId: string) => boolean
  services: {
    appLog: AppLog | null
    processes: ProcessRegistry | null
    stopAnnouncing: (() => void) | null
    stopTailnet: (() => Promise<void>) | null
  }
  reach: Reach
  workspaceSandboxes: WorkspaceSandboxes
  broadcast: (channel: string, payload: unknown) => void
  openExternalSafe: (url: string) => boolean
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  phoneFileScope: (workspaceId: string) => PhoneFileScope
  artifactFolders: ArtifactFolders
  primaryWindowId: () => string | undefined
  attachPhoneObserver: (
    rendererPaneId: string,
    opts: { sinceCursor?: number; role?: 'observer' | 'owner'; sendData: (data: string) => void },
  ) => { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null
  ptyResize: (rendererPaneId: string, cols: number, rows: number) => void
  ptyWrite: (rendererPaneId: string, data: string) => void
  askHub: AskHub
  agentRunning: AgentRunningPanes
  ptys: Map<string, PtyEntry>
}

export function startGateway({
  execCommand,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  services,
  reach,
  workspaceSandboxes,
  broadcast,
  openExternalSafe,
  listCommandsFor,
  phoneFileScope,
  artifactFolders,
  primaryWindowId,
  attachPhoneObserver,
  ptyResize,
  ptyWrite,
  askHub,
  agentRunning,
  ptys,
}: GatewayStartDeps) {
  registerPaneListMethods({
    execCommand,
    getTerminalState,
    ptyPid,
    windowIds,
    waking: isWaking,
    processOf: (paneId) => {
      const entry = services.processes?.forPane(paneId)
      return entry ? processStatusOf(entry) : undefined
    },
    reach,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
  })
  registerGatewayMethods()
  const tailnet = createTailnet({
    command: tsnetHelperPath(app.getAppPath(), process.platform),
    stateDir: join(app.getPath('userData'), 'tsnet'),
    hostname: tailnetNodeName(hostname()),
    onChange: (state) => {
      onTailnetChange(state)
      broadcast('gateway:tailnet-changed', state)
    },
    log: (event, fields) => services.appLog?.info(event, fields),
  })
  configureTailnet(tailnet, { openExternal: (url) => void openExternalSafe(url) })
  services.stopTailnet = () => tailnet.stop()
  const publisher = createBonjourPublisher()
  configureAnnouncer(publisher)
  services.stopAnnouncing = publisher.unpublish
  onPairRequestsChanged(() => broadcast('gateway:pair-requests-changed', listPairRequests()))
  registerGatewayIpc()
  configureGatewayControl({
    execCommand,
    listCommandsFor,
    getTerminalState,
    listPanes: () =>
      listPanes({
        execCommand,
        getTerminalState,
        ptyPid,
        windowIds,
        waking: isWaking,
      }),
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    fileScope: phoneFileScope,
    artifactsDir: (workspaceId) => artifactFolders.followed(workspaceId),
    openArtifact: async (workspaceId, path) => {
      const windowId = windowForWorkspace(workspaceId)
      if (!windowId) return false
      const res = await execCommand({ windowId, workspaceId, paneId: null }, OPEN_FILES_COMMAND, {
        files: [{ path }],
        background: true,
      })
      return res.ok
    },
    listWorkspaceGroups: () => listWorkspaceGroups({ execCommand, windowIds }),
    primaryWindowId,
    attachPhoneObserver,
    ptyResize,
    ptyWrite,
    listAsks: askHub.list,
    answerAsk: askHub.answer,
    agentRunning: (paneId) => agentRunning.has(paneId) && ptys.has(paneId),
  })
}

import { hostname } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import { OPEN_FILES_COMMAND } from '../../shared/files/openFiles'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { AskHub } from '../approvals/asks'
import type { Reach } from '../approvals/reach'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import type { CommandBridge } from '../control/commandBridge'
import type { AppLog } from '../diagnostics/appLog'
import type { PaneConfirms } from '../panes/paneConfirm'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  registerPaneListMethods,
} from '../panes/paneList'
import type { PaneTurns } from '../panes/paneTurns'
import { processStatusOf } from '../panes/processManager'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { Redactor } from '../privacy/redaction'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { WindowSend } from '../windows/windowSend'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { createBonjourPublisher } from './announce'
import type { GatewayControlDeps } from './controlDispatch'
import {
  configureAnnouncer,
  configureTailnet,
  onTailnetChange,
  registerGatewayIpc,
  registerGatewayMethods,
} from './gatewayIpc'
import { listPairRequests, onPairRequestsChanged } from './pairRequests'
import { ScreenLinks } from './screenLinks'
import { askPhonesForScreen, configureGatewayControl, configureScreenLinks } from './server'
import { createTailnet, tailnetNodeName, tsnetHelperPath } from './tailnet'
import type { PhoneFileScope } from './workspaceFiles'

interface GatewayStartDeps {
  execCommand: CommandBridge['execCommand']
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
  paneStartErrors: ReadonlyMap<string, string>
  services: {
    appLog: AppLog | null
    processes: ProcessRegistry | null
    stopAnnouncing: (() => void) | null
    stopTailnet: (() => Promise<void>) | null
  }
  reach: Reach
  workspaceSandboxes: WorkspaceSandboxes
  broadcast: WindowSend['broadcast']
  openExternalSafe: (url: string) => boolean
  listCommandsFor: CommandBridge['listCommandsFor']
  phoneFileScope: (workspaceId: string) => PhoneFileScope
  artifactFolders: ArtifactFolders
  primaryWindowId: WindowSend['primaryWindowId']
  attachPhoneObserver: PtyIo['attachPhoneObserver']
  ptyResize: PtyIo['ptyResize']
  ptyWrite: PtyIo['ptyWrite']
  askHub: AskHub
  agentRunning: AgentRunningPanes
  ptys: Map<string, PtyEntry>
  turnConfirms: PaneConfirms
  paneTurns: PaneTurns
  redactor: Redactor
  ownSnippets: GatewayControlDeps['ownSnippets']
}

export function createScreenLinks({
  execCommand,
  windowIds,
  services,
}: Pick<GatewayStartDeps, 'execCommand' | 'windowIds' | 'services'>): ScreenLinks {
  const links = new ScreenLinks({
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    askPhones: askPhonesForScreen,
    log: (event, fields) => services.appLog?.info(event, fields),
  })
  configureScreenLinks(links)
  return links
}

export function startGateway({
  execCommand,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
  paneStartErrors,
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
  turnConfirms,
  paneTurns,
  redactor,
  ownSnippets,
}: GatewayStartDeps) {
  registerPaneListMethods({
    execCommand,
    getTerminalState,
    ptyPid,
    windowIds,
    waking: isWaking,
    startError: (paneId) => paneStartErrors.get(paneId),
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
    watchesTurn: turnConfirms.watchesSubmit,
    turnStarted: async (pane) => (await turnConfirms.confirmSubmitted(pane)).ok,
    paneTurns,
    ownSnippets,
    redact: async (text) => (await redactor.redact(text)).text,
  })
}

import { hostname } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ChangeSignal } from '../../shared/common/actThenConfirm'
import { OPEN_FILES_COMMAND } from '../../shared/files/openFiles'
import type { AgentSessions } from '../agent/agentSessions'
import type { AgentResumes } from '../agents/agentResumes'
import type { AgentRunningPanes } from '../agents/agentRunning'
import { AgentStreams } from '../agents/agentStreams'
import { connectCodexRpc } from '../agents/codexRpc'
import { codexSocketOf } from '../agents/codexSockets'
import { transcriptPath } from '../agents/transcriptFiles'
import type { AskHub } from '../approvals/asks'
import type { Reach } from '../approvals/reach'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import { targetOf } from '../attention/attention'
import type { CommandBridge } from '../control/commandBridge'
import { type PlatformEventPayloads, platformEvents } from '../control/events'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import type { AppLog } from '../diagnostics/appLog'
import type { PaneConfirms } from '../panes/paneConfirm'
import type { PaneJournal } from '../panes/paneJournal'
import {
  listPanes,
  listWorkspaceGroups,
  listWorkspaces,
  registerPaneListMethods,
} from '../panes/paneList'
import type { PaneTurns } from '../panes/paneTurns'
import type { PaneWatch } from '../panes/paneWait'
import { processStatusOf } from '../panes/processManager'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { Redactor } from '../privacy/redaction'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { ServerAccount } from '../server/serverAccount'
import type { PtyIo } from '../terminal/pty/ptyIo'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { WindowSend } from '../windows/windowSend'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { createBonjourPublisher } from './announce'
import type { GatewayControlDeps } from './controlDispatch'
import {
  configureAnnouncer,
  configureRelay,
  configureTailnet,
  onTailnetChange,
  registerGatewayIpc,
  registerGatewayMethods,
  relayStatus,
  stopRemote,
} from './gatewayIpc'
import { listPairRequests, onPairRequestsChanged } from './pairRequests'
import { phoneScreenLines, withClipboardImage } from './phone/phoneClipboard'
import {
  DEFAULT_FOLDER_NAME,
  isPhoneFolder,
  loadPhoneWorkspace,
  ownFolder,
  type PhoneWorkspacePaths,
  phoneWorkspaceDefaults,
  phoneWorkspaceId,
} from './phone/phoneWorkspace'
import { registerPhoneWorkspaceIpc } from './phone/phoneWorkspaceIpc'
import { phoneInputNoter } from './phoneInput'
import { startPhonePush } from './push/pushWiring'
import { RelayClient } from './relayClient'
import { ScreenLinks } from './screenLinks'
import {
  askPhonesForScreen,
  configureGatewayControl,
  configurePhonePush,
  configureRelayPeers,
  configureScreenLinks,
  gatewayHelperPort,
  notifiedDeviceIds,
  setRelayAddress,
} from './server'
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
    stopRemote: (() => Promise<void>) | null
    agentSessions: AgentSessions | null
  }
  agentResumes: AgentResumes
  agentChanges: ChangeSignal
  agentCwd: (paneId: string) => Promise<string | null>
  paneWatch: PaneWatch
  reach: Reach
  workspaceSandboxes: WorkspaceSandboxes
  broadcast: WindowSend['broadcast']
  openExternalSafe: (url: string) => boolean
  listCommandsFor: CommandBridge['listCommandsFor']
  phoneFileScope: (workspaceId: string) => PhoneFileScope
  artifactFolders: ArtifactFolders
  primaryWindowId: WindowSend['primaryWindowId']
  attachPhoneObserver: PtyIo['attachPhoneObserver']
  ptyWrite: PtyIo['ptyWrite']
  askHub: AskHub
  agentRunning: AgentRunningPanes
  ptys: Map<string, PtyEntry>
  turnConfirms: PaneConfirms
  paneJournal: Pick<PaneJournal, 'since'>
  paneTurns: PaneTurns
  redactor: Redactor
  ownSnippets: GatewayControlDeps['ownSnippets']
  remoteCwdOfPane: (paneId: string) => unknown
  scratchFolders: Pick<ScratchFolders, 'root'>
  startAgentForPhone: GatewayControlDeps['startAgent']
  server: ServerAccount
}

export function createScreenLinks({
  execCommand,
  windowIds,
  services,
  agentRunning,
}: Pick<GatewayStartDeps, 'execCommand' | 'windowIds' | 'services' | 'agentRunning'>): ScreenLinks {
  const links = new ScreenLinks({
    listWorkspaces: () => listWorkspaces({ execCommand, windowIds }),
    askPhones: askPhonesForScreen,
    notifiedDevices: notifiedDeviceIds,
    agentRunning: (paneId) => agentRunning.has(paneId),
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
  agentResumes,
  agentChanges,
  agentCwd,
  paneWatch,
  reach,
  workspaceSandboxes,
  broadcast,
  openExternalSafe,
  listCommandsFor,
  phoneFileScope,
  artifactFolders,
  primaryWindowId,
  attachPhoneObserver,
  ptyWrite,
  askHub,
  agentRunning,
  ptys,
  turnConfirms,
  paneJournal,
  paneTurns,
  redactor,
  ownSnippets,
  remoteCwdOfPane,
  scratchFolders,
  startAgentForPhone,
  server,
}: GatewayStartDeps) {
  const phonePaths = (): PhoneWorkspacePaths => {
    const { home, dataDirs } = workspaceSandboxes.pathEnv()
    return {
      home,
      dataDirs,
      closedRoots: [scratchFolders.root, artifactFolders.root],
      defaultFolder: join(app.getPath('userData'), DEFAULT_FOLDER_NAME),
    }
  }

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
  const relay = new RelayClient({
    account: server,
    helperPort: gatewayHelperPort,
    onState: (state) => broadcast('gateway:relay-changed', state),
    onAddress: setRelayAddress,
  })
  configureRelay(relay, server)
  configureRelayPeers(relay)
  server.onChange(() => broadcast('gateway:relay-changed', relayStatus()))
  services.stopRemote = stopRemote
  const publisher = createBonjourPublisher()
  configureAnnouncer(publisher)
  services.stopAnnouncing = publisher.unpublishAll
  onPairRequestsChanged(() => broadcast('gateway:pair-requests-changed', listPairRequests()))
  registerGatewayIpc()
  registerPhoneWorkspaceIpc({ paths: phonePaths })
  const agentStreams = new AgentStreams({
    panes: () => listPanes({ execCommand, getTerminalState, ptyPid, windowIds, waking: isWaking }),
    claudeFile: async (id, pane) => {
      const cwd = await agentCwd(pane.paneId)
      return cwd ? transcriptPath({ agent: 'claude', id, cwd }) : null
    },
    codexSocket: codexSocketOf,
    codexConnect: (socket, onNotice) => connectCodexRpc(socket, app.getVersion(), onNotice),
    pi: (sessionId) => services.agentSessions?.stream(sessionId),
    asks: askHub.list,
  })
  agentResumes.subscribe((externalPaneId, resume) => agentStreams.resumed(externalPaneId, resume))
  agentChanges.subscribe(() => void agentStreams.agentsChanged())
  const { phonePush, waitingSince } = startPhonePush({
    server,
    broadcast,
    log: (event, fields) => services.appLog?.info(event, fields),
    listAsks: askHub.list,
  })
  configurePhonePush(phonePush)
  paneWatch.tap((paneId, change) => {
    if (change.kind === 'closed') agentStreams.paneClosed(paneId)
    waitingSince.observe(paneId, change)
  })
  platformEvents.on('ask.created', ({ ask }: PlatformEventPayloads['ask.created']) =>
    agentStreams.askOpened(ask),
  )
  platformEvents.on('ask.resolved', (resolved: PlatformEventPayloads['ask.resolved']) =>
    agentStreams.askResolved(resolved),
  )
  configureGatewayControl({
    agentStreams,
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
    fileScope: (workspaceId) => ({
      ...phoneFileScope(workspaceId),
      phoneFolder: ownFolder(phonePaths().defaultFolder),
    }),
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
    ptyWrite,
    phoneInput: phoneInputNoter(waitingSince.ofPane, (paneId) => {
      const pane = getByPaneId(paneId)
      if (pane) void execCommand(targetOf(pane), 'attention.typed')
    }),
    readScreen: async (paneId) =>
      (await ptys.get(paneId)?.mirror.screenText(phoneScreenLines)) ?? '',
    withClipboardImage,
    listAsks: askHub.list,
    answerAsk: askHub.answer,
    agentRunning: (paneId) => agentRunning.has(paneId) && ptys.has(paneId),
    watchesTurn: turnConfirms.watchesSubmit,
    turnStarted: async (pane) => (await turnConfirms.confirmSubmitted(pane)).ok,
    paneSince: (externalPaneId) => {
      const pane = resolveExternal(externalPaneId)
      return pane ? paneJournal.since(pane.paneId) : undefined
    },
    waitingSince: (externalPaneId) => {
      const pane = resolveExternal(externalPaneId)
      return pane ? waitingSince.ofPane(pane.paneId) : undefined
    },
    sessionWaitingSince: (sessionId) => waitingSince.ofWorkspace(sessionId),
    push: phonePush,
    paneTurns,
    ownSnippets,
    redact: async (text) => (await redactor.redact(text)).text,
    remote: (paneId) => remoteCwdOfPane(paneId) !== undefined,
    startAgent: startAgentForPhone,
    phoneWorkspace: () =>
      phoneWorkspaceId({
        paths: phonePaths,
        workspaces: () => listWorkspaces({ execCommand, windowIds }),
        open: async (dir) => {
          const windowId = primaryWindowId()
          if (!windowId) return null
          const res = await execCommand(
            { windowId, workspaceId: '', paneId: null },
            'workspace.new',
            { dir, focus: false, ungrouped: true },
          )
          const id = res.ok ? (res.result as { workspaceId?: unknown }).workspaceId : null
          return typeof id === 'string' ? id : null
        },
      }),
    phoneDefaults: () => phoneWorkspaceDefaults(phonePaths()),
    isPhoneWorkspace: (workDir) =>
      isPhoneFolder(
        workDir,
        loadPhoneWorkspace().folder ?? phonePaths().defaultFolder,
        phonePaths().home,
      ),
  })
}

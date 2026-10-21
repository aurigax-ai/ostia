import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { ExtensionPanelContext } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { RemoteCwd } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { agentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import type { ExtensionRoot } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { app, type BrowserWindow, ipcMain } from 'electron'
import { parseAgentResume } from '../../shared/agents/agentResume'
import { type ManagerSettings, managerAgents } from '../../shared/agents/managerSettings'
import type { Dict } from '../../shared/app/dict'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { AGENT_OFFER_RESULT_CHANNEL, type AgentOfferRelay } from '../agents/agentOfferRelay'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { HeldResume } from '../agents/extensionAgents'
import { playbookEnabled } from '../agents/playbookEnabled'
import { currentPlaybookSettings } from '../agents/playbookFiles'
import { targetOf } from '../attention/attention'
import { postNotification, postPanelNotification } from '../attention/notify'
import type { NotifyWiring } from '../attention/notifyWiring'
import type { CommandBridge } from '../control/commandBridge'
import { controlSocketPath } from '../control/controlServer'
import { getByPaneId, type PaneIdentity } from '../control/idRegistry'
import type { Telemetry } from '../diagnostics/telemetry'
import type { FileServices } from '../files/filesWiring'
import type { OpenFileGrants } from '../files/openFileGrants'
import { openFileForExtension } from '../files/openFileMethods'
import { confirmRemoteFolder, registerRemoteFolderConfirm } from '../files/remoteFolderConfirm'
import type { RemoteFolders, RemoteFoldersDeps } from '../files/remoteFolders'
import type { LanguageServers } from '../lsp/languageServers'
import { registerLanguageServersIpc } from '../lsp/languageServersIpc'
import type { ServerOverrides } from '../lsp/serverOverrides'
import { listPanes } from '../panes/paneList'
import type { ProcessRegistry } from '../panes/processRegistry'
import { expandHome } from '../platform/pathGuard'
import { readLocale, readSettingsFile, readSettingsFileOrNull } from '../platform/settingsFile'
import type { Redactor } from '../privacy/redaction'
import type { HostPaneGrants } from '../sandbox/hostPanes'
import { sandboxSpawnEnv } from '../sandbox/spawnEnv'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import { setAgentPlugins } from '../terminal/shellIntegration'
import type { WindowSend } from '../windows/windowSend'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { windowForWorkspace, workDirForWorkspace } from '../workspaces/workspaceRegistry'
import { registerConnectionsIpc } from './connectionsIpc'
import { confirmForExtension } from './extensionConfirm'
import type { ExtensionConnections } from './extensionConnections'
import { ExtensionExec } from './extensionExec'
import { ExtensionHost } from './extensionHost'
import type { ExtensionHostDeps, ExtensionSecretStore } from './extensionHostDeps'
import { ExtensionLaunches } from './extensionLaunches'
import { registerExtensionMethods } from './extensionMethods'
import type { PhoneScreenLinks } from './extensionPhoneScreens'
import { ExtensionStore } from './extensionStore'
import { answerInboxAction } from './inboxIpc'
import {
  AcceptedVersions,
  OFFICIAL_EXTENSION_PUBLIC_KEY,
  OFFICIAL_REVOCATIONS_FILE,
  OFFICIAL_VERSIONS_FILE,
  OfficialRevocations,
  OfficialVerifier,
} from './officialExtensions'
import { registerWireRuntime, WireRuntime } from './wireRuntime'
import { inboxEntriesForWindow, workspaceChipsForWindow } from './workspaceChips'

interface ExtensionHostPartsDeps {
  workspaceWindowId: WindowSend['workspaceWindowId']
  scratchFolders: ScratchFolders
  workspaceSandboxes: WorkspaceSandboxes
  windows: Map<string, BrowserWindow>
  publishRemoteFolders: WindowSend['publishRemoteFolders']
  execCommand: CommandBridge['execCommand']
  getTerminalState: CommandBridge['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: WindowSend['windowIds']
  isWaking: (paneId: string) => boolean
}

export function extensionHostParts({
  workspaceWindowId,
  scratchFolders,
  workspaceSandboxes,
  windows,
  publishRemoteFolders,
  execCommand,
  getTerminalState,
  ptyPid,
  windowIds,
  isWaking,
}: ExtensionHostPartsDeps) {
  const extensionRemoteFolders: ExtensionHostDeps['remoteFolders'] = {
    windowOfWorkspace: workspaceWindowId,
    refusal: (workspaceId) =>
      scratchFolders.isScratch(workspaceId)
        ? 'scratch'
        : workspaceSandboxes.isEnabled(workspaceId)
          ? 'sandboxed'
          : null,
    confirm: (req) =>
      confirmRemoteFolder(windows.get(workspaceWindowId(req.workspaceId) ?? ''), {
        extName: req.extName,
        host: req.host,
        path: req.path,
      }),
    publish: publishRemoteFolders,
  }
  const extensionExec = new ExtensionExec({
    workspace: (workspaceId) => {
      if (!windowForWorkspace(workspaceId)) return null
      const sandboxed = workspaceSandboxes.isEnabled(workspaceId)
      const workDir = sandboxed
        ? workspaceSandboxes.workDir(workspaceId)
        : workDirForWorkspace(workspaceId)
      return {
        workDir: expandHome(workDir ?? homedir(), homedir()),
        scratch: scratchFolders.isScratch(workspaceId),
        sandboxed,
      }
    },
    wrap: (workspaceId, command, extraReads) =>
      workspaceSandboxes.wrap(workspaceId, command, 'bash', [], extraReads),
    sandboxEnv: (workspaceId, env) => ({
      ...sandboxSpawnEnv(env),
      TMPDIR: workspaceSandboxes.tmp.tmpDir(workspaceId),
    }),
    dataDir: (extId) => join(app.getPath('userData'), 'extension-data', extId),
    baseEnv: () => process.env,
  })
  const resumeOfPane: ExtensionHostDeps['resumeOf'] = async (pane) => {
    const res = await execCommand(targetOf(pane), 'pane.resumeToken')
    const resume = res.ok ? parseAgentResume((res.result as { resume?: unknown })?.resume) : null
    if (!resume) return null
    const panes = await listPanes({
      execCommand,
      getTerminalState,
      ptyPid,
      windowIds,
      waking: isWaking,
    })
    const held = panes.some(
      (p) => p.agentSessionId === resume.id && p.agent === resume.agent && !p.hibernated,
    )
    return { resume, held }
  }

  return { extensionRemoteFolders, extensionExec, resumeOfPane }
}

interface ExtensionHostStartDeps {
  mainStrings: () => Dict
  services: {
    languageServers: LanguageServers | null
    extensionHost: ExtensionHost | null
    marketplaceInstallIds: () => string[]
    telemetry: Telemetry | null
    files: Pick<FileServices, 'kindsChanged'> | null
    processes: Pick<ProcessRegistry, 'adoptChild'> | null
  }
  refreshAgentPlugins: () => void
  hostPaneGrants: HostPaneGrants
  workspaceSandboxes: WorkspaceSandboxes
  extensionRoots: () => ExtensionRoot[]
  terminalState: Map<string, TerminalStateSnapshot>
  remoteCwdOfPane: (paneId: string) => RemoteCwd | undefined
  extensionRemoteFolders:
    | (Pick<RemoteFoldersDeps, 'windowOfWorkspace' | 'refusal' | 'confirm'> & {
        publish: (folders: RemoteFolders) => void
      })
    | undefined
  agentRunning: AgentRunningPanes
  ptys: Map<string, PtyEntry>
  redactor: Redactor
  assistKeyStore: () => ExtensionSecretStore
  extensionSecretStore: () => ExtensionSecretStore
  extensionConnections: () => ExtensionConnections
  sendToWorkspaceWindow: WindowSend['sendToWorkspaceWindow']
  broadcast: WindowSend['broadcast']
  publishWorkspaceChips: WindowSend['publishWorkspaceChips']
  publishInbox: WindowSend['publishInbox']
  openFileGrants: OpenFileGrants
  workspaceWindowId: WindowSend['workspaceWindowId']
  execCommand: CommandBridge['execCommand']
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  notifyDeps: NotifyWiring['notifyDeps']
  windows: Map<string, BrowserWindow>
  managerSettings: () => ManagerSettings
  agentOffers: AgentOfferRelay
  focusPaneInWindow: WindowSend['focusPaneInWindow']
  extensionExec: ExtensionExec
  resumeOfPane: ((pane: PaneIdentity) => Promise<HeldResume | null>) | undefined
  registerExtensionIpc: (host: ExtensionHost) => void
  registerRemoteFilesIpc: (host: ExtensionHost) => void
  createLanguageServers: () => LanguageServers
  serverOverrides: ServerOverrides
  screenLinks: PhoneScreenLinks
}

export function startExtensionHost({
  mainStrings,
  services,
  refreshAgentPlugins,
  hostPaneGrants,
  workspaceSandboxes,
  extensionRoots,
  terminalState,
  remoteCwdOfPane,
  extensionRemoteFolders,
  agentRunning,
  ptys,
  redactor,
  assistKeyStore,
  extensionSecretStore,
  extensionConnections,
  sendToWorkspaceWindow,
  broadcast,
  publishWorkspaceChips,
  publishInbox,
  openFileGrants,
  workspaceWindowId,
  execCommand,
  openTerminalInWindow,
  notifyDeps,
  windows,
  managerSettings,
  agentOffers,
  focusPaneInWindow,
  extensionExec,
  resumeOfPane,
  registerExtensionIpc,
  registerRemoteFilesIpc,
  createLanguageServers,
  serverOverrides,
  screenLinks,
}: ExtensionHostStartDeps) {
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  const officialVerifier = new OfficialVerifier({
    publicKey: () => OFFICIAL_EXTENSION_PUBLIC_KEY,
    revocations: new OfficialRevocations(join(app.getPath('userData'), OFFICIAL_REVOCATIONS_FILE)),
    accepted: new AcceptedVersions(join(app.getPath('userData'), OFFICIAL_VERSIONS_FILE)),
    onVerified: () => services.extensionHost?.processes.rescan(),
  })
  services.extensionHost = new ExtensionHost({
    onChanged: () => {
      services.languageServers?.refresh()
      refreshAgentPlugins()
    },
    onBrowseKindsChanged: () => services.files?.kindsChanged(),
    onCrashed: (extId, builtin) =>
      services.telemetry?.error({
        source: 'extension-crashed',
        name: 'ExtensionCrashed',
        message: 'exited too often',
        ...(builtin || services.marketplaceInstallIds().includes(extId)
          ? { extension: extId }
          : {}),
      }),
    hostGrants: hostPaneGrants,
    isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
    sandboxDomains: (workspaceId) =>
      workspaceSandboxes.isEnabled(workspaceId)
        ? workspaceSandboxes.resolved(workspaceId).domains
        : null,
    roots: extensionRoots(),
    officialUpdate: officialVerifier.check,
    store: extensionStore,
    launches: new ExtensionLaunches(join(app.getPath('userData'), 'extension-launches.json')),
    socketPath: controlSocketPath,
    nodePath: process.execPath,
    dataDir: join(app.getPath('userData'), 'extension-data'),
    workDirForWorkspace,
    cwdForPane: (paneId) => terminalState.get(paneId)?.cwd,
    remoteCwdForPane: remoteCwdOfPane,
    remoteFolders: extensionRemoteFolders,
    agentRunning: (paneId) => agentRunning.has(paneId),
    claimHumanPrompt: (paneId, extId) => ptys.get(paneId)?.input.claimHumanPrompt(extId) ?? null,
    locale: readLocale,
    readExtensionSettings: () => readSettingsFile().extensionSettings,
    readAssistSettings: readSettingsFileOrNull,
    redact: redactor.redact,
    assistKeys: assistKeyStore(),
    secrets: extensionSecretStore(),
    connections: extensionConnections(),
    openAssistUiIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'assist:open-ui', req),
    broadcast,
    publishWorkspaceChips,
    publishInbox,
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openFileIn: (req) =>
      openFileForExtension(
        { grants: openFileGrants, windowOf: workspaceWindowId, execCommand },
        req,
      ),
    openTerminalIn: openTerminalInWindow,
    adoptPane: (ownerPaneId, paneId) => services.processes?.adoptChild(ownerPaneId, paneId),
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) =>
      confirmForExtension(req, windows.values(), mainStrings().native.extensionConfirm),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    agentNames: () => Object.keys(managerAgents(managerSettings())),
    offerToAgentIn: (offer) => agentOffers.offer(offer),
    focusPaneIn: focusPaneInWindow,
    exec: extensionExec,
    playbookEnabled: (id) => playbookEnabled(currentPlaybookSettings(), id),
    resumeOf: resumeOfPane,
    screenLinks,
  })
  refreshAgentPlugins()
  registerExtensionMethods(() => services.extensionHost)
  registerWireRuntime({
    host: () => services.extensionHost,
    runtime: new WireRuntime({ nodePath: process.execPath, baseEnv: () => process.env }),
  })
  registerExtensionIpc(services.extensionHost)
  registerRemoteFilesIpc(services.extensionHost)
  ipcMain.on(AGENT_OFFER_RESULT_CHANNEL, (e, requestId: unknown, paneId: unknown) =>
    agentOffers.answer(String(e.sender.id), requestId, paneId),
  )
  services.languageServers = createLanguageServers()
  services.languageServers.refresh()
  registerLanguageServersIpc({
    servers: services.languageServers,
    setEnabled: (extId, serverId, enabled) =>
      services.extensionHost?.contributions.setLanguageServerEnabled(extId, serverId, enabled),
    setOverride: (key, override) => serverOverrides.choose(key, override),
  })

  return { extensionStore, extensionHost: services.extensionHost }
}

interface ExtensionIpcDeps {
  services: {
    extensionHost: ExtensionHost | null
    marketplaceInstallIds: () => string[]
    telemetry: Telemetry | null
  }
  configDir: () => string
  workspaceWindowId: WindowSend['workspaceWindowId']
  terminalState: Map<string, TerminalStateSnapshot>
  remoteCwdOfPane: (paneId: string) => RemoteCwd | undefined
}

export function createExtensionIpc({
  services,
  configDir,
  workspaceWindowId,
  terminalState,
  remoteCwdOfPane,
}: ExtensionIpcDeps) {
  function refreshAgentPlugins(): void {
    try {
      setAgentPlugins(
        agentPluginContent(
          services.extensionHost?.contributions.agentPlugins() ?? [],
          (extId, problem) => console.error(`[ext:${extId}] ${problem}`),
        ),
      )
    } catch (err) {
      console.error(`agent plugins: ${(err as Error).message}`)
    }
  }

  function extensionRoots(): ExtensionRoot[] {
    const builtinDir = app.isPackaged
      ? join(process.resourcesPath, 'extensions')
      : join(app.getAppPath(), 'out/extensions')
    return [
      { dir: builtinDir, builtin: true },
      { dir: join(configDir(), 'extensions'), builtin: false },
    ]
  }

  function registerExtensionIpc(host: ExtensionHost): void {
    ipcMain.handle('extensions:list', () => host.list())
    ipcMain.handle('extensions:set-enabled', (_e, extId: string, enabled: boolean) =>
      host.processes.setEnabled(String(extId), enabled === true),
    )
    ipcMain.handle('extensions:approve', (_e, extId: string) =>
      host.processes.approve(String(extId)),
    )
    ipcMain.handle('extensions:sidebar', () => host.slots.sidebarItems())
    ipcMain.handle('extensions:panel-toolbar', () => host.slots.panelToolbarEntries())
    ipcMain.handle('extensions:inbox', (e) =>
      inboxEntriesForWindow(host.slots.inboxEntries(), workspaceWindowId, String(e.sender.id)),
    )
    ipcMain.handle(
      'extensions:inbox-action',
      (e, extId: unknown, workspaceId: unknown, id: unknown): boolean =>
        answerInboxAction(
          host.slots,
          workspaceWindowId,
          String(e.sender.id),
          extId,
          workspaceId,
          id,
        ),
    )
    ipcMain.handle('extensions:chips', () => host.slots.paneChips())
    ipcMain.handle('extensions:workspace-chips', (e) =>
      workspaceChipsForWindow(host.slots.workspaceChips(), workspaceWindowId, String(e.sender.id)),
    )
    ipcMain.handle('extensions:set-setting', (_e, extId: unknown, key: unknown, value: unknown) => {
      if (typeof extId === 'string' && services.marketplaceInstallIds().includes(extId)) {
        services.telemetry?.count('extensions', 'setting_change', `${extId}.${String(key)}`)
      }
      return host.config.setSetting(String(extId), String(key), value)
    })
    ipcMain.handle('extensions:set-secret', (_e, extId: unknown, key: unknown, value: unknown) =>
      host.config.setSecret(String(extId), String(key), value),
    )
    registerConnectionsIpc(() => host?.config ?? null)
    ipcMain.handle(
      'extensions:invoke',
      (
        _e,
        extId: string,
        command: string,
        target: { workspaceId: string | null; paneId: string | null },
        argument?: unknown,
      ): Promise<ExtensionResult> => {
        const paneId = target?.paneId ? getByPaneId(target.paneId)?.externalId : undefined
        const cwd = target?.paneId ? terminalState.get(target.paneId)?.cwd : undefined
        const remote = target?.paneId ? remoteCwdOfPane(target.paneId) : undefined
        const caller = host.userCaller(target?.workspaceId ?? null, {
          capabilities: host.commandCapabilities(extId, command),
          ...(paneId ? { paneId } : {}),
          ...(cwd ? { cwd } : {}),
          ...(remote ? { remote } : {}),
        })
        return host.invoke(extId, command, host.paletteArgs(extId, command, argument), caller)
      },
    )
    ipcMain.handle('extensions:panel', (_e, extId: string, context: ExtensionPanelContext) =>
      host.panels.resolvePanel(String(extId), {
        workspaceId: String(context?.workspaceId ?? ''),
        locale: String(context?.locale ?? 'en'),
        ...(context?.path === undefined ? {} : { path: String(context.path) }),
      }),
    )
  }

  function registerRemoteFilesIpc(host: ExtensionHost): void {
    const folders = host.remoteFolders
    if (!folders) return
    registerRemoteFolderConfirm()
    const sender = (e: Electron.IpcMainInvokeEvent): string => String(e.sender.id)
    ipcMain.handle('remote-files:folders', (e) => folders.forWindow(sender(e)))
    ipcMain.handle('remote-files:close', (e, folderId: unknown) =>
      folders.closeByWindow(sender(e), folderId),
    )
    ipcMain.handle('remote-files:list', (e, path: unknown) => folders.list(sender(e), path))
    ipcMain.handle('remote-files:stat', (e, path: unknown) => folders.stat(sender(e), path))
    ipcMain.handle('remote-files:read', (e, path: unknown) => folders.read(sender(e), path))
    ipcMain.handle(
      'remote-files:write',
      (e, path: unknown, content: unknown, baseVersion: unknown) =>
        folders.write(sender(e), path, content, baseVersion),
    )
  }

  return {
    refreshAgentPlugins,
    extensionRoots,
    registerExtensionIpc,
    registerRemoteFilesIpc,
  }
}

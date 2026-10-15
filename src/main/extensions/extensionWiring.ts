import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionPanelContext,
  ExtensionResult,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { OFFICIAL_MARKETPLACE } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import type { RemoteCwd } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { agentPluginContent } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import type { ExtensionRoot } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { type BrowserWindow, app, ipcMain } from 'electron'
import { parseAgentResume } from '../../shared/agents/agentResume'
import { type ManagerSettings, managerAgents } from '../../shared/agents/managerSettings'
import { EXTENSION_SUGGESTIONS } from '../../shared/extensions/extensionSuggestions'
import type { CommandResult, CommandTarget, TerminalStateSnapshot } from '../../shared/types'
import { AGENT_OFFER_RESULT_CHANNEL, type AgentOfferRelay } from '../agents/agentOfferRelay'
import type { AgentRunningPanes } from '../agents/agentRunning'
import type { HeldResume } from '../agents/extensionAgents'
import { targetOf } from '../attention/attention'
import { type NotifyDeps, postNotification, postPanelNotification } from '../attention/notify'
import { controlSocketPath } from '../control/controlServer'
import { type PaneIdentity, getByPaneId } from '../control/idRegistry'
import type { Telemetry } from '../diagnostics/telemetry'
import type { OpenFileGrants } from '../files/openFileGrants'
import { openFileForExtension } from '../files/openFileMethods'
import { confirmRemoteFolder, registerRemoteFolderConfirm } from '../files/remoteFolderConfirm'
import type { RemoteFolders, RemoteFoldersDeps } from '../files/remoteFolders'
import type { LanguageServers } from '../lsp/languageServers'
import { registerLanguageServersIpc } from '../lsp/languageServersIpc'
import type { ManagedServers } from '../lsp/managedServers'
import type { ServerOverrides } from '../lsp/serverOverrides'
import { listPanes } from '../panes/paneList'
import type { ProcessTabRequest } from '../panes/processLaunch'
import { expandHome } from '../platform/pathGuard'
import { readLocale, readSettingsFile, readSettingsFileOrNull } from '../platform/settingsFile'
import type { Redactor } from '../privacy/redaction'
import type { HostPaneGrants } from '../sandbox/hostPanes'
import { sandboxSpawnEnv } from '../sandbox/spawnEnv'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { setAgentPlugins } from '../terminal/shellIntegration'
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
import { ExtensionStore } from './extensionStore'
import { DismissedSuggestions, suggestionFor } from './extensionSuggestions'
import { Marketplace, marketplaceId } from './marketplace'
import { type OwnerLookup, workspaceChipsForWindow } from './workspaceChips'

interface ExtensionHostPartsDeps {
  workspaceWindowId: OwnerLookup
  scratchFolders: ScratchFolders
  workspaceSandboxes: WorkspaceSandboxes
  windows: Map<string, BrowserWindow>
  publishRemoteFolders: (folders: RemoteFolders) => void
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
      TMPDIR: workspaceSandboxes.tmpDir(workspaceId),
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
  services: {
    extensionHost: ExtensionHost | null
    languageServers: LanguageServers | null
    marketplaceInstallIds: () => string[]
    telemetry: Telemetry | null
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
  redactor: Redactor
  assistKeyStore: () => ExtensionSecretStore
  extensionSecretStore: () => ExtensionSecretStore
  extensionConnections: () => ExtensionConnections
  sendToWorkspaceWindow: (
    workspaceId: string | undefined,
    channel: string,
    payload: unknown,
  ) => void
  broadcast: (channel: string, payload: unknown) => void
  publishWorkspaceChips: (chips: WorkspaceChip[]) => void
  openFileGrants: OpenFileGrants
  workspaceWindowId: OwnerLookup
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  openTerminalInWindow: (req: ProcessTabRequest) => Promise<string | null>
  notifyDeps: NotifyDeps
  windows: Map<string, BrowserWindow>
  managerSettings: () => ManagerSettings
  agentOffers: AgentOfferRelay
  focusPaneInWindow: (pane: PaneIdentity) => boolean
  extensionExec: ExtensionExec
  resumeOfPane: ((pane: PaneIdentity) => Promise<HeldResume | null>) | undefined
  registerExtensionIpc: (host: ExtensionHost) => void
  registerRemoteFilesIpc: (host: ExtensionHost) => void
  createLanguageServers: () => LanguageServers
  serverOverrides: ServerOverrides
}

export function startExtensionHost({
  services,
  refreshAgentPlugins,
  hostPaneGrants,
  workspaceSandboxes,
  extensionRoots,
  terminalState,
  remoteCwdOfPane,
  extensionRemoteFolders,
  agentRunning,
  redactor,
  assistKeyStore,
  extensionSecretStore,
  extensionConnections,
  sendToWorkspaceWindow,
  broadcast,
  publishWorkspaceChips,
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
}: ExtensionHostStartDeps) {
  const extensionStore = new ExtensionStore(join(app.getPath('userData'), 'extensions.json'))
  services.extensionHost = new ExtensionHost({
    onChanged: () => {
      services.languageServers?.refresh()
      refreshAgentPlugins()
    },
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
    openPanelIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-panel', req),
    openDiffIn: (req) => sendToWorkspaceWindow(req.workspaceId, 'extensions:open-diff', req),
    openFileIn: (req) =>
      openFileForExtension(
        { grants: openFileGrants, windowOf: workspaceWindowId, execCommand },
        req,
      ),
    openTerminalIn: openTerminalInWindow,
    notify: (n) => postNotification(notifyDeps, n),
    confirm: (req) => confirmForExtension(req, windows.values()),
    notifyPanel: (n, open) => postPanelNotification(notifyDeps, n, open),
    agentArgv: (name) => managerAgents(managerSettings())[name] ?? null,
    agentNames: () => Object.keys(managerAgents(managerSettings())),
    offerToAgentIn: (offer) => agentOffers.offer(offer),
    focusPaneIn: focusPaneInWindow,
    exec: extensionExec,
    resumeOf: resumeOfPane,
  })
  refreshAgentPlugins()
  registerExtensionMethods(() => services.extensionHost)
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

interface MarketplaceStartDeps {
  configDir: () => string
  services: {
    extensionHost: ExtensionHost | null
    marketplaceInstallIds: () => string[]
  }
  managedServers: ManagedServers
  serverOverrides: ServerOverrides
  extensionStore: ExtensionStore
  extensionConnections: () => ExtensionConnections
  extensionSecretStore: () => ExtensionSecretStore
  assistKeyStore: () => ExtensionSecretStore
  registerMarketplaceIpc: (marketplace: Marketplace) => void
  officialMarketplaceId: string
}

export function startMarketplace({
  configDir,
  services,
  managedServers,
  serverOverrides,
  extensionStore,
  extensionConnections,
  extensionSecretStore,
  assistKeyStore,
  registerMarketplaceIpc,
  officialMarketplaceId,
}: MarketplaceStartDeps) {
  const marketplace = new Marketplace({
    recordsPath: join(app.getPath('userData'), 'marketplaces.json'),
    clonesDir: join(app.getPath('userData'), 'marketplaces'),
    extensionsDir: join(configDir(), 'extensions'),
    builtinIds: () =>
      services.extensionHost
        ?.list()
        .filter((ext) => ext.builtin)
        .map((ext) => ext.id) ?? [],
    forget: (extId) => {
      managedServers.forgetExtension(extId)
      serverOverrides.forgetExtension(extId)
      extensionStore.delete(extId)
      extensionConnections().forget(extId)
      for (const secrets of [extensionSecretStore(), assistKeyStore()]) {
        for (const key of secrets.keys(extId)) secrets.set(extId, key, null)
      }
    },
    rescan: () => services.extensionHost?.processes.rescan(),
    locale: readLocale,
    official: OFFICIAL_MARKETPLACE,
  })
  registerMarketplaceIpc(marketplace)
  services.marketplaceInstallIds = () =>
    marketplace
      .syncedInstalls()
      .filter((install) => marketplaceId(install.marketplace) === officialMarketplaceId)
      .map((install) => install.id)

  return { marketplace }
}

interface ExtensionIpcDeps {
  services: {
    extensionHost: ExtensionHost | null
    marketplaceInstallIds: () => string[]
    telemetry: Telemetry | null
  }
  configDir: () => string
  workspaceWindowId: OwnerLookup
  terminalState: Map<string, TerminalStateSnapshot>
  remoteCwdOfPane: (paneId: string) => RemoteCwd | undefined
  openFileGrants: OpenFileGrants
  officialMarketplaceId: string
  editorLanguageOf: (path: string) => string
}

export function createExtensionIpc({
  services,
  configDir,
  workspaceWindowId,
  terminalState,
  remoteCwdOfPane,
  openFileGrants,
  officialMarketplaceId,
  editorLanguageOf,
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

  function registerMarketplaceIpc(marketplace: Marketplace): void {
    ipcMain.handle('marketplace:list', () => marketplace.state())
    ipcMain.handle('marketplace:add', (_e, url: unknown) => marketplace.add(url))
    ipcMain.handle('marketplace:remove', (_e, id: unknown, uninstallExtensions: unknown) =>
      marketplace.remove(id, uninstallExtensions),
    )
    ipcMain.handle('marketplace:refresh', (_e, id: unknown) => marketplace.refresh(id))
    ipcMain.handle('marketplace:install', (_e, id: unknown, extId: unknown) =>
      marketplace.install(id, extId),
    )
    ipcMain.handle('marketplace:install-code', (_e, id: unknown, code: unknown) =>
      marketplace.installCode(id, code),
    )
    ipcMain.handle('marketplace:uninstall', (_e, extId: unknown) => marketplace.uninstall(extId))

    const dismissed = new DismissedSuggestions(
      join(app.getPath('userData'), 'extension-suggestions.json'),
    )
    ipcMain.handle('suggestions:for-file', (e, paneId: unknown, path: unknown) => {
      if (typeof paneId !== 'string' || typeof path !== 'string') return null
      if (getByPaneId(paneId)?.windowId !== String(e.sender.id)) return null
      const file = openFileGrants.confine(path)
      if (file === null) return null
      return suggestionFor(file, {
        servers: () => services.extensionHost?.contributions.languageServers() ?? [],
        extensions: () => services.extensionHost?.list() ?? [],
        listings: () => marketplace.languageListings(),
        dismissed: () => dismissed.list(),
        official: officialMarketplaceId,
        languageOf: editorLanguageOf,
      })
    })
    ipcMain.handle('suggestions:dismiss', (_e, extId: unknown) => dismissed.dismiss(extId))
    ipcMain.handle('suggestions:install', (_e, extId: unknown) =>
      marketplace.installSuggested(
        extId,
        OFFICIAL_MARKETPLACE,
        typeof extId === 'string' && Object.hasOwn(EXTENSION_SUGGESTIONS, extId),
      ),
    )
  }

  return {
    refreshAgentPlugins,
    extensionRoots,
    registerExtensionIpc,
    registerRemoteFilesIpc,
    registerMarketplaceIpc,
  }
}

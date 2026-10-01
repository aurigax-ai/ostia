import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentSessionInfo } from '../shared/agentSessionInfo'
import type { ApprovalState } from '../shared/approvals'
import type {
  AssistAvailability,
  AssistChunk,
  AssistExtensionState,
  AssistOpenUiRequest,
} from '../shared/assist'
import type { BrowserStorageRead, StorageWriteResult } from '../shared/browserStorage'
import type { BuildInfo } from '../shared/buildInfo'
import type {
  ChatExportResult,
  ChatSaveResult,
  ChatSession,
  ChatSessionSummary,
} from '../shared/chatSessions'
import type { McpServerStatus } from '../shared/chatTools'
import type { SpecCommand } from '../shared/completionSpec'
import type {
  CredentialImportResult,
  CredentialSaveResult,
  CredentialSummary,
} from '../shared/credentials'
import type {
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
  ExtensionOpenTerminalRequest,
  ExtensionPanelSource,
  ExtensionResult,
  ExtensionSecretResult,
  ExtensionSettingResult,
  ExtensionSettingsStored,
  ExtensionSidebarItem,
  PaneChip,
  WorkspaceChip,
} from '../shared/extensions'
import type { LoadedIconTheme } from '../shared/iconTheme'
import type { LanguagePack } from '../shared/languagePack'
import type { LanguageServerInfo, LspLog, LspSessionInfo } from '../shared/languageServers'
import type { MarketplaceResult, MarketplaceState } from '../shared/marketplace'
import type { OpenFileVerdict } from '../shared/openFiles'
import type { PickOutcome, PickSendResult, PickState } from '../shared/pick'
import type { ReleaseCheckResult, ReleaseInfo } from '../shared/releases'
import type {
  DomainRefusal,
  SandboxEditResult,
  SandboxExposeResult,
  SandboxPortRow,
  WorkspaceSandbox,
} from '../shared/sandbox'
import type { SecretEntry, SecretGrant } from '../shared/secrets'
import type { SelectionSendResult } from '../shared/selection'
import type { RequirementsReport } from '../shared/systemRequirements'
import type {
  AppInfo,
  AppSnapshot,
  CommandInvokeRequest,
  CredentialFillResult,
  ExternalEditorResult,
  FsBinaryResult,
  FsEntry,
  FsKind,
  GatewayBindOptions,
  GatewayDevice,
  GatewayEnableResult,
  GatewayPairResult,
  GatewaySetCapResult,
  GatewayStatus,
  ManagerOpenPaneRequest,
  NotificationEntry,
  OpenPathResult,
  PineBridge,
  Platform,
  PromptContext,
  PtyAttachResult,
  RunningGroup,
  SnapshotWorkspace,
  SyncStatus,
  WindowInfo,
  WindowSummary,
  WorkspaceMergeResult,
  WorkspaceProject,
} from '../shared/types'
import type { ViewListing } from '../shared/views'
import type { WorkflowListing, WorkflowSaveResult } from '../shared/workflows'

const bridge: PineBridge = {
  ping: () => ipcRenderer.invoke('app:ping') as Promise<'pong'>,
  info: () => ipcRenderer.invoke('app:info') as Promise<AppInfo>,
  platform: process.platform as Platform,
  diagnostics: {
    report: (report) => ipcRenderer.send('diagnostics:report', report),
    ready: (paneIds) => ipcRenderer.send('diagnostics:ready', paneIds),
    reloadWindow: () => ipcRenderer.send('diagnostics:reload-window'),
    toggleDevTools: () => ipcRenderer.send('diagnostics:toggle-devtools'),
    openLogFolder: () => ipcRenderer.invoke('diagnostics:open-log-folder') as Promise<boolean>,
    testHooks: () => ipcRenderer.invoke('diagnostics:test-hooks') as Promise<boolean>,
    onTestCrash: (handler) => {
      const listener = (): void => handler()
      ipcRenderer.on('diagnostics:test-crash', listener)
      return () => ipcRenderer.removeListener('diagnostics:test-crash', listener)
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    quit: () => ipcRenderer.send('window:quit'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    setZoom: (percent) => ipcRenderer.invoke('window:set-zoom', percent) as Promise<number>,
    isSystemDark: () => ipcRenderer.invoke('window:system-dark') as Promise<boolean>,
    onSystemDarkChange: (cb) => {
      const handler = (_event: unknown, dark: boolean): void => cb(dark)
      ipcRenderer.on('window:system-dark-changed', handler)
      return () => ipcRenderer.removeListener('window:system-dark-changed', handler)
    },
    onMaximizeChange: (cb) => {
      const handler = (_event: unknown, maximized: boolean): void => cb(maximized)
      ipcRenderer.on('window:maximized', handler)
      return () => ipcRenderer.removeListener('window:maximized', handler)
    },
    onRunningQuery: (cb) => {
      const handler = (_event: unknown, requestId: number): void =>
        ipcRenderer.send('window:close-answer', requestId, cb())
      ipcRenderer.on('window:running', handler)
      return () => ipcRenderer.removeListener('window:running', handler)
    },
    onConfirmClose: (cb) => {
      const handler = (_event: unknown, requestId: number, groups: RunningGroup[]): void => {
        void cb(groups).then((approved) =>
          ipcRenderer.send('window:close-answer', requestId, approved),
        )
      }
      ipcRenderer.on('window:confirm-close', handler)
      return () => ipcRenderer.removeListener('window:confirm-close', handler)
    },
    onFreeze: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('window:freeze', handler)
      return () => ipcRenderer.removeListener('window:freeze', handler)
    },
  },
  pty: {
    attach: (paneId, opts) =>
      ipcRenderer.invoke('pty:attach', paneId, opts) as Promise<PtyAttachResult>,
    detach: (paneId) => ipcRenderer.send('pty:detach', paneId),
    hibernate: (paneId) => ipcRenderer.invoke('pty:hibernate', paneId) as Promise<boolean>,
    restart: (paneId) => ipcRenderer.invoke('pty:restart', paneId) as Promise<boolean>,
    reportAgentRunning: (paneId, running) => ipcRenderer.send('pty:agent-running', paneId, running),
    write: (paneId, data) => ipcRenderer.send('pty:write', paneId, data),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    commands: (paneId) => ipcRenderer.invoke('pty:commands', paneId) as Promise<string[]>,
    listDir: (paneId, dir) => ipcRenderer.invoke('pty:list-dir', paneId, dir),
    localPrompt: (paneId) => ipcRenderer.invoke('pty:local-prompt', paneId),
    foreground: (paneId) => ipcRenderer.invoke('pty:foreground', paneId) as Promise<string | null>,
    promptContext: (paneId, want) =>
      ipcRenderer.invoke('pty:prompt-context', paneId, want) as Promise<PromptContext | null>,
    onData: (paneId, cb) => {
      const handler = (_e: unknown, data: string): void => cb(data)
      ipcRenderer.on(`pty:data:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:data:${paneId}`, handler)
    },
    onExit: (paneId, cb) => {
      const handler = (_e: unknown, code: number, closes: boolean): void => cb(code, closes)
      ipcRenderer.on(`pty:exit:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:exit:${paneId}`, handler)
    },
    onSize: (paneId, cb) => {
      const handler = (_e: unknown, cols: number, rows: number): void => cb(cols, rows)
      ipcRenderer.on(`pty:size:${paneId}`, handler)
      return () => ipcRenderer.removeListener(`pty:size:${paneId}`, handler)
    },
    onRun: (cb) => {
      const handler = (_e: unknown, paneId: string, command: string): void => cb(paneId, command)
      ipcRenderer.on('pty:run', handler)
      return () => ipcRenderer.removeListener('pty:run', handler)
    },
  },
  manager: {
    onOpen: (cb) => {
      const handler = (_e: unknown, requestId: string, req: ManagerOpenPaneRequest): void =>
        ipcRenderer.send('manager:open-result', requestId, cb(req))
      ipcRenderer.on('manager:open', handler)
      ipcRenderer.send('manager:ready')
      return () => ipcRenderer.removeListener('manager:open', handler)
    },
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path) as Promise<FsEntry[]>,
    read: (path) => ipcRenderer.invoke('fs:read', path) as Promise<string | null>,
    stat: (path) => ipcRenderer.invoke('fs:stat', path) as Promise<FsKind | null>,
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
    readBinary: (path) => ipcRenderer.invoke('fs:read-binary', path) as Promise<FsBinaryResult>,
    watch: (path) => ipcRenderer.invoke('fs:watch', path) as Promise<boolean>,
    unwatch: (path) => ipcRenderer.send('fs:unwatch', path),
    onChanged: (cb) => {
      const handler = (_e: unknown, change: { path: string; exists: boolean }): void => cb(change)
      ipcRenderer.on('fs:changed', handler)
      return () => ipcRenderer.removeListener('fs:changed', handler)
    },
  },
  lsp: {
    servers: () => ipcRenderer.invoke('lsp:servers') as Promise<LanguageServerInfo[]>,
    onServersChanged: (cb) => {
      const handler = (_e: unknown, list: LanguageServerInfo[]): void => cb(list)
      ipcRenderer.on('lsp:servers-changed', handler)
      return () => ipcRenderer.removeListener('lsp:servers-changed', handler)
    },
    open: (paneId, filePath) =>
      ipcRenderer.invoke('lsp:open', paneId, filePath) as Promise<LspSessionInfo[]>,
    send: (sessionId, message) => ipcRenderer.send('lsp:send', sessionId, message),
    release: (sessionId) => ipcRenderer.send('lsp:release', sessionId),
    onMessage: (sessionId, cb) => {
      const handler = (_e: unknown, message: unknown): void => cb(message)
      ipcRenderer.on(`lsp:msg:${sessionId}`, handler)
      return () => ipcRenderer.removeListener(`lsp:msg:${sessionId}`, handler)
    },
    onExit: (sessionId, cb) => {
      const handler = (): void => cb()
      ipcRenderer.on(`lsp:exit:${sessionId}`, handler)
      return () => ipcRenderer.removeListener(`lsp:exit:${sessionId}`, handler)
    },
    setEnabled: (serverKey, enabled) =>
      ipcRenderer.invoke('extensions:set-language-server', serverKey, enabled) as Promise<
        LanguageServerInfo[]
      >,
    restart: (serverKey) => ipcRenderer.invoke('lsp:restart', serverKey) as Promise<void>,
    log: (serverKey) => ipcRenderer.invoke('lsp:log', serverKey) as Promise<LspLog>,
  },
  settings: {
    path: () => ipcRenderer.invoke('settings:path') as Promise<string>,
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    },
  },
  sync: {
    status: () => ipcRenderer.invoke('sync:status') as Promise<SyncStatus>,
    run: () => ipcRenderer.invoke('sync:run') as Promise<SyncStatus>,
    pickFolder: () => ipcRenderer.invoke('dialog:pick-folder') as Promise<string | null>,
    onStatus: (cb) => {
      const handler = (_e: unknown, status: SyncStatus): void => cb(status)
      ipcRenderer.on('sync:status', handler)
      return () => ipcRenderer.removeListener('sync:status', handler)
    },
  },
  workspace: {
    save: (snapshot) => ipcRenderer.send('workspace:save', snapshot),
    load: () => ipcRenderer.invoke('workspace:load') as Promise<AppSnapshot | null>,
    merge: (sourceId, targetId) =>
      ipcRenderer.invoke('workspace:merge', sourceId, targetId) as Promise<WorkspaceMergeResult>,
  },
  scratch: {
    create: () => ipcRenderer.invoke('scratch:create') as Promise<string | null>,
    files: (workspaceId) => ipcRenderer.invoke('scratch:files', workspaceId) as Promise<number>,
    reveal: (workspaceId) => ipcRenderer.send('scratch:reveal', workspaceId),
  },
  windows: {
    info: () => ipcRenderer.invoke('windows:info') as Promise<WindowInfo>,
    detach: (workspace, at) =>
      ipcRenderer.invoke('windows:detach', workspace, at) as Promise<boolean>,
    dropPane: (drop) => ipcRenderer.send('windows:drop-pane', drop),
    landing: (paneId) => ipcRenderer.invoke('windows:landing', paneId) as Promise<boolean>,
    give: (workspace) => ipcRenderer.invoke('windows:give', workspace) as Promise<boolean>,
    returnToMain: (workspaces) =>
      ipcRenderer.invoke('windows:return', workspaces) as Promise<boolean>,
    report: (workspaces) => ipcRenderer.send('windows:report', workspaces),
    focusWorkspace: (workspaceId, jumpToUnread) =>
      ipcRenderer.send('windows:focus-workspace', workspaceId, jumpToUnread),
    returnWorkspace: (workspaceId) => ipcRenderer.send('windows:return-workspace', workspaceId),
    newWorkspace: (request) => ipcRenderer.send('windows:new-workspace', request),
    onList: (cb) => {
      const handler = (_e: unknown, list: WindowSummary[]): void => cb(list)
      ipcRenderer.on('windows:list', handler)
      return () => ipcRenderer.removeListener('windows:list', handler)
    },
    onAdopt: (cb) => {
      const handler = (_e: unknown, workspaces: SnapshotWorkspace[]): void => cb(workspaces)
      ipcRenderer.on('windows:adopt', handler)
      return () => ipcRenderer.removeListener('windows:adopt', handler)
    },
    onActivateWorkspace: (cb) => {
      const handler = (_e: unknown, workspaceId: string, jumpToUnread: boolean): void =>
        cb(workspaceId, jumpToUnread)
      ipcRenderer.on('windows:activate-workspace', handler)
      return () => ipcRenderer.removeListener('windows:activate-workspace', handler)
    },
    onReturnRequest: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('windows:return-request', handler)
      return () => ipcRenderer.removeListener('windows:return-request', handler)
    },
  },
  lifecycle: {
    emit: (event) => ipcRenderer.send('lifecycle:event', event),
  },
  commands: {
    publish: (descriptors) => ipcRenderer.send('commands:register', descriptors),
    onInvoke: (handler) => {
      const listener = async (
        _e: unknown,
        reqId: string,
        req: CommandInvokeRequest,
      ): Promise<void> => {
        const result = await handler(req)
        ipcRenderer.send('command:result', reqId, result)
      }
      ipcRenderer.on('command:invoke', listener)
      return () => ipcRenderer.removeListener('command:invoke', listener)
    },
  },
  terminalState: {
    push: (snapshot) => ipcRenderer.send('terminal:state', snapshot),
  },
  browser: {
    register: (paneId, webContentsId) =>
      ipcRenderer.send('browser:register', paneId, webContentsId),
    unregister: (paneId) => ipcRenderer.send('browser:unregister', paneId),
    pickStart: (paneId, theme) =>
      ipcRenderer.invoke('browser:pick-start', paneId, theme) as Promise<PickOutcome>,
    pickCancel: (paneId) => ipcRenderer.send('browser:pick-cancel', paneId),
    pickSend: (req) => ipcRenderer.invoke('browser:pick-send', req) as Promise<PickSendResult>,
    onPickState: (cb) => {
      const handler = (_e: unknown, state: PickState): void => cb(state)
      ipcRenderer.on('browser:pick-state', handler)
      return () => ipcRenderer.removeListener('browser:pick-state', handler)
    },
    storageRead: (paneId) =>
      ipcRenderer.invoke('browser:storage-read', paneId) as Promise<BrowserStorageRead>,
    storageSet: (paneId, edit) =>
      ipcRenderer.invoke('browser:storage-set', paneId, edit) as Promise<StorageWriteResult>,
    storageRemove: (paneId, removal) =>
      ipcRenderer.invoke('browser:storage-remove', paneId, removal) as Promise<StorageWriteResult>,
    storageClear: (paneId, kind) =>
      ipcRenderer.invoke('browser:storage-clear', paneId, kind) as Promise<StorageWriteResult>,
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file),
    admitDropped: (files, workspaceId) =>
      ipcRenderer.invoke(
        'files:admit-dropped',
        files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.length > 0),
        workspaceId,
      ) as Promise<OpenFileVerdict[]>,
  },
  openPath: {
    openDefault: (path) =>
      ipcRenderer.invoke('shell:open-default', path) as Promise<OpenPathResult>,
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path) as Promise<OpenPathResult>,
    project: (dir) =>
      ipcRenderer.invoke('workspace:project', dir) as Promise<WorkspaceProject | null>,
  },
  agentSession: {
    info: (resume) =>
      ipcRenderer.invoke('agent:session-info', resume) as Promise<AgentSessionInfo | null>,
  },
  update: {
    state: () => ipcRenderer.invoke('app:update-state') as Promise<BuildInfo | null>,
    restart: () => ipcRenderer.invoke('app:restart') as Promise<void>,
    onAvailable: (cb) => {
      const handler = (_event: unknown, info: BuildInfo): void => cb(info)
      ipcRenderer.on('app:update-available', handler)
      return () => ipcRenderer.removeListener('app:update-available', handler)
    },
    release: () => ipcRenderer.invoke('app:release-state') as Promise<ReleaseInfo | null>,
    checkRelease: () => ipcRenderer.invoke('app:release-check') as Promise<ReleaseCheckResult>,
    openRelease: () => ipcRenderer.invoke('app:release-open') as Promise<boolean>,
    dismissRelease: () => ipcRenderer.invoke('app:release-dismiss') as Promise<void>,
    onRelease: (cb) => {
      const handler = (_event: unknown, release: ReleaseInfo | null): void => cb(release)
      ipcRenderer.on('app:release-available', handler)
      return () => ipcRenderer.removeListener('app:release-available', handler)
    },
  },
  system: {
    requirements: (feature) =>
      ipcRenderer.invoke('system:requirements', feature) as Promise<RequirementsReport | null>,
    installRequirements: (feature, workspaceId) =>
      ipcRenderer.invoke(
        'system:install-requirements',
        feature,
        workspaceId,
      ) as Promise<ExtensionResult>,
  },
  secrets: {
    view: (workspaceId) =>
      ipcRenderer.invoke('secrets:view', workspaceId) as Promise<{
        secrets: SecretEntry[]
        grants: SecretGrant[]
      } | null>,
    setGrants: (workspaceId, grants) =>
      ipcRenderer.invoke('secrets:set-grants', workspaceId, grants) as Promise<SandboxEditResult>,
    vaultSet: (workspaceId, key, value) =>
      ipcRenderer.invoke('secrets:vault-set', workspaceId, key, value) as Promise<boolean>,
    vaultDelete: (workspaceId, key) =>
      ipcRenderer.invoke('secrets:vault-delete', workspaceId, key) as Promise<boolean>,
  },
  sandbox: {
    onBlocked: (cb) => {
      const handler = (
        _event: unknown,
        blocked: { workspaceId: string; report: RequirementsReport },
      ): void => cb(blocked)
      ipcRenderer.on('sandbox:blocked', handler)
      return () => ipcRenderer.removeListener('sandbox:blocked', handler)
    },
    get: (workspaceId) =>
      ipcRenderer.invoke('sandbox:get', workspaceId) as Promise<WorkspaceSandbox | null>,
    setAllowRead: (workspaceId, paths) =>
      ipcRenderer.invoke(
        'sandbox:set-allow-read',
        workspaceId,
        paths,
      ) as Promise<SandboxEditResult>,
    setDomains: (workspaceId, domains) =>
      ipcRenderer.invoke('sandbox:set-domains', workspaceId, domains) as Promise<SandboxEditResult>,
    setControls: (workspaceId, controls) =>
      ipcRenderer.invoke(
        'sandbox:set-controls',
        workspaceId,
        controls,
      ) as Promise<WorkspaceSandbox | null>,
    refusals: (workspaceId) =>
      ipcRenderer.invoke('sandbox:refusals', workspaceId) as Promise<DomainRefusal[]>,
    allowRefused: (workspaceId, host) =>
      ipcRenderer.invoke('sandbox:allow-refused', workspaceId, host) as Promise<boolean>,
    globalsChanged: () => ipcRenderer.invoke('sandbox:globals-changed') as Promise<boolean>,
    setPackages: (workspaceId, packages) =>
      ipcRenderer.invoke(
        'sandbox:set-packages',
        workspaceId,
        packages,
      ) as Promise<WorkspaceSandbox | null>,
    ports: (workspaceId) =>
      ipcRenderer.invoke('sandbox:ports', workspaceId) as Promise<SandboxPortRow[]>,
    expose: (workspaceId, port) =>
      ipcRenderer.invoke('sandbox:expose', workspaceId, port) as Promise<SandboxExposeResult>,
    unexpose: (workspaceId, port) =>
      ipcRenderer.invoke('sandbox:unexpose', workspaceId, port) as Promise<boolean>,
    setPortsPolicy: (workspaceId, policy) =>
      ipcRenderer.invoke(
        'sandbox:set-ports-policy',
        workspaceId,
        policy,
      ) as Promise<WorkspaceSandbox | null>,
    setEnabled: (workspaceId, enabled) =>
      ipcRenderer.invoke(
        'sandbox:set-enabled',
        workspaceId,
        enabled,
      ) as Promise<WorkspaceSandbox | null>,
  },
  credentials: {
    forPage: (paneId) =>
      ipcRenderer.invoke('credentials:for-page', paneId) as Promise<CredentialSummary[]>,
    fill: (paneId, id) =>
      ipcRenderer.invoke('credentials:fill', paneId, id) as Promise<CredentialFillResult>,
    saveFromPage: (paneId) =>
      ipcRenderer.invoke('credentials:save-from-page', paneId) as Promise<CredentialSaveResult>,
    list: () => ipcRenderer.invoke('credentials:list') as Promise<CredentialSummary[]>,
    save: (input) => ipcRenderer.invoke('credentials:save', input) as Promise<CredentialSaveResult>,
    remove: (id) => ipcRenderer.invoke('credentials:remove', id) as Promise<boolean>,
    copyPassword: (id) => ipcRenderer.invoke('credentials:copy-password', id) as Promise<boolean>,
    import: () => ipcRenderer.invoke('credentials:import') as Promise<CredentialImportResult>,
  },
  approvals: {
    state: () => ipcRenderer.invoke('approvals:state') as Promise<ApprovalState>,
    answer: (id, answer) => ipcRenderer.invoke('approvals:answer', id, answer) as Promise<boolean>,
    revoke: (id) => ipcRenderer.invoke('approvals:revoke', id) as Promise<boolean>,
    onChange: (cb) => {
      const handler = (_event: unknown, state: ApprovalState): void => cb(state)
      ipcRenderer.on('approvals:changed', handler)
      return () => ipcRenderer.removeListener('approvals:changed', handler)
    },
  },
  selection: {
    send: (req) => ipcRenderer.invoke('selection:send', req) as Promise<SelectionSendResult>,
  },
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list') as Promise<MarketplaceState>,
    add: (url) => ipcRenderer.invoke('marketplace:add', url) as Promise<MarketplaceResult>,
    remove: (id) => ipcRenderer.invoke('marketplace:remove', id) as Promise<MarketplaceResult>,
    refresh: (id) => ipcRenderer.invoke('marketplace:refresh', id) as Promise<MarketplaceResult>,
    install: (id, extId) =>
      ipcRenderer.invoke('marketplace:install', id, extId) as Promise<MarketplaceResult>,
    uninstall: (extId) =>
      ipcRenderer.invoke('marketplace:uninstall', extId) as Promise<MarketplaceResult>,
  },
  extensions: {
    list: () => ipcRenderer.invoke('extensions:list') as Promise<ExtensionInfo[]>,
    setEnabled: (extId, enabled) =>
      ipcRenderer.invoke('extensions:set-enabled', extId, enabled) as Promise<ExtensionInfo[]>,
    approve: (extId) => ipcRenderer.invoke('extensions:approve', extId) as Promise<ExtensionInfo[]>,
    invoke: (extId, command, target, argument) =>
      ipcRenderer.invoke(
        'extensions:invoke',
        extId,
        command,
        target,
        argument,
      ) as Promise<ExtensionResult>,
    panel: (extId, context) =>
      ipcRenderer.invoke('extensions:panel', extId, context) as Promise<ExtensionPanelSource>,
    sidebarItems: () => ipcRenderer.invoke('extensions:sidebar') as Promise<ExtensionSidebarItem[]>,
    paneChips: () => ipcRenderer.invoke('extensions:chips') as Promise<PaneChip[]>,
    workspaceChips: () =>
      ipcRenderer.invoke('extensions:workspace-chips') as Promise<WorkspaceChip[]>,
    setSetting: (extId, key, value) =>
      ipcRenderer.invoke(
        'extensions:set-setting',
        extId,
        key,
        value,
      ) as Promise<ExtensionSettingResult>,
    setSecret: (extId, key, value) =>
      ipcRenderer.invoke(
        'extensions:set-secret',
        extId,
        key,
        value,
      ) as Promise<ExtensionSecretResult>,
    onChanged: (cb) => {
      const handler = (_e: unknown, list: ExtensionInfo[]): void => cb(list)
      ipcRenderer.on('extensions:changed', handler)
      return () => ipcRenderer.removeListener('extensions:changed', handler)
    },
    onSidebar: (cb) => {
      const handler = (_e: unknown, items: ExtensionSidebarItem[]): void => cb(items)
      ipcRenderer.on('extensions:sidebar', handler)
      return () => ipcRenderer.removeListener('extensions:sidebar', handler)
    },
    onPaneChips: (cb) => {
      const handler = (_e: unknown, chips: PaneChip[]): void => cb(chips)
      ipcRenderer.on('extensions:chips', handler)
      return () => ipcRenderer.removeListener('extensions:chips', handler)
    },
    onWorkspaceChips: (cb) => {
      const handler = (_e: unknown, chips: WorkspaceChip[]): void => cb(chips)
      ipcRenderer.on('extensions:workspace-chips', handler)
      return () => ipcRenderer.removeListener('extensions:workspace-chips', handler)
    },
    onSettingsStored: (cb) => {
      const handler = (_e: unknown, update: ExtensionSettingsStored): void => cb(update)
      ipcRenderer.on('extensions:settings-stored', handler)
      return () => ipcRenderer.removeListener('extensions:settings-stored', handler)
    },
    onOpenPanel: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenPanelRequest): void => cb(req)
      ipcRenderer.on('extensions:open-panel', handler)
      return () => ipcRenderer.removeListener('extensions:open-panel', handler)
    },
    onOpenDiff: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenDiffRequest): void => cb(req)
      ipcRenderer.on('extensions:open-diff', handler)
      return () => ipcRenderer.removeListener('extensions:open-diff', handler)
    },
    onOpenTerminal: (cb) => {
      const handler = (_e: unknown, req: ExtensionOpenTerminalRequest): void =>
        ipcRenderer.send('extensions:open-terminal-result', req.requestId, cb(req))
      ipcRenderer.on('extensions:open-terminal', handler)
      return () => ipcRenderer.removeListener('extensions:open-terminal', handler)
    },
  },
  assist: {
    availability: () => ipcRenderer.invoke('assist:availability') as Promise<AssistAvailability>,
    onAvailability: (cb) => {
      const handler = (_e: unknown, availability: AssistAvailability): void => cb(availability)
      ipcRenderer.on('assist:availability', handler)
      return () => ipcRenderer.removeListener('assist:availability', handler)
    },
    request: (point, requestId, input) =>
      ipcRenderer.invoke('assist:request', point, requestId, input),
    cancel: (requestId) => ipcRenderer.send('assist:cancel', requestId),
    onChunk: (cb) => {
      const handler = (_e: unknown, chunk: AssistChunk): void => cb(chunk)
      ipcRenderer.on('assist:chunk', handler)
      return () => ipcRenderer.removeListener('assist:chunk', handler)
    },
    overview: () => ipcRenderer.invoke('assist:overview') as Promise<AssistExtensionState[]>,
    onOverview: (cb) => {
      const handler = (_e: unknown, overview: AssistExtensionState[]): void => cb(overview)
      ipcRenderer.on('assist:overview', handler)
      return () => ipcRenderer.removeListener('assist:overview', handler)
    },
    onOpenUi: (cb) => {
      const handler = (_e: unknown, req: AssistOpenUiRequest): void => cb(req)
      ipcRenderer.on('assist:open-ui', handler)
      return () => ipcRenderer.removeListener('assist:open-ui', handler)
    },
    reportShortcuts: (shortcuts) => ipcRenderer.send('assist:shortcuts', shortcuts),
    models: (extId) => ipcRenderer.invoke('assist:models', extId),
    setModelLoaded: (extId, id, loaded) =>
      ipcRenderer.invoke('assist:set-model-loaded', extId, id, loaded),
  },
  chatSessions: {
    list: () => ipcRenderer.invoke('chat:list') as Promise<ChatSessionSummary[]>,
    get: (id) => ipcRenderer.invoke('chat:get', id) as Promise<ChatSession | null>,
    save: (session) => ipcRenderer.invoke('chat:save', session) as Promise<ChatSaveResult>,
    rename: (id, title) =>
      ipcRenderer.invoke('chat:rename', id, title) as Promise<ChatSessionSummary | null>,
    remove: (id) => ipcRenderer.invoke('chat:remove', id) as Promise<boolean>,
    exportMarkdown: (id) => ipcRenderer.invoke('chat:export', id) as Promise<ChatExportResult>,
    saveFile: (name, content) =>
      ipcRenderer.invoke('chat:save-file', name, content) as Promise<ChatExportResult>,
  },
  chatTools: {
    read: (req) => ipcRenderer.invoke('chatTools:read', req),
    list: (req) => ipcRenderer.invoke('chatTools:list', req),
    search: (req) => ipcRenderer.invoke('chatTools:search', req),
    preview: (req) => ipcRenderer.invoke('chatTools:preview', req),
    write: (req) => ipcRenderer.invoke('chatTools:write', req),
    skills: () => ipcRenderer.invoke('chatTools:skills'),
    loadSkill: (name) => ipcRenderer.invoke('chatTools:load-skill', name),
    mcpStatus: () => ipcRenderer.invoke('chatTools:mcp-status'),
    mcpRefresh: () => ipcRenderer.invoke('chatTools:mcp-refresh'),
    mcpReconnect: (server) => ipcRenderer.invoke('chatTools:mcp-reconnect', server),
    onMcpStatus: (cb) => {
      const handler = (_e: unknown, status: McpServerStatus[]): void => cb(status)
      ipcRenderer.on('chatTools:mcp-status', handler)
      return () => ipcRenderer.removeListener('chatTools:mcp-status', handler)
    },
    mcpCall: (callId, server, tool, input) =>
      ipcRenderer.invoke('chatTools:mcp-call', callId, server, tool, input),
    mcpCancel: (callId) => ipcRenderer.send('chatTools:mcp-cancel', callId),
    setMcpSecret: (server, key, value) =>
      ipcRenderer.invoke('chatTools:set-mcp-secret', server, key, value),
  },
  externalEditor: {
    open: (req) => ipcRenderer.invoke('editor:open-external', req) as Promise<ExternalEditorResult>,
  },
  gateway: {
    enable: (opts) => ipcRenderer.invoke('gateway:enable', opts) as Promise<GatewayEnableResult>,
    disable: () => ipcRenderer.invoke('gateway:disable') as Promise<{ ok: true }>,
    pair: () => ipcRenderer.invoke('gateway:pair') as Promise<GatewayPairResult>,
    status: () => ipcRenderer.invoke('gateway:status') as Promise<GatewayStatus>,
    devices: () => ipcRenderer.invoke('gateway:devices') as Promise<{ devices: GatewayDevice[] }>,
    revoke: (deviceId) =>
      ipcRenderer.invoke('gateway:revoke', { deviceId }) as Promise<{
        ok: boolean
        error?: string
      }>,
    setCap: (deviceId, cap, granted) =>
      ipcRenderer.invoke('gateway:set-cap', {
        deviceId,
        cap,
        granted,
      }) as Promise<GatewaySetCapResult>,
    bindOptions: () => ipcRenderer.invoke('gateway:bind-options') as Promise<GatewayBindOptions>,
  },
  notifications: {
    list: () => ipcRenderer.invoke('notifications:list') as Promise<NotificationEntry[]>,
    post: (post) => ipcRenderer.send('notifications:post', post),
    clear: () => ipcRenderer.send('notifications:clear'),
    reveal: (paneId) => ipcRenderer.send('notifications:reveal', paneId),
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('notifications:changed', handler)
      return () => ipcRenderer.removeListener('notifications:changed', handler)
    },
    onActivate: (cb) => {
      const handler = (_e: unknown, paneId: string): void => cb(paneId)
      ipcRenderer.on('notifications:activate', handler)
      return () => ipcRenderer.removeListener('notifications:activate', handler)
    },
  },
  workflows: {
    list: (workspaceId) =>
      ipcRenderer.invoke('workflows:list', workspaceId) as Promise<WorkflowListing>,
    save: (doc) => ipcRenderer.invoke('workflows:save', doc) as Promise<WorkflowSaveResult>,
  },
  completions: {
    spec: (command) =>
      ipcRenderer.invoke('completions:spec', command) as Promise<SpecCommand | null>,
  },
  iconThemes: {
    load: (id) => ipcRenderer.invoke('iconThemes:load', id) as Promise<LoadedIconTheme | null>,
  },
  languagePacks: {
    load: () => ipcRenderer.invoke('languagePacks:load') as Promise<LanguagePack[]>,
  },
  views: {
    list: () => ipcRenderer.invoke('views:list') as Promise<ViewListing>,
    setEnabled: (name, enabled) =>
      ipcRenderer.invoke('views:set-enabled', name, enabled) as Promise<ViewListing>,
    reveal: (name) => ipcRenderer.invoke('views:reveal', name) as Promise<boolean>,
    onChanged: (cb) => {
      const handler = (_e: unknown, listing: ViewListing): void => cb(listing)
      ipcRenderer.on('views:changed', handler)
      return () => ipcRenderer.removeListener('views:changed', handler)
    },
  },
}

contextBridge.exposeInMainWorld('pine', bridge)

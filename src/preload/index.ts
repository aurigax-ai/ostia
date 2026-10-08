import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentSessionInfo } from '../shared/agentSessionInfo'
import type { HibernateOutcome } from '../shared/agentWork'
import type { ApprovalState } from '../shared/approvals'
import type { ArtifactListing } from '../shared/artifacts'
import type {
  AssistAvailability,
  AssistCatalog,
  AssistChunk,
  AssistExtensionState,
  AssistOpenUiRequest,
} from '../shared/assist'
import type { BrowserProfile } from '../shared/browserProfile'
import type { BrowserStorageRead, StorageWriteResult } from '../shared/browserStorage'
import type { BuildInfo } from '../shared/buildInfo'
import type {
  ChatExportResult,
  ChatSaveResult,
  ChatSession,
  ChatSessionSummary,
} from '../shared/chatSessions'
import type { McpServerStatus } from '../shared/chatTools'
import type { CmuxSessionRead } from '../shared/cmuxSession'
import type { SpecCommand } from '../shared/completionSpec'
import type {
  CredentialImportResult,
  CredentialSaveResult,
  CredentialSummary,
} from '../shared/credentials'
import type { DiscreteGpuInfo } from '../shared/discreteGpu'
import type { EditorLanguage } from '../shared/editorLanguages'
import type { ExtensionSuggestion } from '../shared/extensionSuggestions'
import type {
  ExtensionAgentOffer,
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
import type { FileOpResult } from '../shared/fileOps'
import type { CoreItems } from '../shared/git'
import type { GuestChordFire } from '../shared/guestChords'
import type { PreviewEvent, PreviewOpened } from '../shared/htmlPreview'
import type { LoadedIconTheme } from '../shared/iconTheme'
import type {
  ReleaseState,
  ReplaceProgress,
  ReplaceStart,
  ReplaceState,
  UpdateRunStart,
  UpdateRunState,
} from '../shared/installMethod'
import type { KeymapLoad } from '../shared/keymapFile'
import type { LanguagePack } from '../shared/languagePack'
import type {
  LanguageServerInfo,
  LanguageServerOverrideResult,
  LspLog,
  LspSessionInfo,
} from '../shared/languageServers'
import type { MarketplaceResult, MarketplaceState } from '../shared/marketplace'
import type { OpenFileVerdict } from '../shared/openFiles'
import type { PickOutcome, PickSendResult, PickState } from '../shared/pick'
import type { QuestionState } from '../shared/questions'
import type { AgentGroupPlacement } from '../shared/reach'
import type { RegionCaptureOutcome, RegionCopyResult } from '../shared/regionCapture'
import type { ReleaseCheckResult } from '../shared/releases'
import type {
  RemoteFolder,
  RemoteFolderAsk,
  RemoteListResult,
  RemoteReadResult,
  RemoteStatResult,
  RemoteWriteResult,
} from '../shared/remoteFolders'
import type {
  SandboxEditError,
  SandboxEditResult,
  SandboxEnableResult,
  SandboxExposeResult,
  SandboxFixedPolicy,
  SandboxPortRow,
  SandboxViolation,
  WorkspaceSandbox,
} from '../shared/sandbox'
import type { SandboxReadPreset } from '../shared/sandboxPresets'
import type { SearchOutcome } from '../shared/search'
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
  FsTextResult,
  GatewayActionResult,
  GatewayBindAddress,
  GatewayDevice,
  GatewayEnableResponse,
  GatewayPairRequest,
  GatewayPairResponse,
  GatewayRemoteStatus,
  GatewaySetCapResult,
  GatewaySetRouteResult,
  GatewayTailnetActionResult,
  GatewayTailnetState,
  ManagerOpenPaneRequest,
  NotificationEntry,
  OpenPathResult,
  OriginAgents,
  OstiaBridge,
  PaneActivity,
  PaneMoveResult,
  Platform,
  PromptContext,
  PtyAttachResult,
  ReferenceInsert,
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

const bridge: OstiaBridge = {
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
    beep: () => ipcRenderer.send('window:beep'),
    writePrimarySelection: (text) => ipcRenderer.send('window:write-primary', text),
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
      const handler = (_event: unknown, requestId: number, kept: string[]): void => {
        void Promise.resolve(cb(kept)).then((groups) =>
          ipcRenderer.send('window:close-answer', requestId, groups),
        )
      }
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
    hibernate: (paneId) => ipcRenderer.invoke('pty:hibernate', paneId) as Promise<HibernateOutcome>,
    stashed: (paneId) => ipcRenderer.invoke('pty:stashed', paneId) as Promise<string | null>,
    restart: (paneId) => ipcRenderer.invoke('pty:restart', paneId) as Promise<boolean>,
    reportAgentRunning: (paneId, running) => ipcRenderer.send('pty:agent-running', paneId, running),
    reportWaking: (paneId, waking) => ipcRenderer.send('pty:waking', paneId, waking),
    write: (paneId, data) => ipcRenderer.send('pty:write', paneId, data),
    ack: (paneId, chars) => ipcRenderer.send('pty:ack', paneId, chars),
    resize: (paneId, cols, rows) => ipcRenderer.send('pty:resize', paneId, cols, rows),
    commands: (paneId) => ipcRenderer.invoke('pty:commands', paneId) as Promise<string[]>,
    listDir: (paneId, dir) => ipcRenderer.invoke('pty:list-dir', paneId, dir),
    localPrompt: (paneId) => ipcRenderer.invoke('pty:local-prompt', paneId),
    foreground: (paneId) => ipcRenderer.invoke('pty:foreground', paneId) as Promise<string | null>,
    activity: (paneId) =>
      ipcRenderer.invoke('pty:activity', paneId) as Promise<PaneActivity | null>,
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
  search: {
    run: (req) => ipcRenderer.invoke('search:run', req) as Promise<SearchOutcome>,
  },
  fs: {
    list: (path) => ipcRenderer.invoke('fs:list', path) as Promise<FsEntry[]>,
    read: (path) => ipcRenderer.invoke('fs:read', path) as Promise<FsTextResult>,
    stat: (path) => ipcRenderer.invoke('fs:stat', path) as Promise<FsKind | null>,
    write: (path, content) => ipcRenderer.invoke('fs:write', path, content) as Promise<boolean>,
    version: (path) => ipcRenderer.invoke('fs:version', path) as Promise<string | null>,
    readBinary: (path) => ipcRenderer.invoke('fs:read-binary', path) as Promise<FsBinaryResult>,
    watch: (path) => ipcRenderer.invoke('fs:watch', path) as Promise<boolean>,
    unwatch: (path) => ipcRenderer.send('fs:unwatch', path),
    onChanged: (cb) => {
      const handler = (_e: unknown, change: { path: string; exists: boolean }): void => cb(change)
      ipcRenderer.on('fs:changed', handler)
      return () => ipcRenderer.removeListener('fs:changed', handler)
    },
  },
  remoteFiles: {
    folders: () => ipcRenderer.invoke('remote-files:folders') as Promise<RemoteFolder[]>,
    onFolders: (cb) => {
      const handler = (_e: unknown, folders: RemoteFolder[]): void => cb(folders)
      ipcRenderer.on('remote-files:folders-changed', handler)
      return () => ipcRenderer.removeListener('remote-files:folders-changed', handler)
    },
    close: (folderId) => ipcRenderer.invoke('remote-files:close', folderId) as Promise<boolean>,
    onConfirm: (cb) => {
      const handler = (_e: unknown, requestId: number, ask: RemoteFolderAsk): void => {
        void cb(ask).then((approved) =>
          ipcRenderer.send('remote-files:confirm-answer', requestId, approved),
        )
      }
      ipcRenderer.on('remote-files:confirm', handler)
      return () => ipcRenderer.removeListener('remote-files:confirm', handler)
    },
    list: (path) => ipcRenderer.invoke('remote-files:list', path) as Promise<RemoteListResult>,
    stat: (path) => ipcRenderer.invoke('remote-files:stat', path) as Promise<RemoteStatResult>,
    read: (path) => ipcRenderer.invoke('remote-files:read', path) as Promise<RemoteReadResult>,
    write: (path, content, baseVersion) =>
      ipcRenderer.invoke(
        'remote-files:write',
        path,
        content,
        baseVersion,
      ) as Promise<RemoteWriteResult>,
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
    fetch: (serverKey) => ipcRenderer.invoke('lsp:fetch', serverKey) as Promise<void>,
    removeDownload: (serverKey) =>
      ipcRenderer.invoke('lsp:remove-download', serverKey) as Promise<void>,
    setOverride: (serverKey, override) =>
      ipcRenderer.invoke(
        'extensions:set-language-server-program',
        serverKey,
        override,
      ) as Promise<LanguageServerOverrideResult>,
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
    resolve: (conflictId) => ipcRenderer.invoke('sync:resolve', conflictId) as Promise<SyncStatus>,
    install: (extId) => ipcRenderer.invoke('sync:install', extId) as Promise<SyncStatus>,
    secrets: {
      reveal: (conflictId) => ipcRenderer.invoke('sync:secrets-reveal', conflictId),
      enable: () => ipcRenderer.invoke('sync:secrets-enable'),
      disable: () => ipcRenderer.invoke('sync:secrets-disable'),
      remove: () => ipcRenderer.invoke('sync:secrets-remove'),
      setLogins: (on) => ipcRenderer.invoke('sync:secrets-logins', on ? 'on' : 'off'),
      setup: (password, confirm) => ipcRenderer.invoke('sync:secrets-setup', password, confirm),
      reset: (password, confirm) => ipcRenderer.invoke('sync:secrets-reset', password, confirm),
      unlock: (password) => ipcRenderer.invoke('sync:secrets-unlock', password),
      changePassword: (password, confirm) =>
        ipcRenderer.invoke('sync:secrets-change-password', password, confirm),
      recover: (recoveryKey, password, confirm) =>
        ipcRenderer.invoke('sync:secrets-recover', recoveryKey, password, confirm),
    },
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
    movePanes: (sourceId, targetId, paneIds) =>
      ipcRenderer.invoke(
        'workspace:move-panes',
        sourceId,
        targetId,
        paneIds,
      ) as Promise<PaneMoveResult>,
    readCmux: (path) => ipcRenderer.invoke('workspace:read-cmux', path) as Promise<CmuxSessionRead>,
  },
  scratch: {
    create: () => ipcRenderer.invoke('scratch:create') as Promise<string | null>,
    files: (workspaceId) => ipcRenderer.invoke('scratch:files', workspaceId) as Promise<number>,
    reveal: (workspaceId) => ipcRenderer.send('scratch:reveal', workspaceId),
  },
  artifacts: {
    list: (workspaceId) =>
      ipcRenderer.invoke('artifacts:list', workspaceId) as Promise<ArtifactListing | null>,
    pad: (workspaceId) =>
      ipcRenderer.invoke('artifacts:pad', workspaceId) as Promise<string | null>,
    reveal: (workspaceId) => ipcRenderer.send('artifacts:reveal', workspaceId),
    onChanged: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, workspaceId: string): void => cb(workspaceId)
      ipcRenderer.on('artifacts:changed', handler)
      return () => ipcRenderer.removeListener('artifacts:changed', handler)
    },
  },
  preview: {
    open: (paneId, path, theme) =>
      ipcRenderer.invoke('preview:open', paneId, path, theme) as Promise<PreviewOpened | null>,
    shown: (id, visible) => ipcRenderer.send('preview:shown', id, visible),
    stop: (id) => ipcRenderer.send('preview:stop', id),
    close: (id) => ipcRenderer.send('preview:close', id),
    onEvent: (cb) => {
      const handler = (_e: Electron.IpcRendererEvent, event: PreviewEvent): void => cb(event)
      ipcRenderer.on('preview:event', handler)
      return () => ipcRenderer.removeListener('preview:event', handler)
    },
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
    openWith: (workspaces) =>
      ipcRenderer.invoke('windows:open-with', workspaces) as Promise<boolean>,
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
    originAgents: (workspaceId) =>
      ipcRenderer.invoke('windows:origin-agents', workspaceId) as Promise<OriginAgents | null>,
    onOriginAgentsChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('windows:origin-agents-changed', handler)
      return () => ipcRenderer.removeListener('windows:origin-agents-changed', handler)
    },
    insertReference: (request) =>
      ipcRenderer.invoke('windows:insert-reference', request) as Promise<boolean>,
    onInsertReference: (cb) => {
      const handler = (_e: unknown, insert: ReferenceInsert): void => cb(insert)
      ipcRenderer.on('windows:reference-insert', handler)
      return () => ipcRenderer.removeListener('windows:reference-insert', handler)
    },
    answerInsertReference: (requestId, inserted) =>
      ipcRenderer.send('windows:reference-inserted', requestId, inserted),
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
  appMenu: {
    set: (spec) => ipcRenderer.send('app-menu:set', spec),
    onRun: (cb) => {
      const listener = (_e: unknown, command: string): void => cb(command)
      ipcRenderer.on('app-menu:run', listener)
      return () => ipcRenderer.removeListener('app-menu:run', listener)
    },
  },
  terminalState: {
    push: (snapshot) => ipcRenderer.send('terminal:state', snapshot),
  },
  browser: {
    claimProfile: (paneId, profile) =>
      ipcRenderer.invoke('browser:claim-profile', paneId, profile) as Promise<BrowserProfile>,
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
    regionCapture: (paneId, req) =>
      ipcRenderer.invoke('browser:region-capture', paneId, req) as Promise<RegionCaptureOutcome>,
    regionSend: (req) => ipcRenderer.invoke('browser:region-send', req) as Promise<PickSendResult>,
    regionCopy: (paneId, captureId) =>
      ipcRenderer.invoke('browser:region-copy', paneId, captureId) as Promise<RegionCopyResult>,
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
  terminalLinks: {
    probe: (paneId, path) =>
      ipcRenderer.invoke('terminal-links:probe', paneId, path) as Promise<FsKind | null>,
    admit: (paneId, written) =>
      ipcRenderer.invoke(
        'terminal-links:admit',
        paneId,
        written,
      ) as Promise<OpenFileVerdict | null>,
    openFolder: (paneId, written) =>
      ipcRenderer.invoke('terminal-links:open-folder', paneId, written) as Promise<OpenPathResult>,
  },
  clipboard: {
    edit: (edit) => ipcRenderer.invoke('clipboard:edit', edit) as Promise<void>,
    hasImage: () => ipcRenderer.invoke('clipboard:has-image') as Promise<boolean>,
    setChords: (chords) => ipcRenderer.send('clipboard:set-chords', chords),
  },
  guestChords: {
    set: (signatures) => ipcRenderer.send('guest-chords:set', signatures),
    onFire: (cb) => {
      const handler = (_e: unknown, fire: GuestChordFire): void => cb(fire)
      ipcRenderer.on('guest-chords:fire', handler)
      return () => ipcRenderer.removeListener('guest-chords:fire', handler)
    },
  },
  openPath: {
    openDefault: (path) =>
      ipcRenderer.invoke('shell:open-default', path) as Promise<OpenPathResult>,
    reveal: (path) => ipcRenderer.invoke('shell:reveal', path) as Promise<OpenPathResult>,
    project: (dir, exact) =>
      ipcRenderer.invoke('workspace:project', dir, exact) as Promise<WorkspaceProject | null>,
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
    release: () => ipcRenderer.invoke('app:release-state') as Promise<ReleaseState>,
    checkRelease: () => ipcRenderer.invoke('app:release-check') as Promise<ReleaseCheckResult>,
    openRelease: () => ipcRenderer.invoke('app:release-open') as Promise<boolean>,
    dismissRelease: () => ipcRenderer.invoke('app:release-dismiss') as Promise<void>,
    onRelease: (cb) => {
      const handler = (_event: unknown, state: ReleaseState): void => cb(state)
      ipcRenderer.on('app:release-available', handler)
      return () => ipcRenderer.removeListener('app:release-available', handler)
    },
    runUpdate: () => ipcRenderer.invoke('app:update-run') as Promise<UpdateRunStart>,
    updateRun: () => ipcRenderer.invoke('app:update-run-state') as Promise<UpdateRunState>,
    onUpdateRun: (cb) => {
      const handler = (_event: unknown, state: UpdateRunState): void => cb(state)
      ipcRenderer.on('app:update-run-state', handler)
      return () => ipcRenderer.removeListener('app:update-run-state', handler)
    },
    replaceInstall: () => ipcRenderer.invoke('app:install-replace') as Promise<ReplaceStart>,
    replaceState: () => ipcRenderer.invoke('app:install-replace-state') as Promise<ReplaceState>,
    onReplace: (cb) => {
      const handler = (_event: unknown, state: ReplaceState): void => cb(state)
      ipcRenderer.on('app:install-replace-state', handler)
      return () => ipcRenderer.removeListener('app:install-replace-state', handler)
    },
    onProgress: (cb) => {
      const handler = (_event: unknown, progress: ReplaceProgress): void => cb(progress)
      ipcRenderer.on('app:update-progress', handler)
      return () => ipcRenderer.removeListener('app:update-progress', handler)
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
    discreteGpu: () => ipcRenderer.invoke('system:discrete-gpu') as Promise<DiscreteGpuInfo | null>,
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
    setPaths: (workspaceId, kind, paths) =>
      ipcRenderer.invoke(
        'sandbox:set-paths',
        workspaceId,
        kind,
        paths,
      ) as Promise<SandboxEditResult>,
    checkPaths: (kind, paths) =>
      ipcRenderer.invoke('sandbox:check-paths', kind, paths) as Promise<SandboxEditError[]>,
    presets: () => ipcRenderer.invoke('sandbox:presets') as Promise<SandboxReadPreset[]>,
    setDomains: (workspaceId, domains) =>
      ipcRenderer.invoke('sandbox:set-domains', workspaceId, domains) as Promise<SandboxEditResult>,
    setDeniedDomains: (workspaceId, domains) =>
      ipcRenderer.invoke(
        'sandbox:set-denied-domains',
        workspaceId,
        domains,
      ) as Promise<SandboxEditResult>,
    setSwitches: (workspaceId, switches) =>
      ipcRenderer.invoke(
        'sandbox:set-switches',
        workspaceId,
        switches,
      ) as Promise<WorkspaceSandbox | null>,
    fixedPolicy: (workspaceId) =>
      ipcRenderer.invoke('sandbox:fixed-policy', workspaceId) as Promise<SandboxFixedPolicy | null>,
    stamp: (workspaceId) =>
      ipcRenderer.invoke('sandbox:stamp', workspaceId) as Promise<string | null>,
    violations: (workspaceId) =>
      ipcRenderer.invoke('sandbox:violations', workspaceId) as Promise<SandboxViolation[]>,
    clearViolations: (workspaceId) =>
      ipcRenderer.invoke('sandbox:clear-violations', workspaceId) as Promise<boolean>,
    setControls: (workspaceId, controls) =>
      ipcRenderer.invoke(
        'sandbox:set-controls',
        workspaceId,
        controls,
      ) as Promise<WorkspaceSandbox | null>,
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
      ) as Promise<SandboxEnableResult>,
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
    removeAlways: (cap) => ipcRenderer.invoke('approvals:remove-always', cap) as Promise<boolean>,
    setReach: (mode) => ipcRenderer.invoke('approvals:set-reach', mode) as Promise<boolean>,
    onChange: (cb) => {
      const handler = (_event: unknown, state: ApprovalState): void => cb(state)
      ipcRenderer.on('approvals:changed', handler)
      return () => ipcRenderer.removeListener('approvals:changed', handler)
    },
    agentGroups: () => ipcRenderer.invoke('reach:agent-groups') as Promise<AgentGroupPlacement[]>,
    onAgentGroupsChanged: (cb) => {
      const handler = (_event: unknown, placements: AgentGroupPlacement[]): void => cb(placements)
      ipcRenderer.on('reach:agent-groups-changed', handler)
      return () => ipcRenderer.removeListener('reach:agent-groups-changed', handler)
    },
  },
  questions: {
    state: () => ipcRenderer.invoke('questions:state') as Promise<QuestionState>,
    answer: (id, reply) => ipcRenderer.invoke('questions:answer', id, reply) as Promise<boolean>,
    dismiss: (id) => ipcRenderer.invoke('questions:dismiss', id) as Promise<boolean>,
    onChange: (cb) => {
      const handler = (_event: unknown, state: QuestionState): void => cb(state)
      ipcRenderer.on('questions:changed', handler)
      return () => ipcRenderer.removeListener('questions:changed', handler)
    },
  },
  selection: {
    send: (req) => ipcRenderer.invoke('selection:send', req) as Promise<SelectionSendResult>,
  },
  fileOps: {
    create: (dir, name, kind) =>
      ipcRenderer.invoke('files:create', dir, name, kind) as Promise<FileOpResult>,
    rename: (path, name) => ipcRenderer.invoke('files:rename', path, name) as Promise<FileOpResult>,
    move: (paths, dir) => ipcRenderer.invoke('files:move', paths, dir) as Promise<FileOpResult>,
    copy: (paths, dir) => ipcRenderer.invoke('files:copy', paths, dir) as Promise<FileOpResult>,
    trash: (paths) => ipcRenderer.invoke('files:trash', paths) as Promise<FileOpResult>,
  },
  marketplace: {
    list: () => ipcRenderer.invoke('marketplace:list') as Promise<MarketplaceState>,
    add: (url) => ipcRenderer.invoke('marketplace:add', url) as Promise<MarketplaceResult>,
    remove: (id, uninstallExtensions) =>
      ipcRenderer.invoke(
        'marketplace:remove',
        id,
        uninstallExtensions,
      ) as Promise<MarketplaceResult>,
    refresh: (id) => ipcRenderer.invoke('marketplace:refresh', id) as Promise<MarketplaceResult>,
    install: (id, extId) =>
      ipcRenderer.invoke('marketplace:install', id, extId) as Promise<MarketplaceResult>,
    installCode: (id, code) =>
      ipcRenderer.invoke('marketplace:install-code', id, code) as Promise<MarketplaceResult>,
    uninstall: (extId) =>
      ipcRenderer.invoke('marketplace:uninstall', extId) as Promise<MarketplaceResult>,
  },
  suggestions: {
    forFile: (paneId, path) =>
      ipcRenderer.invoke(
        'suggestions:for-file',
        paneId,
        path,
      ) as Promise<ExtensionSuggestion | null>,
    dismiss: (extId) => ipcRenderer.invoke('suggestions:dismiss', extId) as Promise<void>,
    install: (extId) =>
      ipcRenderer.invoke('suggestions:install', extId) as Promise<MarketplaceResult>,
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
    onAgentOffer: (cb) => {
      const handler = (_e: unknown, offer: ExtensionAgentOffer): void => cb(offer)
      ipcRenderer.on('extensions:agent-offer', handler)
      return () => ipcRenderer.removeListener('extensions:agent-offer', handler)
    },
    onAgentOfferWithdrawn: (cb) => {
      const handler = (_e: unknown, requestId: string): void => cb(requestId)
      ipcRenderer.on('extensions:agent-offer-withdrawn', handler)
      return () => ipcRenderer.removeListener('extensions:agent-offer-withdrawn', handler)
    },
    answerAgentOffer: (requestId, paneId) =>
      ipcRenderer.send('extensions:agent-offer-result', requestId, paneId),
    onFocusPane: (cb) => {
      const handler = (_e: unknown, paneId: string): void => cb(paneId)
      ipcRenderer.on('extensions:focus-pane', handler)
      return () => ipcRenderer.removeListener('extensions:focus-pane', handler)
    },
  },
  assist: {
    availability: () => ipcRenderer.invoke('assist:availability') as Promise<AssistAvailability>,
    onAvailability: (cb) => {
      const handler = (_e: unknown, availability: AssistAvailability): void => cb(availability)
      ipcRenderer.on('assist:availability', handler)
      return () => ipcRenderer.removeListener('assist:availability', handler)
    },
    request: (point, requestId, input, model) =>
      ipcRenderer.invoke('assist:request', point, requestId, input, model),
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
    models: (extId, provider) => ipcRenderer.invoke('assist:models', extId, provider),
    setModelLoaded: (extId, id, loaded, provider) =>
      ipcRenderer.invoke('assist:set-model-loaded', extId, id, loaded, provider),
    catalog: () => ipcRenderer.invoke('assist:catalog') as Promise<AssistCatalog>,
    onCatalog: (cb) => {
      const handler = (_e: unknown, catalog: AssistCatalog): void => cb(catalog)
      ipcRenderer.on('assist:catalog', handler)
      return () => ipcRenderer.removeListener('assist:catalog', handler)
    },
    setProviderKey: (providerId, value) =>
      ipcRenderer.invoke('assist:set-provider-key', providerId, value),
    wake: () => ipcRenderer.send('assist:wake'),
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
  privacy: {
    kinds: () => ipcRenderer.invoke('privacy:kinds'),
    redact: (texts) => ipcRenderer.invoke('privacy:redact', texts),
    preview: (text) => ipcRenderer.invoke('privacy:preview', text),
  },
  telemetry: {
    state: () => ipcRenderer.invoke('telemetry:state'),
    consented: () => ipcRenderer.invoke('telemetry:consented'),
    categoriesSeen: () => ipcRenderer.invoke('telemetry:categories-seen'),
    resetInstallId: () => ipcRenderer.invoke('telemetry:reset-id'),
    reports: () => ipcRenderer.invoke('telemetry:reports'),
    count: (category, key, id) => ipcRenderer.send('telemetry:count', category, key, id),
  },
  chatTools: {
    read: (req) => ipcRenderer.invoke('chatTools:read', req),
    list: (req) => ipcRenderer.invoke('chatTools:list', req),
    search: (req) => ipcRenderer.invoke('chatTools:search', req),
    preview: (req) => ipcRenderer.invoke('chatTools:preview', req),
    plan: (req) => ipcRenderer.invoke('chatTools:plan', req),
    write: (req) => ipcRenderer.invoke('chatTools:write', req),
    restore: (req) => ipcRenderer.invoke('chatTools:restore', req),
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
    mcpSignIn: (server) => ipcRenderer.invoke('chatTools:mcp-sign-in', server),
    mcpCancelSignIn: (server) => ipcRenderer.send('chatTools:mcp-cancel-sign-in', server),
    mcpSignOut: (server) => ipcRenderer.invoke('chatTools:mcp-sign-out', server),
    mcpTest: (server) => ipcRenderer.invoke('chatTools:mcp-test', server),
    alwaysGrants: () => ipcRenderer.invoke('chatTools:always-grants'),
    grantAlways: (key) => ipcRenderer.invoke('chatTools:grant-always', key),
    removeAlwaysGrant: (key) => ipcRenderer.invoke('chatTools:remove-always-grant', key),
    onAlwaysGrants: (cb) => {
      const handler = (_e: unknown, keys: string[]): void => cb(keys)
      ipcRenderer.on('chatTools:always-grants', handler)
      return () => ipcRenderer.removeListener('chatTools:always-grants', handler)
    },
  },
  externalEditor: {
    open: (req) => ipcRenderer.invoke('editor:open-external', req) as Promise<ExternalEditorResult>,
  },
  gateway: {
    enable: () => ipcRenderer.invoke('gateway:enable') as Promise<GatewayEnableResponse>,
    disable: () => ipcRenderer.invoke('gateway:disable') as Promise<GatewayRemoteStatus>,
    pair: () => ipcRenderer.invoke('gateway:pair') as Promise<GatewayPairResponse>,
    status: () => ipcRenderer.invoke('gateway:status') as Promise<GatewayRemoteStatus>,
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
    bindAddresses: () =>
      ipcRenderer.invoke('gateway:bind-addresses') as Promise<GatewayBindAddress[]>,
    setRoute: (route) =>
      ipcRenderer.invoke('gateway:set-route', route) as Promise<GatewaySetRouteResult>,
    tailnetSignIn: () =>
      ipcRenderer.invoke('gateway:tailnet-sign-in') as Promise<GatewayTailnetActionResult>,
    tailnetSignOut: () =>
      ipcRenderer.invoke('gateway:tailnet-sign-out') as Promise<GatewayTailnetActionResult>,
    onTailnetChanged: (cb) => {
      const handler = (_event: unknown, state: GatewayTailnetState): void => cb(state)
      ipcRenderer.on('gateway:tailnet-changed', handler)
      return () => ipcRenderer.removeListener('gateway:tailnet-changed', handler)
    },
    setDiscoverable: (on) =>
      ipcRenderer.invoke('gateway:set-discoverable', on) as Promise<GatewayActionResult>,
    pairRequests: () =>
      ipcRenderer.invoke('gateway:pair-requests') as Promise<GatewayPairRequest[]>,
    answerPairRequest: (requestId, approve) =>
      ipcRenderer.invoke('gateway:pair-answer', {
        requestId,
        approve,
      }) as Promise<GatewayActionResult>,
    onPairRequestsChanged: (cb) => {
      const handler = (_event: unknown, requests: GatewayPairRequest[]): void => cb(requests)
      ipcRenderer.on('gateway:pair-requests-changed', handler)
      return () => ipcRenderer.removeListener('gateway:pair-requests-changed', handler)
    },
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
  git: {
    watch: (workspaceIds) => ipcRenderer.send('git:watch', workspaceIds),
    onItems: (cb) => {
      const handler = (_e: unknown, items: CoreItems): void => cb(items)
      ipcRenderer.on('git:items', handler)
      return () => ipcRenderer.removeListener('git:items', handler)
    },
    onChanged: (cb) => {
      const handler = (): void => cb()
      ipcRenderer.on('git:changed', handler)
      return () => ipcRenderer.removeListener('git:changed', handler)
    },
    changes: (workspaceId) => ipcRenderer.invoke('git:changes', workspaceId),
    graph: (workspaceId, limit) => ipcRenderer.invoke('git:graph', workspaceId, limit),
    commitFiles: (workspaceId, sha) => ipcRenderer.invoke('git:commit-files', workspaceId, sha),
    blame: (workspaceId, file) => ipcRenderer.invoke('git:blame', workspaceId, file),
    openChange: (workspaceId, path, area) =>
      ipcRenderer.invoke('git:open-change', workspaceId, path, area),
    openCommitFile: (workspaceId, sha, path) =>
      ipcRenderer.invoke('git:open-commit-file', workspaceId, sha, path),
    stage: (workspaceId, req) => ipcRenderer.invoke('git:stage', workspaceId, req),
    unstage: (workspaceId, req) => ipcRenderer.invoke('git:unstage', workspaceId, req),
    commit: (workspaceId, message) => ipcRenderer.invoke('git:commit', workspaceId, message),
    discard: (workspaceId, req) => ipcRenderer.invoke('git:discard', workspaceId, req),
    setScope: (workspaceId, scope) => ipcRenderer.invoke('git:set-scope', workspaceId, scope),
  },
  ports: {
    watch: (workspaceIds) => ipcRenderer.send('ports:watch', workspaceIds),
    onItems: (cb) => {
      const handler = (_e: unknown, items: CoreItems): void => cb(items)
      ipcRenderer.on('ports:items', handler)
      return () => ipcRenderer.removeListener('ports:items', handler)
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
  keymaps: {
    load: (ref) => ipcRenderer.invoke('keymaps:load', ref) as Promise<KeymapLoad>,
  },
  editorLanguages: {
    load: () => ipcRenderer.invoke('editorLanguages:load') as Promise<EditorLanguage[]>,
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

contextBridge.exposeInMainWorld('ostia', bridge)

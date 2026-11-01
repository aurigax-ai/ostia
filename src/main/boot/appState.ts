import type { BrowserWindow } from 'electron'
import type { CommandDescriptor } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { AgentSessions } from '../agent/agentSessions'
import type { ConsoleEntry } from '../browser/browseMethod'
import type { GuestChords } from '../browser/guestChords'
import type { McpHost } from '../chat/mcpHost'
import type { McpOAuth } from '../chat/mcpOAuth'
import type { AgentJournal } from '../diagnostics/agentJournal'
import type { AppLog } from '../diagnostics/appLog'
import type { Diagnostics } from '../diagnostics/diagnostics'
import type { Telemetry } from '../diagnostics/telemetry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { FileServices } from '../files/filesWiring'
import type { GitService } from '../git/service'
import type { LanguageServers } from '../lsp/languageServers'
import type { ManagerService } from '../manager/manager'
import type { ManagerLimiter } from '../manager/managerMethods'
import type { Portal } from '../manager/portal'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { PortsService } from '../ports/service'
import type { ProfileSyncHandle } from '../profileSync/ipc'
import type { PaneHistories } from '../terminal/history/paneHistories'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { PendingSweep } from '../updates/installReplace'
import type { UpdateRunner } from '../updates/updateRun'
import type { ClipboardEdits } from '../windows/clipboardEdits'
import type { GlobalHotkey } from '../windows/globalHotkey'
import type { AppTray } from '../windows/tray'
import type { WindowBroker } from '../windows/windowBroker'
import type { RestoreOutcome } from '../workspaces/savedScrollback'
import type { ViewHost } from '../workspaces/viewHost'

export function createAppState() {
  const windows = new Map<string, BrowserWindow>()
  const commandsByWindow = new Map<string, CommandDescriptor[]>()

  const browserPanes = new Map<string, number>()

  const consoleBuffers = new Map<number, ConsoleEntry[]>()
  const errorBuffers = new Map<number, ConsoleEntry[]>()

  const terminalState = new Map<string, TerminalStateSnapshot>()

  const ptys = new Map<string, PtyEntry>()

  const quit = {
    restartRequested: false,
    stagedUpdate: null as { pending: PendingSweep; sweepFile: string } | null,
    quitApproved: false,
    scrollbackSavedForQuit: false,
    savingScrollbackForQuit: false,
  }

  const services = {
    appLog: null as AppLog | null,
    agentJournal: null as AgentJournal | null,
    diagnostics: null as Diagnostics | null,
    telemetry: null as Telemetry | null,
    restoreOutcome: 'none' as RestoreOutcome,
    marketplaceInstallIds: (): string[] => [],
    processes: null as ProcessRegistry | null,
    updateRunner: null as UpdateRunner | null,
    languageServers: null as LanguageServers | null,
    onSandboxSpawnFailure: null as ((workspaceId: string, errors: string[]) => void) | null,
    extensionHost: null as ExtensionHost | null,
    gitService: null as GitService | null,
    portsService: null as PortsService | null,
    viewHost: null as ViewHost | null,
    mcpHost: null as McpHost | null,
    agentSessions: null as AgentSessions | null,
    mcpOAuth: null as McpOAuth | null,
    broker: null as WindowBroker | null,
    profileSync: null as ProfileSyncHandle | null,
    stopRemote: null as (() => Promise<void>) | null,
    stopAnnouncing: null as (() => void) | null,
    clipboardEdits: null as ClipboardEdits | null,
    guestChords: null as GuestChords | null,
    appTray: null as AppTray | null,
    globalHotkey: null as GlobalHotkey | null,
    releaseChecks: null as { settingsChanged: () => void } | null,
    managerService: null as ManagerService | null,
    managerLimiter: null as ManagerLimiter | null,
    portal: null as Portal | null,
    files: null as FileServices | null,
    histories: null as PaneHistories | null,
    requestQuit: null as (() => void) | null,
    refreshResume: null as ((paneId: string) => Promise<void>) | null,
  }

  const hibernatedPanes = new Set<string>()
  const movingPanes = new Set<string>()
  const recoveryHeld = new Set<string>()
  const closedPanes = new Set<string>()

  return {
    windows,
    commandsByWindow,
    browserPanes,
    consoleBuffers,
    errorBuffers,
    terminalState,
    ptys,
    quit,
    services,
    hibernatedPanes,
    movingPanes,
    recoveryHeld,
    closedPanes,
  }
}

export type AppState = ReturnType<typeof createAppState>

import type {
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { RemoteCwd } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { type BrowserWindow, ipcMain } from 'electron'
import type { LifecycleEvent } from '../../shared/attention/attention'
import type { CommandDescriptor } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { dropWatchesOf, failPaneMail } from '../agents/busStore'
import type { ClaudeAccounts } from '../agents/claudeAccounts/claudeAccounts'
import { forgetCodexSocket } from '../agents/codexSockets'
import { mailers } from '../agents/mailers'
import { forgetMailFlag } from '../agents/mailFlag'
import { approvals } from '../approvals/approvals'
import { dropIdentity } from '../approvals/capabilityStore'
import { questions } from '../approvals/questions'
import type { ArtifactProducers } from '../artifacts/artifactProducers'
import type { PreviewHost } from '../artifacts/htmlPreview'
import type { GuestProfiles } from '../browser/guestProfiles'
import { emitPlatformEvent, emitSessionState } from '../control/events'
import { getByPaneId, registerPane, removePane } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { PaneAttentionEvents } from '../extensions/paneAttentionEvents'
import type { OpenWaits } from '../files/openWaits'
import type { ManagerService } from '../manager/manager'
import type { PaneHistories } from '../terminal/history/paneHistories'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ReapReason } from '../terminal/ptyReaper'
import { isKeptAttentionState } from '../tmux/attentionFile'
import type { KeptShellsWiring } from '../tmux/keptShellsWiring'
import type { UpdateRunner } from '../updates/updateRun'
import { dropRestoredScrollback } from '../workspaces/savedScrollback'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { WorkspaceLifecycle } from '../workspaces/workspaceLifecycle'
import { setWorkspaceWorkDir } from '../workspaces/workspaceRegistry'
import { rememberClosedPane } from './closedPanes'
import type { PaneJournal } from './paneJournal'
import type { PaneTurns } from './paneTurns'
import type { PaneWatch } from './paneWait'
import type { PaneWaking } from './paneWaking'
import type { ProcessRegistry } from './processRegistry'

interface PaneLifecycleIpcDeps {
  windows: Map<string, BrowserWindow>
  emitPaneEvent: <T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]) => void
  previews: PreviewHost
  paneAttentionEvents: PaneAttentionEvents
  artifactProducers: ArtifactProducers
  openWaits: OpenWaits
  services: {
    extensionHost: ExtensionHost | null
    managerService: ManagerService | null
    processes: ProcessRegistry | null
    updateRunner: UpdateRunner | null
    histories: PaneHistories | null
  }
  claudeAccounts: Pick<ClaudeAccounts, 'paneClosed'>
  releaseMovingPane: (paneId: string) => void
  killPty: (paneId: string, reason: ReapReason) => void
  ptys: Map<string, PtyEntry>
  closedPanes: Set<string>
  hibernatedPanes: Set<string>
  browserProfiles: GuestProfiles['browserProfiles']
  terminalState: Map<string, TerminalStateSnapshot>
  paneWaking: PaneWaking
  paneTurns: Pick<PaneTurns, 'drop'>
  paneStartErrors: Map<string, string>
  paneWatch: PaneWatch
  paneJournal: PaneJournal
  scratchFolders: ScratchFolders
  workspaceClosed: WorkspaceLifecycle['workspaceClosed']
  keptShells: KeptShellsWiring['keptShells']
  commandsByWindow: Map<string, CommandDescriptor[]>
  remoteCwdOfPane: (paneId: string) => RemoteCwd | undefined
}

export function registerPaneLifecycleIpc({
  windows,
  emitPaneEvent,
  previews,
  paneAttentionEvents,
  artifactProducers,
  openWaits,
  services,
  releaseMovingPane,
  killPty,
  ptys,
  closedPanes,
  hibernatedPanes,
  browserProfiles,
  terminalState,
  paneWaking,
  paneTurns,
  paneStartErrors,
  paneWatch,
  paneJournal,
  claudeAccounts,
  scratchFolders,
  workspaceClosed,
  keptShells,
  commandsByWindow,
  remoteCwdOfPane,
}: PaneLifecycleIpcDeps) {
  ipcMain.on('lifecycle:event', (e, event: LifecycleEvent) => {
    const windowId = String(e.sender.id)
    const owner = 'paneId' in event ? getByPaneId(event.paneId)?.windowId : undefined
    if (owner && owner !== windowId && windows.has(owner)) return
    if (event.type === 'pane-created') {
      const identity = registerPane({
        windowId,
        workspaceId: event.workspaceId,
        paneId: event.paneId,
      })
      emitPaneEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: event.workspaceId,
      })
    } else if (event.type === 'pane-closed') {
      previews.paneClosed(event.paneId)
      paneAttentionEvents.forget(event.paneId)
      artifactProducers.paneClosed(event.paneId)
      openWaits.paneClosed(event.paneId)
      const identity = getByPaneId(event.paneId)
      if (identity) {
        const name = services.processes?.forPane(event.paneId)?.name
        if (!identity.manager) {
          rememberClosedPane({
            externalId: identity.externalId,
            workspaceId: identity.workspaceId,
            closedAt: Date.now(),
            ...(name ? { name } : {}),
          })
        }
        dropIdentity(identity.externalId)
        approvals()?.forget(identity.externalId)
        questions()?.forget(identity.externalId)
        services.updateRunner?.paneClosed(identity.externalId)
        void claudeAccounts.paneClosed(identity.externalId)
        failPaneMail(identity.externalId)
        dropWatchesOf(identity.externalId)
        mailers.clear(identity.externalId)
        forgetMailFlag(identity.externalId)
        forgetCodexSocket(identity.externalId)
        paneJournal.forget(identity.paneId, identity.externalId)
        emitPaneEvent('pane.closed', {
          paneId: identity.externalId,
          workspaceId: event.workspaceId,
        })
      }
      services.extensionHost?.slots.clearPaneChips(event.paneId)
      releaseMovingPane(event.paneId)
      if (services.managerService?.isManagerPane(event.paneId)) killPty(event.paneId, 'closed')
      if (ptys.has(event.paneId)) closedPanes.add(event.paneId)
      dropRestoredScrollback(event.paneId)
      services.histories?.drop(event.paneId)
      hibernatedPanes.delete(event.paneId)
      browserProfiles.forget(event.paneId)
      removePane(event.paneId)
      terminalState.delete(event.paneId)
      services.processes?.paneClosed(event.paneId)
      paneWaking.end(event.paneId, 'closed')
      paneTurns.drop(event.paneId)
      paneStartErrors.delete(event.paneId)
      paneWatch.emit(event.paneId, { kind: 'closed' })
    } else if (event.type === 'workspace-added') {
      setWorkspaceWorkDir(event.workspaceId, event.workDir, windowId)
      scratchFolders.bind(event.workspaceId, event.workDir, windowId)
      services.extensionHost?.slots.publishWorkspaceChips()
      services.extensionHost?.slots.publishInbox()
      services.extensionHost?.remoteFolders?.ownerChanged(event.workspaceId)
    } else if (event.type === 'workspace-closed') {
      workspaceClosed(event.workspaceId)
    } else if (event.type === 'workspace-activated') {
    } else if (event.type === 'workspace-state') {
      emitSessionState(event.workspaceId, event.state)
    } else if (event.type === 'pane-attention') {
      paneWatch.attention(event.paneId, event.state, event.message)
      paneAttentionEvents.change(event.paneId, event.state)
      if (ptys.get(event.paneId)?.kept) {
        keptShells.saveAttention(
          event.paneId,
          isKeptAttentionState(event.state)
            ? { state: event.state, ...(event.message ? { message: event.message } : {}) }
            : null,
        )
      }
    }
  })

  ipcMain.on('commands:register', (e, descriptors: CommandDescriptor[]) => {
    commandsByWindow.set(String(e.sender.id), descriptors)
  })

  ipcMain.on('terminal:state', (_e, snapshot: TerminalStateSnapshot) => {
    const cur = terminalState.get(snapshot.paneId)
    if (!cur || snapshot.generation >= cur.generation) {
      const changed =
        !cur ||
        cur.cwd !== snapshot.cwd ||
        cur.running !== snapshot.running ||
        cur.blockCount !== snapshot.blockCount ||
        cur.lastExitCode !== snapshot.lastExitCode
      terminalState.set(snapshot.paneId, snapshot)
      if (cur?.running && !snapshot.running) paneWaking.end(snapshot.paneId, 'failed')
      if (changed) {
        paneWatch.emit(snapshot.paneId, { kind: 'state' })
        const identity = getByPaneId(snapshot.paneId)
        if (identity) {
          services.updateRunner?.paneState(
            identity.externalId,
            snapshot.running,
            snapshot.lastExitCode,
          )
          emitTerminalExtensionEvents(
            emitPaneEvent,
            identity.externalId,
            identity.workspaceId,
            cur,
            snapshot,
            remoteCwdOfPane(identity.paneId) !== undefined,
          )
          emitPlatformEvent('pane.state', {
            paneId: identity.externalId,
            generation: snapshot.generation,
            cwd: snapshot.cwd,
            running: snapshot.running,
            blockCount: snapshot.blockCount,
            lastExitCode: snapshot.lastExitCode,
          })
        }
      }
    }
  })
}

function emitTerminalExtensionEvents(
  emitPaneEvent: PaneLifecycleIpcDeps['emitPaneEvent'],
  paneId: string,
  workspaceId: string,
  prev: TerminalStateSnapshot | undefined,
  next: TerminalStateSnapshot,
  remote: boolean,
): void {
  if (next.cwd && prev?.cwd !== next.cwd) {
    emitPaneEvent('cwd.changed', { paneId, workspaceId, cwd: next.cwd })
  }
  if (next.running && !prev?.running) {
    emitPaneEvent('command.started', { paneId, workspaceId, cwd: next.cwd })
  } else if (!next.running && prev?.running) {
    emitPaneEvent('command.finished', {
      paneId,
      workspaceId,
      cwd: next.cwd,
      exitCode: next.lastExitCode,
      ...(remote ? { remote: true } : {}),
    })
  }
}

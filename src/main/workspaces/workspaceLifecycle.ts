import type {
  ExtensionEventPayloads,
  ExtensionEventType,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { Reach } from '../approvals/reach'
import type { ArtifactFolders } from '../artifacts/artifactFolders'
import type { ArtifactHistory } from '../artifacts/artifactHistory'
import type { ArtifactProducers } from '../artifacts/artifactProducers'
import {
  getByPaneId,
  moveToWorkspace,
  rehomeWorkspace,
  workspaceHasManager,
} from '../control/idRegistry'
import type { AppLog } from '../diagnostics/appLog'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { OpenWaits } from '../files/openWaits'
import { createWorkspaceClosed } from '../files/workspaceClosed'
import { registerPaneMoveIpc } from '../panes/paneMove'
import { dropNamesWhere } from '../panes/paneNames'
import type { ProcessRegistry } from '../panes/processRegistry'
import type { DomainRequests } from '../sandbox/domainRequests'
import type { PortForwarder } from '../sandbox/ports/portForwarder'
import type { PortRequests } from '../sandbox/ports/portRequests'
import type { ViolationLog } from '../sandbox/violations'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PackageRequests } from '../sandboxPackages/packageRequests'
import type { SecretService } from '../secrets/secretService'
import type { WorkspaceAgents } from '../secrets/workspaceAgents'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from './scratchFolders'
import { registerWorkspaceMergeIpc } from './workspaceMerge'
import { removeWorkspace, windowForWorkspace } from './workspaceRegistry'

interface WorkspaceLifecycleDeps {
  openWaits: OpenWaits
  reach: Reach
  services: {
    appLog: AppLog | null
    extensionHost: ExtensionHost | null
    processes: ProcessRegistry | null
  }
  artifactHistory: ArtifactHistory
  artifactFolders: ArtifactFolders
  scratchFolders: ScratchFolders
  packageRequests: PackageRequests
  portForwarder: PortForwarder
  portRequests: PortRequests
  domainRequests: DomainRequests
  workspaceSandboxes: WorkspaceSandboxes
  sandboxViolations: ViolationLog
  workspaceAgents: WorkspaceAgents
  secretService: SecretService
  ptys: Map<string, PtyEntry>
  emitPaneEvent: <T extends ExtensionEventType>(type: T, payload: ExtensionEventPayloads[T]) => void
  artifactProducers: ArtifactProducers
}

export type WorkspaceLifecycle = ReturnType<typeof createWorkspaceLifecycle>

export function createWorkspaceLifecycle({
  openWaits,
  reach,
  services,
  artifactHistory,
  artifactFolders,
  scratchFolders,
  packageRequests,
  portForwarder,
  portRequests,
  domainRequests,
  workspaceSandboxes,
  sandboxViolations,
  workspaceAgents,
  secretService,
  ptys,
  emitPaneEvent,
  artifactProducers,
}: WorkspaceLifecycleDeps) {
  const workspaceClosed = createWorkspaceClosed({
    openWaits,
    removeWorkspace,
    forgetReach: (id) => reach.forget(id),
    closeProcesses: (id) => services.processes?.workspaceClosed(id),
    forgetNames: (id) => dropNamesWhere((paneId) => getByPaneId(paneId)?.workspaceId === id),
    clearChips: (id) => {
      services.extensionHost?.slots.clearWorkspaceChips(id)
      services.extensionHost?.slots.clearPanelToolbarsWhere((entry) => entry.workspaceId === id)
      services.extensionHost?.slots.clearInboxWhere((entry) => entry.workspaceId === id)
    },
    closeRemoteFolders: (id) => services.extensionHost?.remoteFolders?.workspaceClosed(id),
    tellExtensions: (id) => services.extensionHost?.events.workspaceClosed(id),
    closeArtifacts: (id) => artifactHistory.close(id, artifactFolders.close(id)),
    removeScratch: (id) => {
      void scratchFolders.remove(id).then((failure) => {
        if (failure)
          services.appLog?.warn('scratch-remove-failed', { folders: 1, codes: failure.code })
      })
    },
    forgetRequests: forgetWorkspaceRequests,
    forgetSandbox: forgetSandboxRuntime,
  })

  function forgetWorkspaceRequests(workspaceId: string): void {
    packageRequests.forget(workspaceId)
    void portForwarder.forget(workspaceId)
    portRequests.forget(workspaceId)
    domainRequests.forget(workspaceId)
  }

  function forgetSandboxRuntime(workspaceId: string): void {
    workspaceSandboxes.forget(workspaceId)
    sandboxViolations.clear(workspaceId)
    workspaceAgents.stop(workspaceId)
    secretService.forget(workspaceId)
  }

  const mergedSandboxes = new Set<string>()

  function releaseMergedSandbox(workspaceId: string, exiting?: PtyEntry): void {
    if (!mergedSandboxes.has(workspaceId)) return
    for (const entry of ptys.values()) {
      if (entry !== exiting && entry.confinedBy === workspaceId) return
    }
    mergedSandboxes.delete(workspaceId)
    forgetSandboxRuntime(workspaceId)
  }

  function movePanesToWorkspace(paneIds: string[], sourceId: string, targetId: string): void {
    for (const paneId of paneIds) openWaits.paneMoved(paneId)
    for (const identity of moveToWorkspace(paneIds, targetId)) {
      emitPaneEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: targetId,
      })
    }
    for (const paneId of paneIds) {
      const entry = ptys.get(paneId)
      if (entry?.workspaceId === sourceId) entry.workspaceId = targetId
    }
  }

  function mergeWorkspace(sourceId: string, targetId: string): void {
    for (const identity of rehomeWorkspace(sourceId, targetId)) {
      emitPaneEvent('pane.created', {
        paneId: identity.externalId,
        workspaceId: targetId,
      })
    }
    for (const entry of ptys.values()) {
      if (entry.workspaceId === sourceId) entry.workspaceId = targetId
    }
    workspaceSandboxes.merge(sourceId, targetId)
    const movedArtifacts = artifactFolders.merge(sourceId, targetId)
    artifactProducers.merge(sourceId, targetId, movedArtifacts)
    artifactHistory.merge(sourceId, targetId, movedArtifacts)
    artifactHistory.close(sourceId, artifactFolders.close(sourceId))
    removeWorkspace(sourceId)
    forgetWorkspaceRequests(sourceId)
    mergedSandboxes.add(sourceId)
    releaseMergedSandbox(sourceId)
  }

  function registerWorkspaceIpc(): void {
    registerWorkspaceMergeIpc({
      ownerWindow: windowForWorkspace,
      hasManager: workspaceHasManager,
      sandboxRefusal: (sourceId, targetId) => workspaceSandboxes.mergeRefusal(sourceId, targetId),
      merge: mergeWorkspace,
    })
    registerPaneMoveIpc({
      ownerWindow: windowForWorkspace,
      paneOf: getByPaneId,
      isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
      isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
      movePanes: movePanesToWorkspace,
    })
  }

  return { workspaceClosed, releaseMergedSandbox, registerWorkspaceIpc }
}

import { ClipboardItem, clipboard } from 'electron'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { registerCmuxSessionIpc } from '../workspaces/cmuxSession'
import { registerScratchIpc } from '../workspaces/scratchFolders'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { registerArtifactIpc } from './artifactFolders'
import type { ArtifactFolders } from './artifactFolders'
import { registerArtifactHistoryIpc } from './artifactHistory'
import type { ArtifactHistory } from './artifactHistory'
import { registerArtifactProducersIpc } from './artifactProducers'
import type { ArtifactProducers } from './artifactProducers'
import { registerPreviewIpc } from './htmlPreview'
import type { PreviewHost } from './htmlPreview'
import { registerPortableIpc } from './portableExport'
import type { PortableExport } from './portableExport'

interface ArtifactStartDeps {
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  artifactHistory: ArtifactHistory
  portableExport: PortableExport
  workspaceSandboxes: WorkspaceSandboxes
}

export function startArtifacts({
  scratchFolders,
  artifactFolders,
  artifactHistory,
  portableExport,
  workspaceSandboxes,
}: ArtifactStartDeps) {
  scratchFolders.sweep()
  artifactFolders.sweep()
  artifactHistory.sweep()
  portableExport.sweep()
  workspaceSandboxes.sweepTmp()
  registerScratchIpc(scratchFolders)
  registerArtifactIpc({
    folders: artifactFolders,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerCmuxSessionIpc()
}

interface ArtifactViewIpcDeps {
  previews: PreviewHost
  portableExport: PortableExport
  artifactHistory: ArtifactHistory
  artifactProducers: ArtifactProducers
}

export function registerArtifactViewIpc({
  previews,
  portableExport,
  artifactHistory,
  artifactProducers,
}: ArtifactViewIpcDeps) {
  registerPreviewIpc(previews, (png) => {
    void clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)]) })])
  })
  registerPortableIpc(portableExport)
  registerArtifactHistoryIpc({
    history: artifactHistory,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
  registerArtifactProducersIpc({
    producers: artifactProducers,
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
  })
}

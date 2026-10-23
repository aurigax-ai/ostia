import { ipcMain } from 'electron'
import type { PreviewOpened } from '../../shared/artifacts/htmlPreview'
import type { AppLog } from '../diagnostics/appLog'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { registerCmuxSessionIpc } from '../workspaces/cmuxSession'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { registerScratchIpc } from '../workspaces/scratchFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import type { ArtifactFolders } from './artifactFolders'
import { registerArtifactIpc } from './artifactFolders'
import type { ArtifactHistory } from './artifactHistory'
import { registerArtifactHistoryIpc } from './artifactHistory'
import type { ArtifactProducers } from './artifactProducers'
import { registerArtifactProducersIpc } from './artifactProducers'
import type { PreviewHost } from './htmlPreview'
import type { PortableExport } from './portableExport'
import { registerPortableIpc } from './portableExport'

interface ArtifactStartDeps {
  services: { appLog: AppLog | null }
  scratchFolders: ScratchFolders
  artifactFolders: ArtifactFolders
  artifactHistory: ArtifactHistory
  portableExport: PortableExport
  workspaceSandboxes: WorkspaceSandboxes
}

export function startArtifacts({
  services,
  scratchFolders,
  artifactFolders,
  artifactHistory,
  portableExport,
  workspaceSandboxes,
}: ArtifactStartDeps) {
  void scratchFolders.sweep().then(({ failed }) => {
    if (failed.length > 0)
      services.appLog?.warn('scratch-remove-failed', {
        folders: failed.length,
        codes: [...new Set(failed.map((f) => f.code))].join(','),
      })
  })
  artifactFolders.sweep()
  artifactHistory.sweep()
  portableExport.sweep()
  workspaceSandboxes.tmp.sweepTmp()
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
  registerPreviewIpc(previews)
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

function registerPreviewIpc(host: PreviewHost): void {
  ipcMain.handle(
    'preview:open',
    (e, paneId: unknown, path: unknown, theme: unknown): PreviewOpened | null =>
      typeof paneId === 'string' && typeof path === 'string'
        ? host.open(String(e.sender.id), paneId, path, theme)
        : null,
  )
  ipcMain.on('preview:shown', (e, id: unknown, visible: unknown) => {
    if (typeof id === 'string') host.shown(String(e.sender.id), id, visible === true)
  })
  ipcMain.on('preview:stop', (e, id: unknown) => {
    if (typeof id === 'string') host.stopByHuman(String(e.sender.id), id)
  })
  ipcMain.on('preview:close', (e, id: unknown) => {
    if (typeof id === 'string') host.close(String(e.sender.id), id)
  })
}

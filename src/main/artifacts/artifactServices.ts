import { homedir } from 'node:os'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { app, type BrowserWindow, clipboard, dialog, session, shell } from 'electron'
import { ARTIFACT_LIST_MAX } from '../../shared/artifacts/artifacts'
import { emitPlatformEvent } from '../control/events'
import { getByPaneId } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { FileServices } from '../files/filesWiring'
import { OpenFileGrants } from '../files/openFileGrants'
import { privateTmpDir } from '../platform/privateTmp'
import { appDataDir } from '../platform/userDirs'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { ScratchFolders } from '../workspaces/scratchFolders'
import { knownWorkspaces, windowForWorkspace } from '../workspaces/workspaceRegistry'
import { ArtifactFolders } from './artifactFolders'
import { ArtifactHistory, previewBuild } from './artifactHistory'
import { ArtifactProducers } from './artifactProducers'
import { loadEsbuild } from './esbuildService'
import { PreviewHost } from './htmlPreview'
import { PortableBuilder } from './portableBuilder'
import { PortableExport } from './portableExport'
import type { PreviewSession } from './previewHostTypes'
import { appProcessUse } from './processUse'

interface ArtifactServicesDeps {
  windows: Map<string, BrowserWindow>
  workspaceSandboxes: () => WorkspaceSandboxes
  services: { files: FileServices | null; extensionHost: ExtensionHost | null }
}

export function createArtifactServices({
  windows,
  workspaceSandboxes,
  services,
}: ArtifactServicesDeps) {
  const scratchFolders = new ScratchFolders(privateTmpDir(`${PRODUCT_NAME}-scratch`))

  const artifactFolders = new ArtifactFolders(
    {
      root: join(appDataDir(), 'artifacts'),
      scratchDirOf: (workspaceId) => scratchFolders.dirOf(workspaceId),
      scratchDirs: () => scratchFolders.dirs(),
    },
    (workspaceId, changes) => {
      const windowId = windowForWorkspace(workspaceId)
      if (windowId) windows.get(windowId)?.webContents.send('artifacts:changed', workspaceId)
      const dir = artifactFolders.dirOf(workspaceId)
      for (const { path, change } of changes.slice(0, ARTIFACT_LIST_MAX)) {
        emitPlatformEvent('artifact.changed', { sessionId: workspaceId, path, change })
        if (dir && change !== 'removed') artifactHistory.changed(workspaceId, join(dir, path))
      }
    },
  )

  function fileRoots(): string[] {
    return [homedir(), app.getPath('userData'), scratchFolders.root, artifactFolders.root]
  }

  const openFileGrants = new OpenFileGrants({
    roots: fileRoots,
    file: join(app.getPath('userData'), 'opened-files.json'),
  })

  function artifactRuntimeDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'artifact-runtime')
      : join(app.getAppPath(), 'out', 'artifact-runtime')
  }

  const portableBuilder = new PortableBuilder({
    load: () => loadEsbuild(app.isPackaged),
    runtimeDir: artifactRuntimeDir,
    version: app.getVersion(),
  })

  const previews: PreviewHost = new PreviewHost({
    sessionOf: (partition) => session.fromPartition(partition) as unknown as PreviewSession,
    confine: (path) => openFileGrants.confine(path),
    servesFolder: (dir) => artifactFolders.holds(dir),
    ownsPane: (windowId, paneId) => getByPaneId(paneId)?.windowId === windowId,
    send: (windowId, event) => windows.get(windowId)?.webContents.send('preview:event', event),
    processes: appProcessUse,
    build: (source, theme) =>
      previewBuild(artifactHistory, (s, t) => portableBuilder.preview(s, t))(source, theme),
  })

  const portableExport = new PortableExport({
    builder: portableBuilder,
    confine: (path) => openFileGrants.confine(path),
    servesFolder: (dir) => artifactFolders.holds(dir),
    ownsWorkspace: (windowId, workspaceId) => windowForWorkspace(workspaceId) === windowId,
    sandboxedFolders: () =>
      knownWorkspaces()
        .filter((workspaceId) => workspaceSandboxes().isEnabled(workspaceId))
        .flatMap((workspaceId) =>
          [workspaceSandboxes().workDir(workspaceId), artifactFolders.dirOf(workspaceId)].filter(
            (folder): folder is string => typeof folder === 'string',
          ),
        ),
    tmpDir: () => privateTmpDir(`${PRODUCT_NAME}-portable`),
    openPath: (path) => shell.openPath(path),
    saveDialog: async (windowId, defaultPath) => {
      const owner = windows.get(windowId)
      const options = { defaultPath, filters: [{ name: 'HTML', extensions: ['html'] }] }
      const picked = owner
        ? await dialog.showSaveDialog(owner, options)
        : await dialog.showSaveDialog(options)
      return picked.canceled || !picked.filePath ? null : picked.filePath
    },
    downloads: () => app.getPath('downloads'),
    writeClipboard: (text) => clipboard.writeText(text),
    version: app.getVersion(),
    publishedTables: (windowId, path) => services.files?.viewers.portable(windowId, path) ?? null,
    awaitTables: async (windowId, path) =>
      (await services.files?.viewers.awaitPortable(windowId, path)) ?? null,
  })

  const artifactHistory: ArtifactHistory = new ArtifactHistory({
    root: artifactFolders.root,
    folderOf: (workspaceId) => artifactFolders.dirOf(workspaceId),
    isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
    kindMatches: (name) => services.extensionHost?.panels.hasViewKind(name) ?? false,
    make: (workspaceId, file) =>
      portableExport.fileFor(file, previews.themeOf(windowForWorkspace(workspaceId))),
  })

  const artifactProducers = new ArtifactProducers({
    file: (workspaceId) => join(artifactHistory.dirOf(workspaceId), 'producers.json'),
    folderOf: (workspaceId) => artifactFolders.dirOf(workspaceId),
  })

  function artifactsChanged(workspaceId: string): void {
    const windowId = windowForWorkspace(workspaceId)
    if (windowId) windows.get(windowId)?.webContents.send('artifacts:changed', workspaceId)
  }

  function isScratchPane(paneId: string): boolean {
    return scratchFolders.isScratch(getByPaneId(paneId)?.workspaceId)
  }

  return {
    scratchFolders,
    artifactFolders,
    fileRoots,
    openFileGrants,
    previews,
    portableExport,
    artifactHistory,
    artifactProducers,
    artifactsChanged,
    isScratchPane,
  }
}

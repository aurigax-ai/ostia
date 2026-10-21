import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { app, type BrowserWindow, ipcMain, shell } from 'electron'
import type { Dict } from '../../shared/app/dict'
import type { FsEntry, FsKind } from '../../shared/files/filesApi'
import { OPEN_FILES_MAX } from '../../shared/files/openFiles'
import { getByPaneId } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PaneOutput } from '../terminal/terminalPathLinks'
import { registerTerminalPathLinkIpc, TerminalPathLinks } from '../terminal/terminalPathLinks'
import { registerProjectRootIpc } from '../workspaces/projectRoot'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { windowForWorkspace } from '../workspaces/workspaceRegistry'
import { FileOps } from './fileOps'
import { registerFileOpsIpc } from './fileOpsIpc'
import { createFileServices, type FileServices } from './filesWiring'
import { FS_BINARY_MAX } from './fsBinary'
import { writeText, writeTextConfined } from './fsText'
import type { OpenFileGrants } from './openFileGrants'
import { registerOpenPathIpc } from './openPath'
import { ripgrepPath } from './ripgrep'
import { registerViewerIpc } from './viewers/viewerIpc'
import { registerSearchIpc } from './workspaceSearch'

interface FsIpcDeps {
  fileRoots: () => string[]
  windows: Map<string, BrowserWindow>
  openFileGrants: OpenFileGrants
  paneOutput: (paneId: string) => Promise<PaneOutput | null>
  workspaceSandboxes: WorkspaceSandboxes
  scratchFolders: ScratchFolders
  services: {
    files: FileServices | null
    extensionHost: ExtensionHost | null
  }
  onSettingsWritten: () => void
  mainStrings: () => Dict
}

export function registerFsIpc({
  fileRoots,
  windows,
  openFileGrants,
  paneOutput,
  workspaceSandboxes,
  scratchFolders,
  services,
  onSettingsWritten,
  mainStrings,
}: FsIpcDeps): void {
  const allowedRoots = fileRoots()
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  registerOpenPathIpc(allowedRoots, () => windows.values())
  registerTerminalPathLinkIpc(
    new TerminalPathLinks({
      grants: openFileGrants,
      home: homedir(),
      hostname: hostname(),
      output: (paneId) => paneOutput(paneId),
      pane: (paneId) => getByPaneId(paneId),
      isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
      isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
      openPath: (path) => shell.openPath(path),
      showInFolder: (path) => shell.showItemInFolder(path),
    }),
  )
  registerProjectRootIpc(allowedRoots)
  registerSearchIpc(ripgrepPath(app.getAppPath(), process.platform, process.arch), allowedRoots)

  const fileOps = new FileOps({ roots: allowedRoots, trash: (path) => shell.trashItem(path) })
  registerFileOpsIpc({
    fileOps,
    windowOfWorkspace: windowForWorkspace,
    sandboxRefusal: (workspaceId, dir) =>
      workspaceSandboxes.isEnabled(workspaceId)
        ? workspaceSandboxes.writeRefusal(workspaceId, dir)
        : null,
  })

  const files = createFileServices({
    windows,
    fileRoots,
    confine: (path) => openFileGrants.confine(path),
    extensions: () => services.extensionHost,
    copyStrings: () => mainStrings().native.viewerCopy,
  })
  services.files = files
  const { sources } = files
  registerViewerIpc({ viewers: files.viewers })

  ipcMain.handle('fs:list', (_e, dir: unknown): Promise<FsEntry[]> | FsEntry[] =>
    typeof dir === 'string' ? sources.of(dir).list(dir) : [],
  )

  ipcMain.handle('fs:stat', (_e, path: unknown): Promise<FsKind | null> | null =>
    typeof path === 'string' ? sources.of(path).kind(path) : null,
  )

  ipcMain.handle('fs:read', (_e, path: unknown) =>
    typeof path === 'string'
      ? sources.of(path).readText(path, FS_BINARY_MAX)
      : { ok: false, error: 'denied' },
  )

  ipcMain.handle('fs:read-binary', (_e, path: unknown) =>
    typeof path === 'string'
      ? sources.of(path).readBinary(path, FS_BINARY_MAX)
      : { ok: false, error: 'denied' },
  )

  ipcMain.handle('files:admit-dropped', (_e, paths: unknown, workspaceId: unknown) => {
    if (!Array.isArray(paths) || paths.length > OPEN_FILES_MAX) return []
    const remember = typeof workspaceId !== 'string' || !scratchFolders.isScratch(workspaceId)
    return paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => openFileGrants.admit(path, { sandboxed: false, remember }))
  })

  ipcMain.handle('fs:watch', (e, path: unknown): boolean =>
    typeof path === 'string' && sources.of(path).watchable
      ? files.watches.watch(String(e.sender.id), path)
      : false,
  )
  ipcMain.on('fs:unwatch', (e, path: unknown) => {
    if (typeof path === 'string') files.watches.unwatch(String(e.sender.id), path)
  })

  ipcMain.handle('fs:version', (_e, path: unknown) =>
    typeof path === 'string' ? sources.of(path).version(path) : null,
  )

  ipcMain.handle(
    'fs:write',
    (e, path: string, content: string): Promise<boolean> =>
      writeTextConfined(
        path,
        (p) => openFileGrants.confine(p),
        async (safe) => {
          const save = () => writeText(safe, content)
          await files.watches.write(String(e.sender.id), safe, content, save)
          if (safe === settingsFile) onSettingsWritten()
        },
      ),
  )
}

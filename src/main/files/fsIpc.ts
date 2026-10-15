import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type BrowserWindow, app, ipcMain, shell } from 'electron'
import { isArchiveName, isArchivePath } from '../../shared/archives/archivePaths'
import { OPEN_FILES_MAX } from '../../shared/files/openFiles'
import type { FsEntry, FsKind } from '../../shared/types'
import { getByPaneId } from '../control/idRegistry'
import { resolveSafe } from '../platform/pathGuard'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import { TerminalPathLinks, registerTerminalPathLinkIpc } from '../terminal/terminalPathLinks'
import type { PaneOutput } from '../terminal/terminalPathLinks'
import { registerProjectRootIpc } from '../workspaces/projectRoot'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import type { Archives } from './archives/archives'
import { FileOps } from './fileOps'
import { FileWatches } from './fileWatch'
import { FS_BINARY_MAX, readBinaryConfined } from './fsBinary'
import { readTextConfined, versionConfined, writeText, writeTextConfined } from './fsText'
import type { OpenFileGrants } from './openFileGrants'
import { registerOpenPathIpc } from './openPath'
import { ripgrepPath } from './ripgrep'
import { registerSearchIpc } from './workspaceSearch'

interface FsIpcDeps {
  fileRoots: () => string[]
  windows: Map<string, BrowserWindow>
  openFileGrants: OpenFileGrants
  paneOutput: (paneId: string) => Promise<PaneOutput | null>
  workspaceSandboxes: WorkspaceSandboxes
  scratchFolders: ScratchFolders
  services: {
    fileWatches: FileWatches | null
  }
  onSettingsWritten: () => void
  viewers: { changed: (owner: string) => void }
  archives: Archives
}

function listDir(dir: string): FsEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .map((d) =>
        d.isFile() && isArchiveName(d.name)
          ? { name: d.name, dir: false, archive: true as const }
          : { name: d.name, dir: d.isDirectory() },
      )
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  } catch {
    return []
  }
}

const FILE_WATCH_DEBOUNCE_MS = 150

export function registerFsIpc({
  fileRoots,
  windows,
  openFileGrants,
  paneOutput,
  workspaceSandboxes,
  scratchFolders,
  services,
  onSettingsWritten,
  viewers,
  archives,
}: FsIpcDeps): void {
  const allowedRoots = fileRoots()
  const settingsFile = join(app.getPath('userData'), 'settings.json')
  registerOpenPathIpc(allowedRoots, () => windows.values())
  registerTerminalPathLinkIpc(
    new TerminalPathLinks({
      grants: openFileGrants,
      home: homedir(),
      output: (paneId) => paneOutput(paneId),
      pane: (paneId) => getByPaneId(paneId),
      isSandboxed: (workspaceId) => workspaceSandboxes.isEnabled(workspaceId),
      isScratch: (workspaceId) => scratchFolders.isScratch(workspaceId),
      openFolder: (path) => shell.openPath(path),
    }),
  )
  registerProjectRootIpc(allowedRoots)
  registerSearchIpc(ripgrepPath(app.getAppPath(), process.platform, process.arch), allowedRoots)

  const fileOps = new FileOps({ roots: allowedRoots, trash: (path) => shell.trashItem(path) })
  ipcMain.handle('files:create', (_e, dir: unknown, name: unknown, kind: unknown) =>
    fileOps.create(dir, name, kind),
  )
  ipcMain.handle('files:rename', (_e, path: unknown, name: unknown) => fileOps.rename(path, name))
  ipcMain.handle('files:move', (_e, paths: unknown, dir: unknown) => fileOps.move(paths, dir))
  ipcMain.handle('files:copy', (_e, paths: unknown, dir: unknown) => fileOps.copy(paths, dir))
  ipcMain.handle('files:trash', (_e, paths: unknown) => fileOps.trash(paths))

  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] | Promise<FsEntry[]> => {
    if (isArchivePath(dir)) return archives.list(dir)
    const safe = resolveSafe(dir, allowedRoots)
    if (safe === null) return []
    return listDir(safe)
  })

  ipcMain.handle('fs:stat', (_e, path: string): FsKind | null | Promise<FsKind | null> => {
    if (isArchivePath(path)) return archives.stat(path)
    const safe = openFileGrants.confine(path)
    if (safe === null) return null
    try {
      const stat = statSync(safe)
      return stat.isFile() ? 'file' : stat.isDirectory() ? 'dir' : null
    } catch {
      return null
    }
  })

  ipcMain.handle('fs:read', (_e, path: unknown) =>
    isArchivePath(path as string)
      ? archives.readText(path as string, FS_BINARY_MAX)
      : readTextConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('fs:read-binary', (_e, path: unknown) =>
    isArchivePath(path as string)
      ? archives.readBinary(path as string, FS_BINARY_MAX)
      : readBinaryConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle('files:admit-dropped', (_e, paths: unknown, workspaceId: unknown) => {
    if (!Array.isArray(paths) || paths.length > OPEN_FILES_MAX) return []
    const remember = typeof workspaceId !== 'string' || !scratchFolders.isScratch(workspaceId)
    return paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => openFileGrants.admit(path, { sandboxed: false, remember }))
  })

  services.fileWatches = new FileWatches({
    confine: (path) => openFileGrants.confine(path),
    debounceMs: FILE_WATCH_DEBOUNCE_MS,
    onChange: ({ path, exists, owners }) => {
      for (const owner of owners) {
        viewers.changed(owner)
        const win = windows.get(owner)
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path, exists })
      }
    },
  })
  ipcMain.handle('fs:watch', (e, path: unknown): boolean =>
    typeof path === 'string' && !isArchivePath(path)
      ? (services.fileWatches?.watch(String(e.sender.id), path) ?? false)
      : false,
  )
  ipcMain.on('fs:unwatch', (e, path: unknown) => {
    if (typeof path === 'string') services.fileWatches?.unwatch(String(e.sender.id), path)
  })

  ipcMain.handle('fs:version', (_e, path: unknown) =>
    isArchivePath(path as string)
      ? archives.version(path as string)
      : versionConfined(path, (candidate) => openFileGrants.confine(candidate)),
  )

  ipcMain.handle(
    'fs:write',
    (e, path: string, content: string): Promise<boolean> =>
      writeTextConfined(
        path,
        (p) => openFileGrants.confine(p),
        async (safe) => {
          const save = () => writeText(safe, content)
          await (services.fileWatches?.write(String(e.sender.id), safe, content, save) ?? save())
          if (safe === settingsFile) onSettingsWritten()
        },
      ),
  )
}

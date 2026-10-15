import { statSync } from 'node:fs'
import { join } from 'node:path'
import { readConfined } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import { ipcMain, session } from 'electron'
import { readRegularFile } from '../../artifacts/previewFiles'
import { getByPaneId } from '../../control/idRegistry'
import type { ExtensionHost } from '../../extensions/extensionHost'
import type { FileWatches } from '../fileWatch'
import { FS_BINARY_MAX } from '../fsBinary'
import type { OpenFileGrants } from '../openFileGrants'
import { ViewerHost, type ViewerRead } from './viewerHost'
import type { ViewerSession } from './viewerSessions'

const EXTENSION_FILE_MAX = 32 * 1024 * 1024

interface ViewerWiringDeps {
  openFileGrants: OpenFileGrants
  services: { extensionHost: ExtensionHost | null; fileWatches: FileWatches | null }
  readLocale: () => string | undefined
}

export function createViewerHost({
  openFileGrants,
  services,
  readLocale,
}: ViewerWiringDeps): ViewerHost {
  return new ViewerHost({
    sessionOf: (partition) => session.fromPartition(partition) as unknown as ViewerSession,
    confine: (path) => openFileGrants.confine(path),
    ownsPane: (windowId, paneId) => getByPaneId(paneId)?.windowId === windowId,
    viewer: (extId, viewType, path) =>
      services.extensionHost?.panels.fileViewerSource(extId, viewType, path) ?? null,
    readDocument: async (path): Promise<ViewerRead> => {
      const read = await readRegularFile(path, FS_BINARY_MAX)
      return read.ok ? { ok: true, body: read.body } : { ok: false, status: read.status }
    },
    statDocument: (path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() ? { size: stat.size, modified: stat.mtimeMs } : null
      } catch {
        return null
      }
    },
    readExtensionFile: (dir, path) => {
      const read = readConfined(dir, join(dir, path), EXTENSION_FILE_MAX)
      return read.ok ? read.data : null
    },
    watch: (owner, path) => {
      services.fileWatches?.watch(owner, path)
    },
    unwatch: (owner, path) => services.fileWatches?.unwatch(owner, path),
    locale: () => readLocale() ?? 'en',
  })
}

export function registerViewerIpc({ viewers }: { viewers: ViewerHost }): void {
  ipcMain.handle('viewers:open', (e, request: unknown) =>
    viewers.open(String(e.sender.id), request as Parameters<ViewerHost['open']>[1]),
  )
  ipcMain.on('viewers:close', (e, paneId: unknown) => {
    if (typeof paneId === 'string') viewers.close(String(e.sender.id), paneId)
  })
  ipcMain.handle('viewers:portable', (e, paneId: unknown) =>
    typeof paneId === 'string' ? viewers.portable(String(e.sender.id), paneId) : null,
  )
}

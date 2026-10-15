import { join } from 'node:path'
import { readConfined } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import { type BrowserWindow, ipcMain, session } from 'electron'
import { appProcessUse } from '../../artifacts/processUse'
import { getByPaneId } from '../../control/idRegistry'
import type { ExtensionHost } from '../../extensions/extensionHost'
import type { FileSources } from '../fileSources'
import type { FileWatches } from '../fileWatch'
import { FS_BINARY_MAX } from '../fsBinary'
import { ViewerHost, type ViewerRead } from './viewerHost'
import type { ViewerSession } from './viewerSessions'
import { ViewerWatch } from './viewerWatch'

const EXTENSION_FILE_MAX = 32 * 1024 * 1024

interface ViewerWiringDeps {
  windows: Map<string, BrowserWindow>
  sources: FileSources
  services: { extensionHost: ExtensionHost | null; fileWatches: FileWatches | null }
  readLocale: () => string | undefined
}

export function createViewerHost({
  windows,
  sources,
  services,
  readLocale,
}: ViewerWiringDeps): ViewerHost {
  return new ViewerHost({
    sessionOf: (partition) => session.fromPartition(partition) as unknown as ViewerSession,
    confine: (path) => sources.of(path).confine(path),
    ownsPane: (windowId, paneId) => getByPaneId(paneId)?.windowId === windowId,
    viewer: (extId, viewType, path) =>
      services.extensionHost?.panels.fileViewerSource(extId, viewType, path) ?? null,
    readDocument: async (path): Promise<ViewerRead> => {
      const read = await sources.of(path).readBinary(path, FS_BINARY_MAX)
      if (read.ok) return { ok: true, body: Buffer.from(read.data) }
      return { ok: false, status: read.error === 'too-large' ? 413 : 410 }
    },
    statDocument: (path) => sources.of(path).describe(path),
    readExtensionFile: (dir, path) => {
      const read = readConfined(dir, join(dir, path), EXTENSION_FILE_MAX)
      return read.ok ? read.data : null
    },
    watch: (owner, path) => {
      services.fileWatches?.watch(owner, path)
    },
    unwatch: (owner, path) => services.fileWatches?.unwatch(owner, path),
    locale: () => readLocale() ?? 'en',
    guests: new ViewerWatch({ processes: appProcessUse }),
    stopped: (windowId, event) => windows.get(windowId)?.webContents.send('viewers:stopped', event),
  })
}

export function registerViewerIpc({ viewers }: { viewers: ViewerHost }): void {
  ipcMain.handle('viewers:open', (e, request: unknown) =>
    viewers.open(String(e.sender.id), request as Parameters<ViewerHost['open']>[1]),
  )
  ipcMain.on('viewers:close', (e, paneId: unknown) => {
    if (typeof paneId === 'string') viewers.close(String(e.sender.id), paneId)
  })
}

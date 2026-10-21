import { join } from 'node:path'
import { readConfined } from '@aurigax-ai/ostia-extension-sdk/manifest/confinedRead'
import {
  type BrowserWindow,
  ClipboardItem,
  clipboard,
  ipcMain,
  session,
  webContents,
} from 'electron'
import { appProcessUse } from '../../artifacts/processUse'
import { getByPaneId } from '../../control/idRegistry'
import type { ExtensionHost } from '../../extensions/extensionHost'
import { clipboardItemData } from '../../windows/clipboardEdits'
import type { FileSources } from '../fileSources'
import type { FileWatches } from '../fileWatch'
import { FS_BINARY_MAX } from '../fsBinary'
import type { ViewerCopyStrings } from './viewerClipboard'
import { ViewerHost, type ViewerRead } from './viewerHost'
import type { ViewerSession } from './viewerSessions'
import { ViewerWatch } from './viewerWatch'

const VIEWER_CHANNELS = {
  selection: 'viewers:selection',
  'open-link': 'viewers:open-link',
  'edit-source': 'viewers:edit-source',
} as const

const EXTENSION_FILE_MAX = 32 * 1024 * 1024

function killGuestProcess(pid: number): void {
  if (pid <= 0 || pid === process.pid) return
  const sharing = webContents.getAllWebContents().filter((c) => c.getOSProcessId() === pid)
  if (sharing.length === 1 && sharing[0].getType() === 'webview') process.kill(pid, 'SIGKILL')
}

interface ViewerWiringDeps {
  windows: Map<string, BrowserWindow>
  sources: FileSources
  watches: FileWatches
  extensions: () => ExtensionHost | null
  readLocale: () => string | undefined
  copyStrings: () => ViewerCopyStrings
  fileLinksAllowed: (paneId: string) => boolean
}

export function createViewerHost({
  windows,
  sources,
  watches,
  extensions,
  readLocale,
  copyStrings,
  fileLinksAllowed,
}: ViewerWiringDeps): ViewerHost {
  return new ViewerHost({
    sessionOf: (partition) => session.fromPartition(partition) as unknown as ViewerSession,
    confine: (path) => sources.of(path).confine(path),
    ownsPane: (windowId, paneId) => getByPaneId(paneId)?.windowId === windowId,
    viewer: (extId, viewType, path) =>
      extensions()?.panels.viewSource(extId, viewType, path) ?? null,
    readDocument: async (path): Promise<ViewerRead> => {
      const read = await sources.of(path).readBinary(path, FS_BINARY_MAX)
      if (read.ok) return { ok: true, body: Buffer.from(read.data) }
      return { ok: false, status: read.error === 'too-large' ? 413 : 410 }
    },
    readRange: async (path, start, end) => sources.of(path).readRange?.(path, start, end) ?? null,
    statDocument: (path) => sources.of(path).describe(path),
    readExtensionFile: (dir, path) => {
      const read = readConfined(dir, join(dir, path), EXTENSION_FILE_MAX)
      return read.ok ? read.data : null
    },
    watch: (owner, path) => {
      watches.watch(owner, path)
    },
    unwatch: (owner, path) => watches.unwatch(owner, path),
    locale: () => readLocale() ?? 'en',
    guests: new ViewerWatch({ processes: appProcessUse, kill: killGuestProcess }),
    stopped: (windowId, event) => windows.get(windowId)?.webContents.send('viewers:stopped', event),
    emit: (windowId, event) => {
      const channel = VIEWER_CHANNELS[event.type]
      windows.get(windowId)?.webContents.send(channel, event.payload)
    },
    writeClipboard: (copied) => clipboard.write([new ClipboardItem(clipboardItemData(copied))]),
    copyStrings,
    fileLinksAllowed,
  })
}

export function registerViewerIpc({ viewers }: { viewers: ViewerHost }): void {
  ipcMain.handle('viewers:open', (e, request: unknown) =>
    viewers.open(String(e.sender.id), request as Parameters<ViewerHost['open']>[1]),
  )
  ipcMain.on('viewers:close', (e, paneId: unknown) => {
    if (typeof paneId === 'string') viewers.close(String(e.sender.id), paneId)
  })
  ipcMain.handle('viewers:copy-selection', (e, paneId: unknown) =>
    viewers.copySelection(String(e.sender.id), paneId),
  )
  ipcMain.on('viewers:clear-selection', (e, paneId: unknown) =>
    viewers.clearSelection(String(e.sender.id), paneId),
  )
  ipcMain.on('viewers:document-text', (e, request: unknown) =>
    viewers.setDocumentText(String(e.sender.id), request),
  )
}

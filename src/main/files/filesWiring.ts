import type { BrowserWindow } from 'electron'
import type { ExtensionHost } from '../extensions/extensionHost'
import { readLocale } from '../platform/settingsFile'
import { ARCHIVE_LIMITS } from './archives/archiveTree'
import { Archives } from './archives/archives'
import { ExtensionReaders } from './archives/extensionReader'
import { FileSources, localSource } from './fileSources'
import { FileWatches } from './fileWatch'
import type { ViewerHost } from './viewers/viewerHost'
import { createViewerHost } from './viewers/viewerIpc'

const FILE_WATCH_DEBOUNCE_MS = 150

export interface FileServices {
  watches: FileWatches
  sources: FileSources
  viewers: ViewerHost
}

interface FileServicesDeps {
  windows: Map<string, BrowserWindow>
  fileRoots: () => string[]
  confine: (path: string) => string | null
  extensions: () => ExtensionHost | null
}

export function createFileServices({
  windows,
  fileRoots,
  confine,
  extensions,
}: FileServicesDeps): FileServices {
  const readers = new ExtensionReaders(() => extensions()?.archives ?? null)
  const archives = new Archives(confine, ARCHIVE_LIMITS, readers)
  const sources = new FileSources(
    localSource(fileRoots, confine, (name) => archives.handlesName(name)),
    [archives],
  )
  const watches = new FileWatches({
    confine,
    debounceMs: FILE_WATCH_DEBOUNCE_MS,
    onChange: ({ path, exists, owners }) => {
      for (const owner of owners) {
        viewers.changed(owner)
        const win = windows.get(owner)
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path, exists })
      }
    },
  })
  const viewers = createViewerHost({ windows, sources, watches, extensions, readLocale })
  return { watches, sources, viewers }
}

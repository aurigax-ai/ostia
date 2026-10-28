import type { BrowserWindow } from 'electron'
import type { ExtensionHost } from '../extensions/extensionHost'
import { readLocale } from '../platform/settingsFile'
import { Archives } from './archives/archives'
import type { BrowseProviders } from './archives/browseProviders'
import { FileSources, localSource } from './fileSources'
import { FileWatches } from './fileWatch'
import type { ViewerCopyStrings } from './viewers/viewerClipboard'
import type { ViewerHost } from './viewers/viewerHost'
import { createViewerHost } from './viewers/viewerIpc'

const FILE_WATCH_DEBOUNCE_MS = 150

export interface FileServices {
  watches: FileWatches
  sources: FileSources
  viewers: ViewerHost
  kindsChanged: () => void
}

interface FileServicesDeps {
  windows: Map<string, BrowserWindow>
  fileRoots: () => string[]
  confine: (path: string) => string | null
  extensions: () => ExtensionHost | null
  copyStrings: () => ViewerCopyStrings
  fileLinksAllowed: (paneId: string) => boolean
}

export function createFileServices({
  windows,
  fileRoots,
  confine,
  extensions,
  copyStrings,
  fileLinksAllowed,
}: FileServicesDeps): FileServices {
  const noProvider = { ok: false as const, error: 'no-provider' }
  const providers: BrowseProviders = {
    kindFor: (name) => extensions()?.browse.kindFor(name) ?? null,
    browsable: () => extensions()?.browse.browsable() ?? (() => false),
    list: async (...args) => extensions()?.browse.list(...args) ?? noProvider,
    read: async (...args) =>
      extensions()?.browse.read(...args) ?? { ok: false, problem: 'unreadable' },
  }
  const archives = new Archives(confine, providers)
  const sources = new FileSources(
    localSource(fileRoots, confine, () => providers.browsable()),
    [archives],
  )
  const watches = new FileWatches({
    confine,
    debounceMs: FILE_WATCH_DEBOUNCE_MS,
    onChange: ({ path, exists, owners }) => {
      for (const owner of owners) {
        void viewers.changed(owner)
        const win = windows.get(owner)
        if (win && !win.isDestroyed()) win.webContents.send('fs:changed', { path, exists })
      }
    },
  })
  const viewers = createViewerHost({
    windows,
    sources,
    watches,
    extensions,
    readLocale,
    copyStrings,
    fileLinksAllowed,
  })
  const kindsChanged = (): void => {
    archives.dropCache()
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('files:kinds-changed')
    }
  }
  return { watches, sources, viewers, kindsChanged }
}

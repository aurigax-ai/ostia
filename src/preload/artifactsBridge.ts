import { ipcRenderer } from 'electron'
import type { ArtifactListing } from '../shared/artifacts/artifacts'
import type {
  ArtifactRestore,
  ArtifactVersion,
  ArtifactVersionContent,
} from '../shared/artifacts/artifacts'
import type { PreviewOpened } from '../shared/artifacts/htmlPreview'
import type { PortableResult } from '../shared/artifacts/portable'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const artifactsBridge: Pick<OstiaBridge, 'artifacts' | 'preview'> = {
  artifacts: {
    list: (workspaceId) =>
      ipcRenderer.invoke('artifacts:list', workspaceId) as Promise<ArtifactListing | null>,
    pad: (workspaceId) =>
      ipcRenderer.invoke('artifacts:pad', workspaceId) as Promise<string | null>,
    reveal: (workspaceId) => ipcRenderer.send('artifacts:reveal', workspaceId),
    portable: (action, request) => {
      const channel =
        action === 'open'
          ? 'artifacts:portable-open'
          : action === 'save'
            ? 'artifacts:portable-save'
            : 'artifacts:portable-copy'
      return ipcRenderer.invoke(channel, request) as Promise<PortableResult>
    },
    versions: (workspaceId, path) =>
      ipcRenderer.invoke('artifacts:versions', workspaceId, path) as Promise<
        ArtifactVersion[] | null
      >,
    version: (workspaceId, path, id) =>
      ipcRenderer.invoke(
        'artifacts:version',
        workspaceId,
        path,
        id,
      ) as Promise<ArtifactVersionContent | null>,
    restore: (workspaceId, path, id) =>
      ipcRenderer.invoke(
        'artifacts:restore',
        workspaceId,
        path,
        id,
      ) as Promise<ArtifactRestore | null>,
    producers: (workspaceId) =>
      ipcRenderer.invoke('artifacts:producers', workspaceId) as Promise<Record<
        string,
        string
      > | null>,
    onChanged: (cb) => listen('artifacts:changed', cb),
  },
  preview: {
    open: (paneId, path, theme) =>
      ipcRenderer.invoke('preview:open', paneId, path, theme) as Promise<PreviewOpened | null>,
    shown: (id, visible) => ipcRenderer.send('preview:shown', id, visible),
    stop: (id) => ipcRenderer.send('preview:stop', id),
    close: (id) => ipcRenderer.send('preview:close', id),
    capture: (id, rect) =>
      ipcRenderer.invoke('preview:capture', id, rect) as Promise<{
        image: Uint8Array
        region: { x: number; y: number; width: number; height: number }
      } | null>,
    copyRegion: (id, rect) =>
      ipcRenderer.invoke('preview:copy-region', id, rect) as Promise<boolean>,
    onEvent: (cb) => listen('preview:event', cb),
  },
}

import { type NativeImage, ipcMain, nativeImage } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import type { FileOpResult } from '../../shared/files/fileOps'
import type { FileOps } from './fileOps'

const DRAG_ICON_SIZE = 32

export interface FileDropsDeps {
  fileOps: Pick<FileOps, 'importInto' | 'draggable'>
  windowOfWorkspace: (workspaceId: string) => string | undefined
  sandboxRefusal: (workspaceId: string, dir: string) => string | null
}

export async function importDropped(
  deps: FileDropsDeps,
  senderId: string,
  request: { paths: unknown; dir: unknown; workspaceId: unknown; move: unknown },
): Promise<FileOpResult> {
  const { paths, dir, workspaceId, move } = request
  if (typeof workspaceId !== 'string' || typeof dir !== 'string') {
    return { ok: false, error: 'outside' }
  }
  if (deps.windowOfWorkspace(workspaceId) !== senderId) return { ok: false, error: 'outside' }
  if (deps.sandboxRefusal(workspaceId, dir) !== null) return { ok: false, error: 'sandboxed' }
  return deps.fileOps.importInto(paths, dir, move === true)
}

export function registerFileDropIpc(deps: FileDropsDeps): void {
  let icon: NativeImage | null = null
  const dragIcon = (): NativeImage => {
    icon ??= nativeImage.createFromPath(appIcon).resize({ width: DRAG_ICON_SIZE })
    return icon
  }
  ipcMain.handle(
    'files:import',
    (e, paths: unknown, dir: unknown, workspaceId: unknown, move: unknown) =>
      importDropped(deps, String(e.sender.id), { paths, dir, workspaceId, move }),
  )
  ipcMain.on('files:start-drag', (e, path: unknown) => {
    void deps.fileOps.draggable(path).then((file) => {
      if (file !== null && !e.sender.isDestroyed()) e.sender.startDrag({ file, icon: dragIcon() })
    })
  })
}

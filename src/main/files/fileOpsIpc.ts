import { ipcMain, type NativeImage, nativeImage } from 'electron'
import appIcon from '../../../resources/icon.png?asset'
import { type FileGuardDeps, guardFileOps } from './fileGuard'

const DRAG_ICON_SIZE = 32

export function registerFileOpsIpc(deps: FileGuardDeps): void {
  const ops = guardFileOps(deps)
  let icon: NativeImage | null = null
  const dragIcon = (): NativeImage => {
    icon ??= nativeImage.createFromPath(appIcon).resize({ width: DRAG_ICON_SIZE })
    return icon
  }
  const sender = (e: { sender: { id: number } }): string => String(e.sender.id)
  ipcMain.handle(
    'files:create',
    (e, workspaceId: unknown, dir: unknown, name: unknown, kind: unknown) =>
      ops.create(sender(e), workspaceId, dir, name, kind),
  )
  ipcMain.handle('files:rename', (e, workspaceId: unknown, path: unknown, name: unknown) =>
    ops.rename(sender(e), workspaceId, path, name),
  )
  ipcMain.handle('files:move', (e, workspaceId: unknown, paths: unknown, dir: unknown) =>
    ops.move(sender(e), workspaceId, paths, dir),
  )
  ipcMain.handle('files:copy', (e, workspaceId: unknown, paths: unknown, dir: unknown) =>
    ops.copy(sender(e), workspaceId, paths, dir),
  )
  ipcMain.handle('files:trash', (e, workspaceId: unknown, paths: unknown) =>
    ops.trash(sender(e), workspaceId, paths),
  )
  ipcMain.handle(
    'files:import',
    (e, paths: unknown, dir: unknown, workspaceId: unknown, move: unknown) =>
      ops.importInto(sender(e), workspaceId, paths, dir, move),
  )
  ipcMain.on('files:start-drag', (e, workspaceId: unknown, path: unknown) => {
    void ops.draggable(sender(e), workspaceId, path).then((file) => {
      if (file !== null && !e.sender.isDestroyed()) e.sender.startDrag({ file, icon: dragIcon() })
    })
  })
}

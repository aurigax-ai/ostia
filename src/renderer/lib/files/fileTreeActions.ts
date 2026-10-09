import { currentDict, fmt } from '@/i18n/useDict'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { FileOpError, FileOpResult, NewEntryKind } from '@shared/files/fileOps'
import { openFileInWorkspace, reportFileProblem } from './openFile'

export type TreeEditError = FileOpError | 'unsaved'

export function parentOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : '/'
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function unsavedUnder(paths: string[]): string | null {
  const { dirty } = useEditorStatus.getState()
  for (const file of Object.keys(dirty)) {
    if (!dirty[file]) continue
    if (paths.some((path) => file === path || file.startsWith(`${path}/`))) return file
  }
  return null
}

function report(workspaceId: string, error: TreeEditError, path?: string): void {
  const d = currentDict()
  reportFileProblem(
    workspaceId,
    error === 'unsaved' && path
      ? fmt(d.filesView.ops.unsaved, { name: nameOf(path) })
      : d.filesView.ops.errors[error === 'unsaved' ? 'failed' : error],
  )
}

function followMoves(sources: string[], res: FileOpResult): void {
  const layout = useLayoutStore.getState()
  sources.forEach((source, i) => {
    const target = res.paths?.[i]
    if (target && target !== source) layout.followMovedFile(source, target)
  })
}

export async function createEntry(
  dir: string,
  name: string,
  kind: NewEntryKind,
): Promise<TreeEditError | null> {
  const res = await window.ostia.fileOps.create(dir, name, kind)
  if (!res.ok) return res.error
  useFileTreeStore.getState().reload([dir])
  const [created] = res.paths
  if (kind === 'file' && created) openFileInWorkspace(created)
  return null
}

export async function renameEntry(path: string, name: string): Promise<TreeEditError | null> {
  if (unsavedUnder([path])) return 'unsaved'
  const res = await window.ostia.fileOps.rename(path, name)
  if (!res.ok) return res.error
  useFileTreeStore.getState().reload([parentOf(path)])
  followMoves([path], res)
  return null
}

export async function moveInto(workspaceId: string, paths: string[], dir: string): Promise<void> {
  const unsaved = unsavedUnder(paths)
  if (unsaved) {
    report(workspaceId, 'unsaved', unsaved)
    return
  }
  const res = await window.ostia.fileOps.move(paths, dir)
  useFileTreeStore.getState().reload([dir, ...paths.map(parentOf)])
  followMoves(paths, res)
  if (!res.ok) report(workspaceId, res.error)
}

export async function copyInto(workspaceId: string, paths: string[], dir: string): Promise<void> {
  const res = await window.ostia.fileOps.copy(paths, dir)
  useFileTreeStore.getState().reload([dir])
  if (!res.ok) report(workspaceId, res.error)
}

export async function pasteInto(workspaceId: string, dir: string): Promise<void> {
  const { clipboard, setClipboard } = useFileTreeStore.getState()
  if (!clipboard) return
  if (clipboard.mode === 'copy') {
    await copyInto(workspaceId, clipboard.paths, dir)
    return
  }
  setClipboard(null)
  await moveInto(workspaceId, clipboard.paths, dir)
}

export async function trashEntries(workspaceId: string, paths: string[]): Promise<void> {
  const unsaved = unsavedUnder(paths)
  if (unsaved) {
    report(workspaceId, 'unsaved', unsaved)
    return
  }
  const res = await window.ostia.fileOps.trash(paths)
  useFileTreeStore.getState().reload(paths.map(parentOf))
  if (!res.ok) report(workspaceId, res.error)
}

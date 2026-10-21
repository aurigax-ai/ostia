import { type DragEvent, type HTMLAttributes, type KeyboardEvent, useState } from 'react'
import { parentOf } from '@/lib/files/fileTree'
import { copyInto, importInto, moveInto } from '@/lib/files/fileTreeActions'
import { isMac } from '@/platform'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import type { TreeVisibility } from './FileMenu'
import type { TreeContext } from './fileTreeContext'

export function visibilityOf(tree: TreeContext, fullPath: string): TreeVisibility | undefined {
  const literal = tree.settings.exclude.includes(fullPath)
  if (!literal && tree.isExcluded(fullPath, tree.root)) return undefined
  return { hidden: literal, toggle: () => tree.setExcluded(fullPath, !literal) }
}

export function isTwisty(target: EventTarget): boolean {
  return target instanceof Element && target.closest('.file-twisty') !== null
}

export function expandKey(
  e: KeyboardEvent<HTMLButtonElement>,
  setOpen: (open: boolean) => void,
): void {
  if (e.key === 'ArrowRight') setOpen(true)
  else if (e.key === 'ArrowLeft') setOpen(false)
  else return
  e.preventDefault()
}

export function rowClass(active: boolean, excluded: boolean, cut = false): string {
  return `file-row${active ? ' active' : ''}${excluded ? ' excluded' : ''}${cut ? ' cut' : ''}`
}

export function useRowEdit(fullPath: string): { renaming: boolean; cut: boolean } {
  const renaming = useFileTreeStore((s) => s.edit?.kind === 'rename' && s.edit.path === fullPath)
  const cut = useFileTreeStore(
    (s) => s.clipboard?.mode === 'cut' && s.clipboard.paths.includes(fullPath),
  )
  return { renaming, cut }
}

export function startPathDrag(
  e: DragEvent<HTMLElement>,
  fullPath: string,
  tree: TreeContext,
): void {
  e.preventDefault()
  const { workspaceId } = tree.focus
  if (!tree.remote && workspaceId) window.ostia.fileOps.startDrag(workspaceId, fullPath)
}

type DropModifiers = Pick<DragEvent<HTMLElement>, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>

function isCopyDrop(e: DropModifiers): boolean {
  return isMac ? e.altKey : e.ctrlKey
}

export function importMoves(e: DropModifiers, mac: boolean): boolean {
  return mac ? e.metaKey : e.shiftKey
}

function insideRoot(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function dropInto(e: DragEvent<HTMLElement>, workspaceId: string, dir: string, root: string): void {
  const files = [...e.dataTransfer.files]
  const paths = files.map((file) => window.ostia.files.pathForFile(file))
  if (paths.length > 0 && paths.every((path) => path && insideRoot(root, path))) {
    if (isCopyDrop(e)) void copyInto(workspaceId, paths, dir)
    else {
      const moving = paths.filter((path) => parentOf(path) !== dir)
      if (moving.length > 0) void moveInto(workspaceId, moving, dir)
    }
    return
  }
  void importInto(workspaceId, files, dir, importMoves(e, isMac))
}

const MOVE_ALLOWED = new Set(['all', 'move', 'copyMove', 'linkMove', 'uninitialized'])

function dropEffectFor(e: DragEvent<HTMLElement>): 'copy' | 'move' {
  return importMoves(e, isMac) && MOVE_ALLOWED.has(e.dataTransfer.effectAllowed) ? 'move' : 'copy'
}

function isFileDrag(e: DragEvent<HTMLElement>): boolean {
  return e.dataTransfer.types.includes('Files')
}

const refusedDrop: Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDrop'> = {
  onDragOver: (e) => {
    if (e.defaultPrevented || !isFileDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'none'
  },
  onDrop: (e) => {
    if (isFileDrag(e)) e.preventDefault()
  },
}

export function useFolderDrop(
  dir: string,
  tree: TreeContext,
): Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> & { over: boolean } {
  const [over, setOver] = useState(false)
  const workspaceId = tree.focus.workspaceId
  if (tree.remote) return { over: false, ...refusedDrop }
  if (!workspaceId) return { over: false }
  return {
    over,
    onDragOver: (e) => {
      if (e.defaultPrevented || !isFileDrag(e)) {
        if (over) setOver(false)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = dropEffectFor(e)
      if (!over) setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false)
      if (e.defaultPrevented || !isFileDrag(e)) return
      e.preventDefault()
      dropInto(e, workspaceId, dir, tree.root)
    },
  }
}

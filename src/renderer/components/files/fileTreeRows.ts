import { copyInto, moveInto, parentOf } from '@/lib/files/fileTreeActions'
import { OSTIA_PATH_MIME } from '@/lib/keyboard/dropPaths'
import { isMac } from '@/platform'
import { useFileTreeStore } from '@/stores/files/fileTreeStore'
import { type DragEvent, type HTMLAttributes, type KeyboardEvent, useState } from 'react'
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
  if (tree.remote) {
    e.preventDefault()
    return
  }
  e.dataTransfer.setData(OSTIA_PATH_MIME, fullPath)
  e.dataTransfer.setData('text/plain', fullPath)
  e.dataTransfer.effectAllowed = 'copyMove'
}

function isCopyDrop(e: DragEvent<HTMLElement>): boolean {
  return isMac ? e.altKey : e.ctrlKey
}

export function useFolderDrop(
  dir: string,
  tree: TreeContext,
): Pick<HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> & { over: boolean } {
  const [over, setOver] = useState(false)
  const workspaceId = tree.focus.workspaceId
  if (tree.remote || !workspaceId) return { over: false }
  return {
    over,
    onDragOver: (e) => {
      if (!e.dataTransfer.types.includes(OSTIA_PATH_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = isCopyDrop(e) ? 'copy' : 'move'
      setOver(true)
    },
    onDragLeave: () => setOver(false),
    onDrop: (e) => {
      setOver(false)
      const source = e.dataTransfer.getData(OSTIA_PATH_MIME)
      if (!source) return
      e.preventDefault()
      e.stopPropagation()
      if (isCopyDrop(e)) void copyInto(workspaceId, [source], dir)
      else if (parentOf(source) !== dir) void moveInto(workspaceId, [source], dir)
    },
  }
}

import { MenuItem } from '@/components/common/Menu'
import { WarningNote } from '@/components/settings/SettingsPanel'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ContextMenuSeparator } from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/i18n/useDict'
import {
  type TreeEditError,
  copyInto,
  createEntry,
  parentOf,
  pasteInto,
  renameEntry,
  trashEntries,
} from '@/lib/files/fileTreeActions'
import { isMac } from '@/platform'
import { type TreeEdit, useFileTreeStore } from '@/stores/files/fileTreeStore'
import {
  CaretRightIcon,
  ClipboardIcon,
  CopyIcon,
  CopySimpleIcon,
  FilePlusIcon,
  FolderPlusIcon,
  PencilSimpleIcon,
  ScissorsIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import { type KeyboardEvent, useState } from 'react'

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function FileOpsMenuItems({
  workspaceId,
  path,
  dir,
}: {
  workspaceId: string
  path: string
  dir: boolean
}): JSX.Element {
  const d = useDict()
  const ops = d.filesView.ops
  const setEdit = useFileTreeStore((s) => s.setEdit)
  const setClipboard = useFileTreeStore((s) => s.setClipboard)
  const askTrash = useFileTreeStore((s) => s.askTrash)
  const canPaste = useFileTreeStore((s) => s.clipboard !== null)
  const target = dir ? path : parentOf(path)
  return (
    <>
      <MenuItem
        icon={FilePlusIcon}
        onClick={() => setEdit({ kind: 'create', entry: 'file', dir: target })}
      >
        {ops.newFile}
      </MenuItem>
      <MenuItem
        icon={FolderPlusIcon}
        onClick={() => setEdit({ kind: 'create', entry: 'folder', dir: target })}
      >
        {ops.newFolder}
      </MenuItem>
      <ContextMenuSeparator />
      <MenuItem icon={ScissorsIcon} onClick={() => setClipboard({ mode: 'cut', paths: [path] })}>
        {ops.cut}
      </MenuItem>
      <MenuItem icon={CopyIcon} onClick={() => setClipboard({ mode: 'copy', paths: [path] })}>
        {ops.copy}
      </MenuItem>
      <MenuItem
        icon={ClipboardIcon}
        disabled={!canPaste}
        onClick={() => void pasteInto(workspaceId, target)}
      >
        {ops.paste}
      </MenuItem>
      <MenuItem
        icon={CopySimpleIcon}
        onClick={() => void copyInto(workspaceId, [path], parentOf(path))}
      >
        {ops.duplicate}
      </MenuItem>
      <ContextMenuSeparator />
      <MenuItem icon={PencilSimpleIcon} onClick={() => setEdit({ kind: 'rename', path })}>
        {ops.rename}
      </MenuItem>
      <MenuItem icon={TrashIcon} onClick={() => askTrash([path])}>
        {ops.trash}
      </MenuItem>
      <ContextMenuSeparator />
    </>
  )
}

export function treeRowKey(
  e: KeyboardEvent<HTMLElement>,
  workspaceId: string | null,
  path: string,
  dir: boolean,
): boolean {
  const store = useFileTreeStore.getState()
  const mod = isMac ? e.metaKey : e.ctrlKey
  const plain = !e.altKey && !e.shiftKey && !(isMac ? e.ctrlKey : e.metaKey)
  const key = e.key.toLowerCase()
  if (e.key === 'F2' && !mod) store.setEdit({ kind: 'rename', path })
  else if (e.key === 'Delete' || (isMac && mod && e.key === 'Backspace')) store.askTrash([path])
  else if (mod && plain && key === 'c') store.setClipboard({ mode: 'copy', paths: [path] })
  else if (mod && plain && key === 'x') store.setClipboard({ mode: 'cut', paths: [path] })
  else if (mod && plain && key === 'v' && workspaceId) {
    void pasteInto(workspaceId, dir ? path : parentOf(path))
  } else return false
  e.preventDefault()
  e.stopPropagation()
  return true
}

function labelFor(edit: TreeEdit, d: ReturnType<typeof useDict>): string {
  const ops = d.filesView.ops
  if (edit.kind === 'rename') return fmt(ops.renameTo, { name: nameOf(edit.path) })
  return edit.entry === 'file' ? ops.newFileName : ops.newFolderName
}

const NAME_OFFSET = 38

export function NameInputRow({
  edit,
  depth,
  dir,
  icon,
}: {
  edit: TreeEdit
  depth: number
  dir: boolean
  icon: JSX.Element
}): JSX.Element {
  const d = useDict()
  const initial = edit.kind === 'rename' ? nameOf(edit.path) : ''
  const [name, setName] = useState(initial)
  const [problem, setProblem] = useState<TreeEditError | null>(null)
  const [busy, setBusy] = useState(false)
  const close = (): void => useFileTreeStore.getState().setEdit(null)
  const commit = async (): Promise<void> => {
    if (busy) return
    if (!name || name === initial) {
      close()
      return
    }
    setBusy(true)
    const error =
      edit.kind === 'rename'
        ? await renameEntry(edit.path, name)
        : await createEntry(edit.dir, name, edit.entry)
    setBusy(false)
    if (error) setProblem(error)
    else close()
  }
  const message =
    problem === null
      ? null
      : problem === 'unsaved'
        ? fmt(d.filesView.ops.unsaved, { name: initial })
        : d.filesView.ops.errors[problem]
  return (
    <div className="file-name-edit">
      <div className="file-row editing" style={{ paddingLeft: 8 + depth * 13 }}>
        {dir ? (
          <CaretRightIcon size={12} className="file-twisty" />
        ) : (
          <span className="file-twisty-spacer" />
        )}
        {icon}
        <Input
          autoFocus
          aria-label={labelFor(edit, d)}
          aria-invalid={problem !== null}
          value={name}
          disabled={busy}
          className="file-name-input"
          onFocus={(e) => {
            const dot = initial.lastIndexOf('.')
            e.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)
          }}
          onChange={(e) => {
            setName(e.target.value)
            setProblem(null)
          }}
          onBlur={() => {
            if (!busy) close()
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              void commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              close()
            }
          }}
        />
      </div>
      {message ? (
        <div style={{ paddingLeft: 8 + depth * 13 + NAME_OFFSET }}>
          <WarningNote>{message}</WarningNote>
        </div>
      ) : null}
    </div>
  )
}

export function FileTrashDialog({ workspaceId }: { workspaceId: string | null }): JSX.Element {
  const d = useDict()
  const ops = d.filesView.ops
  const trashing = useFileTreeStore((s) => s.trashing)
  const askTrash = useFileTreeStore((s) => s.askTrash)
  const paths = trashing ?? []
  const count =
    paths.length === 1
      ? fmt(ops.trashOne, { name: nameOf(paths[0] ?? '') })
      : fmt(ops.trashMany, { count: String(paths.length) })
  return (
    <AlertDialog open={trashing !== null} onOpenChange={(open) => (open ? null : askTrash(null))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{fmt(ops.trashTitle, { count })}</AlertDialogTitle>
          <AlertDialogDescription className="break-all">
            {fmt(ops.trashBody, { list: paths.map(nameOf).join(', ') })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="sm">{ops.cancel}</AlertDialogCancel>
          <AlertDialogAction
            size="sm"
            onClick={() => {
              askTrash(null)
              if (workspaceId) void trashEntries(workspaceId, paths)
            }}
          >
            {ops.trash}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

import { IconButton } from '@/components/common/IconButton'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmt, useDict } from '@/i18n/useDict'
import { allPanes } from '@/layout/tree'
import {
  blockOutputContext,
  fileAttachment,
  lastBlockCommand,
  terminalSelectionContext,
} from '@/lib/askContext'
import { byteSize, formatSize, workspaceTerminals } from '@/lib/chatActions'
import { useBlocksStore } from '@/stores/blocksStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useWorkspacesStore } from '@/stores/workspacesStore'
import {
  AtIcon,
  BrowserIcon,
  FileIcon,
  FolderSimpleIcon,
  SelectionIcon,
  TagIcon,
  TextAlignLeftIcon,
  WarningCircleIcon,
  XIcon,
} from '@phosphor-icons/react'
import type { ChatContextItem } from '@shared/assist'
import { useEffect, useMemo, useState } from 'react'

const PREVIEW_MAX = 4000

export interface FileQuery {
  dir: string
  prefix: string
}

export function fileQuery(root: string, typed: string): FileQuery {
  const clean = typed.replace(/^\/+/, '')
  const cut = clean.lastIndexOf('/')
  const sub = cut === -1 ? '' : clean.slice(0, cut)
  return { dir: sub ? `${root}/${sub}` : root, prefix: cut === -1 ? clean : clean.slice(cut + 1) }
}

export function relativeTo(root: string, path: string): string {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

interface PickerSources {
  selection: ChatContextItem | null
  output: ChatContextItem | null
  browsers: ChatContextItem[]
}

function gatherSources(
  workspaceId: string | null,
  labels: { selection: string; output: string },
): PickerSources {
  const blocks = useBlocksStore.getState()
  const terminal = workspaceTerminals(workspaceId, blocks)[0]
  const command = terminal ? lastBlockCommand(terminal.paneId) : null
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const browsers = layout
    ? allPanes(layout.root)
        .filter((p) => p.kind === 'browser' && p.url)
        .map((p) => ({ kind: 'browser' as const, label: p.title, text: `${p.title}\n${p.url}` }))
    : []
  return {
    selection: terminal ? terminalSelectionContext(terminal.paneId, labels.selection) : null,
    output:
      terminal && command
        ? blockOutputContext(terminal.paneId, undefined, fmt(labels.output, { command }))
        : null,
    browsers,
  }
}

export function ChatContextPicker({
  workspaceId,
  open,
  query: seedQuery = '',
  onOpenChange,
  onAttach,
}: {
  workspaceId: string | null
  open: boolean
  query?: string
  onOpenChange: (open: boolean) => void
  onAttach: (item: ChatContextItem) => void
}): JSX.Element {
  const d = useDict()
  const t = d.chatActions
  const root = useWorkspacesStore(
    (s) => s.workspaces.find((w) => w.id === (workspaceId ?? s.activeWorkspaceId))?.workDir ?? '',
  )
  const [typed, setTyped] = useState('')
  const [entries, setEntries] = useState<{ name: string; dir: boolean }[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const sources = useMemo(
    () =>
      open
        ? gatherSources(workspaceId, { selection: t.selection, output: t.outputOf })
        : { selection: null, output: null, browsers: [] },
    [open, workspaceId, t.selection, t.outputOf],
  )
  const query = fileQuery(root, typed)

  useEffect(() => {
    if (!open || !root) return
    let live = true
    window.ostia.fs
      .list(query.dir)
      .then((list) => {
        if (live) setEntries(list)
      })
      .catch(() => {
        if (live) setEntries([])
      })
    return () => {
      live = false
    }
  }, [open, root, query.dir])

  useEffect(() => {
    if (open) {
      setTyped(seedQuery)
      return
    }
    setTyped('')
    setFailed(null)
  }, [open, seedQuery])

  const base = relativeTo(root, query.dir)
  const matches = entries
    .filter((e) => e.name.toLowerCase().startsWith(query.prefix.toLowerCase()))
    .slice(0, 50)
  const pick = (item: ChatContextItem): void => {
    onAttach(item)
    onOpenChange(false)
  }
  const pickFile = (name: string, dir: boolean): void => {
    const relative = base === root ? name : base ? `${base}/${name}` : name
    if (dir) {
      setTyped(`${relative}/`)
      return
    }
    void fileAttachment(`${root}/${relative}`, relative).then((item) => {
      if (item) pick(item)
      else setFailed(fmt(t.readFailed, { path: relative }))
    })
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<IconButton icon={AtIcon} label={t.addContext} />} />
      <PopoverContent side="top" align="start" className="w-96 p-0">
        <Command shouldFilter={false} label={t.pickerTitle}>
          <CommandInput
            value={typed}
            onValueChange={setTyped}
            placeholder={fmt(t.searchFiles, { folder: root })}
            aria-label={t.pickerTitle}
          />
          <CommandList>
            <CommandEmpty>{t.nothingHere}</CommandEmpty>
            {typed === '' ? (
              <CommandGroup heading={t.fromWorkspace}>
                {sources.selection ? (
                  <CommandItem
                    value="selection"
                    onSelect={() => sources.selection && pick(sources.selection)}
                  >
                    <SelectionIcon />
                    <span>{t.selection}</span>
                  </CommandItem>
                ) : null}
                {sources.output ? (
                  <CommandItem
                    value="output"
                    onSelect={() => sources.output && pick(sources.output)}
                  >
                    <TextAlignLeftIcon />
                    <span className="truncate">{sources.output.label}</span>
                  </CommandItem>
                ) : null}
                {sources.browsers.map((b) => (
                  <CommandItem key={b.text} value={`browser ${b.text}`} onSelect={() => pick(b)}>
                    <BrowserIcon />
                    <span className="truncate">{fmt(t.browserPage, { title: b.label })}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {root ? (
              <CommandGroup heading={t.files}>
                {matches.map((e) => (
                  <CommandItem
                    key={`${query.dir}/${e.name}`}
                    value={`file ${e.name}`}
                    onSelect={() => pickFile(e.name, e.dir)}
                  >
                    {e.dir ? <FolderSimpleIcon /> : <FileIcon />}
                    <span className="truncate font-mono text-ui-sm">
                      {e.dir ? `${e.name}/` : e.name}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
          {failed ? (
            <p role="alert" className="px-3 pb-2 text-attn-fg text-ui-xs">
              {failed}
            </p>
          ) : null}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const KIND_ICONS = {
  file: FileIcon,
  editor: FileIcon,
  browser: BrowserIcon,
  output: TextAlignLeftIcon,
  selection: SelectionIcon,
  error: WarningCircleIcon,
  cwd: FolderSimpleIcon,
  pane: TagIcon,
} as const

export function AttachmentChips({
  items,
  onRemove,
}: {
  items: ChatContextItem[]
  onRemove: (index: number) => void
}): JSX.Element | null {
  const d = useDict()
  if (items.length === 0) return null
  return (
    <ul aria-label={d.chatActions.attached} className="flex min-w-0 flex-wrap gap-1">
      {items.map((item, index) => {
        const IconFor = KIND_ICONS[item.kind]
        const size = formatSize(byteSize(item.text))
        const preview =
          item.text.length > PREVIEW_MAX ? `${item.text.slice(0, PREVIEW_MAX)}…` : item.text
        return (
          <li
            key={`${item.kind}:${item.label}`}
            className="chat-attachment flex h-6 min-w-0 items-center gap-1 rounded-sm border border-line bg-surface-1 pr-0.5 pl-1.5 text-fg text-ui-xs"
          >
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="flex min-w-0 items-center gap-1 rounded-sm"
                    aria-label={fmt(d.chatActions.preview, { label: item.label, size })}
                  >
                    <IconFor aria-hidden className="size-3 shrink-0 text-fg-muted" />
                    <span className="max-w-48 truncate">{item.label}</span>
                    <span className="shrink-0 text-fg-muted tabular-nums">{size}</span>
                  </button>
                }
              />
              <PopoverContent side="top" align="start" className="w-96">
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-fg text-ui-xs">
                  {preview}
                </pre>
              </PopoverContent>
            </Popover>
            <IconButton
              icon={XIcon}
              label={fmt(d.chatActions.remove, { label: item.label })}
              onClick={() => onRemove(index)}
            />
          </li>
        )
      })}
    </ul>
  )
}

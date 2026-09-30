import {
  ArrowDownIcon,
  ArrowUpIcon,
  DotsSixVerticalIcon,
  PlusIcon,
  XIcon,
} from '@phosphor-icons/react'
import {
  CORE_CHIP_IDS,
  DEFAULT_PROMPT_CHIPS,
  PROMPT_SEPARATORS,
  type PromptSeparator,
  isCoreChipId,
} from '@shared/promptSettings'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { usePaneChipCatalog } from '../lib/paneChips'
import { addChip, contributedChipId, moveChip, removeChip } from '../lib/promptChips'
import { usePromptChips } from '../lib/usePromptChips'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { IconButton } from './IconButton'
import { PromptChip, chipIcon, chipName } from './PromptChips'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Switch } from './ui/switch'

export function activeTerminalPaneId(): string | null {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout ? findPane(layout.root, layout.activePaneId) : null
  return pane?.kind === 'terminal' ? pane.id : null
}

function usePaneCwd(paneId: string | null): string | undefined {
  return useLayoutStore((s) => {
    if (!paneId) return undefined
    for (const layout of Object.values(s.byWorkspace)) {
      const pane = layout ? findPane(layout.root, paneId) : null
      if (pane) return pane.cwd
    }
    return undefined
  })
}

function Preview({ paneId, order }: { paneId: string | null; order: string[] }): JSX.Element {
  const d = useDict()
  const catalog = usePaneChipCatalog()
  const cwd = usePaneCwd(paneId)
  const { chips } = usePromptChips(paneId, cwd, order, true)
  return (
    <section aria-label={d.prompt.preview} className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium text-fg text-ui-sm">{d.prompt.preview}</h3>
        {paneId ? <span className="text-fg-muted text-ui-xs">{d.prompt.previewPane}</span> : null}
      </div>
      {paneId ? (
        <div className="prompt-chips prompt-preview">
          {order.map((id) => {
            const chip = chips.find((c) => c.id === id)
            const name = chipName(d, id, catalog)
            if (chip) return <PromptChip key={id} chip={chip} label={name} />
            const Icon = chipIcon(isCoreChipId(id) ? id : null)
            return (
              <span
                key={id}
                className="prompt-chip"
                data-chip={id}
                data-unavailable=""
                aria-label={fmt(d.prompt.unavailable, { name })}
              >
                <Icon size={12} aria-hidden="true" />
                <span className="prompt-chip-text">{name}</span>
              </span>
            )
          })}
        </div>
      ) : (
        <p className="text-fg-muted text-ui-sm">{d.prompt.noPreviewPane}</p>
      )}
    </section>
  )
}

function PromptEditorBody({ paneId }: { paneId: string | null }): JSX.Element {
  const d = useDict()
  const saved = useSettingsStore((s) => s.terminal.prompt)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const close = useUIStore((s) => s.closePromptEditor)
  const catalog = usePaneChipCatalog()
  const [order, setOrder] = useState<string[]>(() => [...saved.chips])
  const [sameLine, setSameLine] = useState(saved.sameLine)
  const [separator, setSeparator] = useState<PromptSeparator>(saved.separator)
  const [dragging, setDragging] = useState<number | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const handles = useRef(new Map<string, HTMLButtonElement>())
  const focusAfterMove = useRef<string | null>(null)

  useEffect(() => {
    const id = focusAfterMove.current
    if (!id) return
    focusAfterMove.current = null
    handles.current.get(id)?.focus()
  })

  const available = [
    ...CORE_CHIP_IDS,
    ...catalog.map((c) => contributedChipId(c.extId, c.id)),
  ].filter((id) => !order.includes(id))

  const move = (from: number, to: number, focus = false): void => {
    if (to < 0 || to >= order.length || from === to) return
    const id = order[from]
    setOrder(moveChip(order, from, to))
    setAnnouncement(fmt(d.prompt.moved, { name: chipName(d, id, catalog), position: to + 1 }))
    if (focus) focusAfterMove.current = id
  }

  const onHandleKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      move(index, index + (e.key === 'ArrowUp' ? -1 : 1), true)
    }
  }

  const separatorLabel = (s: PromptSeparator): string => (s === 'none' ? d.prompt.separatorNone : s)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{d.prompt.dialogTitle}</DialogTitle>
        <DialogDescription>{d.prompt.dialogDesc}</DialogDescription>
      </DialogHeader>
      <Preview paneId={paneId} order={order} />
      <section className="flex flex-col gap-1.5">
        <h3 id="prompt-selected" className="font-medium text-fg text-ui-sm">
          {d.prompt.selected}
        </h3>
        <p id="prompt-reorder-hint" className="text-fg-muted text-ui-xs">
          {d.prompt.selectedHint}
        </p>
        {order.length === 0 ? (
          <p className="text-fg-muted text-ui-sm">{d.prompt.noneSelected}</p>
        ) : (
          <ol aria-labelledby="prompt-selected" className="flex flex-col gap-1">
            {order.map((id, index) => {
              const name = chipName(d, id, catalog)
              const Icon = chipIcon(isCoreChipId(id) ? id : null)
              return (
                <li
                  key={id}
                  draggable
                  data-chip={id}
                  data-dragging={dragging === index || undefined}
                  className="flex items-center gap-2 rounded-sm border border-line px-1.5 py-0.5 text-fg text-ui-sm data-dragging:opacity-50"
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', id)
                    setDragging(index)
                  }}
                  onDragOver={(e) => {
                    if (dragging === null) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragging !== null) move(dragging, index)
                    setDragging(null)
                  }}
                  onDragEnd={() => setDragging(null)}
                >
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) handles.current.set(id, el)
                      else handles.current.delete(id)
                    }}
                    aria-label={fmt(d.prompt.reorder, { name })}
                    aria-describedby="prompt-reorder-hint"
                    className="flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-brand"
                    onKeyDown={(e) => onHandleKey(e, index)}
                  >
                    <DotsSixVerticalIcon size={14} aria-hidden="true" className="text-fg-muted" />
                    <Icon size={14} aria-hidden="true" className="text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                  </button>
                  <IconButton
                    icon={ArrowUpIcon}
                    label={fmt(d.prompt.moveUp, { name })}
                    disabled={index === 0}
                    onClick={() => move(index, index - 1)}
                  />
                  <IconButton
                    icon={ArrowDownIcon}
                    label={fmt(d.prompt.moveDown, { name })}
                    disabled={index === order.length - 1}
                    onClick={() => move(index, index + 1)}
                  />
                  <IconButton
                    icon={XIcon}
                    label={fmt(d.prompt.remove, { name })}
                    onClick={() => setOrder(removeChip(order, id))}
                  />
                </li>
              )
            })}
          </ol>
        )}
        <span className="sr-only" aria-live="polite">
          {announcement}
        </span>
      </section>
      <section className="flex flex-col gap-1.5">
        <h3 id="prompt-available" className="font-medium text-fg text-ui-sm">
          {d.prompt.available}
        </h3>
        {available.length === 0 ? (
          <p className="text-fg-muted text-ui-sm">{d.prompt.noneAvailable}</p>
        ) : (
          <ul aria-labelledby="prompt-available" className="flex flex-wrap gap-1">
            {available.map((id) => {
              const name = chipName(d, id, catalog)
              const Icon = chipIcon(isCoreChipId(id) ? id : null)
              return (
                <li key={id}>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={fmt(d.prompt.add, { name })}
                    onClick={() => setOrder(addChip(order, id))}
                  >
                    <PlusIcon aria-hidden="true" />
                    <Icon aria-hidden="true" />
                    {name}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
      </section>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-fg text-ui-base">{d.prompt.sameLine}</div>
          <p className="text-fg-muted text-ui-sm">{d.prompt.sameLineDesc}</p>
        </div>
        <Switch checked={sameLine} onCheckedChange={setSameLine} aria-label={d.prompt.sameLine} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-fg text-ui-base">{d.prompt.separator}</div>
          <p className="text-fg-muted text-ui-sm">{d.prompt.separatorDesc}</p>
        </div>
        <Select value={separator} onValueChange={(v) => setSeparator(v as PromptSeparator)}>
          <SelectTrigger size="sm" aria-label={d.prompt.separator} className="w-24">
            {separatorLabel(separator)}
          </SelectTrigger>
          <SelectContent>
            {PROMPT_SEPARATORS.map((s) => (
              <SelectItem key={s} value={s}>
                {separatorLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DialogFooter className="sm:justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOrder([...DEFAULT_PROMPT_CHIPS])
            setSameLine(false)
            setSeparator('none')
          }}
        >
          {d.prompt.restoreDefault}
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={close}>
            {d.prompt.cancel}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setTerminal({ prompt: { style: 'pine', chips: order, sameLine, separator } })
              close()
            }}
          >
            {d.prompt.save}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}

export function PromptEditorDialog(): JSX.Element {
  const editor = useUIStore((s) => s.promptEditor)
  const close = useUIStore((s) => s.closePromptEditor)
  return (
    <Dialog
      open={editor !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[calc(100vh-4rem)] overflow-y-auto sm:max-w-lg">
        {editor ? <PromptEditorBody paneId={editor.paneId} /> : null}
      </DialogContent>
    </Dialog>
  )
}

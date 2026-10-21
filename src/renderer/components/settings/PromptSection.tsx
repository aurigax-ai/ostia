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
  isCoreChipId,
  PROMPT_SEPARATORS,
  PROMPT_STYLES,
  type PromptSeparator,
  type PromptSettings,
  type PromptStyle,
} from '@shared/terminal/promptSettings'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Notice } from '@/components/common/Notice'
import { chipIcon, chipName, PromptChip } from '@/components/prompt/PromptChips'
import { ControlRow, ToggleRow } from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup, SettingsSubgroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsList } from '@/components/settingsKit/SettingsList'
import { SettingsListRow } from '@/components/settingsKit/SettingsListRow'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { useChipCatalog } from '@/lib/extensions/extensionChips'
import { findPane } from '@/lib/layout/tree'
import type { PaneNode } from '@/lib/layout/types'
import { addChip, contributedChipId, moveChip, removeChip } from '@/lib/prompt/promptChips'
import { usePromptChips } from '@/lib/prompt/usePromptChips'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import type { WorkspaceLayout } from '@/stores/workspaces/layoutTypes'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function findTerminal(
  byWorkspace: Record<string, WorkspaceLayout | undefined>,
  paneId: string,
): PaneNode | null {
  for (const layout of Object.values(byWorkspace)) {
    const pane = layout ? findPane(layout.root, paneId) : null
    if (pane) return pane.kind === 'terminal' ? pane : null
  }
  return null
}

function usePreviewPane(): PaneNode | null {
  const requested = useUIStore((s) => s.promptPreviewPaneId)
  const workspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
  return useLayoutStore((s) => {
    const fromRequest = requested ? findTerminal(s.byWorkspace, requested) : null
    if (fromRequest) return fromRequest
    const layout = workspaceId ? s.byWorkspace[workspaceId] : undefined
    const active = layout ? findPane(layout.root, layout.activePaneId) : null
    return active?.kind === 'terminal' ? active : null
  })
}

function Preview({ order }: { order: string[] }): JSX.Element {
  const d = useDict()
  const catalog = useChipCatalog()
  const pane = usePreviewPane()
  const paneId = pane?.id ?? null
  const { chips } = usePromptChips(paneId, pane?.cwd, order, true)
  return (
    <section aria-label={d.prompt.preview} className="mb-4">
      <SettingsSubgroup title={d.prompt.preview} desc={paneId ? d.prompt.previewPane : undefined} />
      {paneId ? (
        <div className="rounded-sm border border-line bg-bg-sunken px-3 py-2">
          <div className="prompt-chips prompt-preview">
            {order.map((id) => {
              const chip = chips.find((c) => c.id === id)
              const name = chipName(d, id, catalog)
              if (chip) return <PromptChip key={id} chip={chip} label={name} />
              const Icon = chipIcon(isCoreChipId(id) ? id : null)
              return (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the label names the block for screen readers and tests; a role would change how it is announced
                <span
                  key={id}
                  className="prompt-chip"
                  data-chip={id}
                  data-unavailable=""
                  aria-label={fmt(d.prompt.unavailable, { name })}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="prompt-chip-text">{name}</span>
                </span>
              )
            })}
          </div>
        </div>
      ) : (
        <p className="text-fg-muted text-ui-sm">{d.prompt.noPreviewPane}</p>
      )}
    </section>
  )
}

function SelectedChips({
  order,
  setOrder,
}: {
  order: string[]
  setOrder: (chips: string[]) => void
}): JSX.Element {
  const d = useDict()
  const catalog = useChipCatalog()
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

  return (
    <section className="mb-4">
      <div id="prompt-selected">
        <SettingsSubgroup title={d.prompt.selected} />
      </div>
      <p id="prompt-reorder-hint" className="-mt-1.5 mb-2 text-fg-muted text-ui-xs">
        {d.prompt.selectedHint}
      </p>
      <SettingsList
        ordered
        label={d.prompt.selected}
        labelledBy="prompt-selected"
        empty={d.prompt.noneSelected}
      >
        {order.map((id, index) => {
          const name = chipName(d, id, catalog)
          const Icon = chipIcon(isCoreChipId(id) ? id : null)
          return (
            <SettingsListRow
              key={id}
              draggable
              data-chip={id}
              data-dragging={dragging === index || undefined}
              className="data-dragging:opacity-50"
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
              title={
                <button
                  type="button"
                  ref={(el) => {
                    if (el) handles.current.set(id, el)
                    else handles.current.delete(id)
                  }}
                  aria-label={fmt(d.prompt.reorder, { name })}
                  aria-describedby="prompt-reorder-hint"
                  className="flex w-full min-w-0 cursor-grab items-center gap-2 rounded-sm text-left"
                  onKeyDown={(e) => onHandleKey(e, index)}
                >
                  <DotsSixVerticalIcon size={16} aria-hidden="true" className="text-fg-muted" />
                  <Icon size={16} aria-hidden="true" className="text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </button>
              }
              actions={
                <>
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
                </>
              }
            />
          )
        })}
      </SettingsList>
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </section>
  )
}

function AvailableChips({
  order,
  setOrder,
}: {
  order: string[]
  setOrder: (chips: string[]) => void
}): JSX.Element {
  const d = useDict()
  const catalog = useChipCatalog()
  const available = [
    ...CORE_CHIP_IDS,
    ...catalog.map((c) => contributedChipId(c.extId, c.id)),
  ].filter((id) => !order.includes(id))
  return (
    <section>
      <div id="prompt-available">
        <SettingsSubgroup title={d.prompt.available} />
      </div>
      {available.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.prompt.noneAvailable}</p>
      ) : (
        <ul aria-labelledby="prompt-available" className="flex flex-wrap gap-1.5">
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
  )
}

export function PromptSection(): JSX.Element {
  const d = useDict()
  const prompt = useSettingsStore((s) => s.terminal.prompt)
  const inputMode = useSettingsStore((s) => s.behavior.inputMode)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const update = (patch: Partial<PromptSettings>): void =>
    setTerminal({ prompt: { ...prompt, ...patch } })
  const setOrder = (chips: string[]): void => update({ chips })
  const styleLabel: Record<PromptStyle, string> = {
    shell: d.settings.promptStyleShell,
    ostia: d.settings.promptStylePine,
  }
  const separatorLabel = (s: PromptSeparator): string => (s === 'none' ? d.prompt.separatorNone : s)

  return (
    <SettingsPage title={d.prompt.title} desc={d.prompt.desc}>
      <SettingsGroup title={d.prompt.groupStyle}>
        <ControlRow label={d.settings.promptStyle} desc={d.settings.promptStyleDesc}>
          <SelectField
            value={prompt.style}
            onChange={(style) => update({ style })}
            label={d.settings.promptStyle}
            options={PROMPT_STYLES.map((p) => ({ value: p, label: styleLabel[p] }))}
          />
        </ControlRow>
        <p className="text-fg-muted text-ui-xs">{d.prompt.openShellsNote}</p>
        {prompt.style === 'ostia' && inputMode !== 'editor' ? (
          <Notice>{d.settings.promptNeedsEditor}</Notice>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={d.prompt.groupChips}>
        {prompt.style === 'shell' ? (
          <p className="mb-3 text-fg-muted text-ui-sm">{d.prompt.appliesToPine}</p>
        ) : null}
        <Preview order={prompt.chips} />
        <SelectedChips order={prompt.chips} setOrder={setOrder} />
        <AvailableChips order={prompt.chips} setOrder={setOrder} />
      </SettingsGroup>
      <SettingsGroup title={d.prompt.groupLayout}>
        <ToggleRow
          label={d.prompt.sameLine}
          desc={d.prompt.sameLineDesc}
          checked={prompt.sameLine}
          onChange={(sameLine) => update({ sameLine })}
        />
        <ControlRow label={d.prompt.separator} desc={d.prompt.separatorDesc}>
          <SelectField
            value={prompt.separator}
            onChange={(separator) => update({ separator })}
            label={d.prompt.separator}
            options={PROMPT_SEPARATORS.map((s) => ({ value: s, label: separatorLabel(s) }))}
            width="w-fit min-w-24 max-w-80"
          />
        </ControlRow>
        <ControlRow label={d.prompt.restoreDefault} desc={d.prompt.restoreDefaultDesc}>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              update({ chips: [...DEFAULT_PROMPT_CHIPS], sameLine: false, separator: 'none' })
            }
          >
            {d.prompt.restore}
          </Button>
        </ControlRow>
      </SettingsGroup>
    </SettingsPage>
  )
}

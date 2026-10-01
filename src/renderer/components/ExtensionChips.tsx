import { CopyIcon } from '@phosphor-icons/react'
import type { PaneChipItem } from '@shared/extensions'
import { fmt, useDict } from '../i18n/useDict'
import {
  type ShownChip,
  chipAction,
  openChipUrl,
  usePaneChips,
  useWorkspaceChips,
} from '../lib/extensionChips'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { extensionIcon } from './extensionIcons'
import { Badge } from './ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

export function PaneChips({ paneId }: { paneId: string }): JSX.Element | null {
  const d = useDict()
  return <ChipList chips={usePaneChips(paneId)} label={d.extensions.chipsLabel} />
}

export function WorkspaceChips({
  workspaceId,
}: { workspaceId: string | null }): JSX.Element | null {
  const d = useDict()
  return (
    <ChipList
      chips={useWorkspaceChips(workspaceId)}
      label={d.extensions.workspaceChipsLabel}
      className="workspace-chips"
    />
  )
}

function ChipList({
  chips,
  label,
  className,
}: { chips: ShownChip[]; label: string; className?: string }): JSX.Element | null {
  if (chips.length === 0) return null
  return (
    <ul className={className ? `pane-chips ${className}` : 'pane-chips'} aria-label={label}>
      {chips.map((chip) => (
        <li key={`${chip.extId}:${chip.id}`}>
          <Chip chip={chip} />
        </li>
      ))}
    </ul>
  )
}

function Chip({ chip }: { chip: ShownChip }): JSX.Element {
  return chip.icon ? <IconChip chip={chip} /> : <TextChip chip={chip} />
}

function IconChip({ chip }: { chip: ShownChip }): JSX.Element {
  const d = useDict()
  const Icon = extensionIcon(chip.icon)
  const count = (
    <span className="pane-chip-count" aria-hidden="true">
      {chip.text}
    </span>
  )
  const items = chip.items
  if (!items) {
    const action = chipAction(chip)
    return (
      <span className="pane-chip-icon">
        <IconButton
          icon={Icon}
          label={fmt(d.extensions.chipStatus, { title: chip.title, text: chip.text })}
          disabled={!action}
          onClick={action ? () => void action() : undefined}
        />
        {count}
      </span>
    )
  }
  return (
    <Popover>
      <span className="pane-chip-icon">
        <PopoverTrigger
          render={
            <IconButton
              icon={Icon}
              label={fmt(d.extensions.chipItems, { title: chip.title, text: chip.text })}
            />
          }
        />
        {count}
      </span>
      <PopoverContent align="end" className="pane-chip-popover" aria-label={chip.title}>
        <p className="text-ui-xs text-fg-muted">{chip.tooltip ?? chip.title}</p>
        <ul className="pane-chip-items">
          {items.map((item, i) => (
            <li key={`${i}:${item.text}`}>
              <ChipItem chip={chip} item={item} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function ChipItem({ chip, item }: { chip: ShownChip; item: PaneChipItem }): JSX.Element {
  const d = useDict()
  const url = item.url
  if (!url) return <span className="pane-chip-item font-mono text-ui-sm">{item.text}</span>
  return (
    <span className="pane-chip-item">
      <button
        type="button"
        className="pane-chip-item-open font-mono text-ui-sm"
        aria-label={fmt(d.extensions.chipOpenItem, { url })}
        onClick={() => openChipUrl(chip, url)}
      >
        {item.text}
      </button>
      <IconButton
        icon={CopyIcon}
        label={fmt(d.extensions.chipCopyUrl, { url })}
        onClick={() => void navigator.clipboard.writeText(url)}
      />
    </span>
  )
}

function TextChip({ chip }: { chip: ShownChip }): JSX.Element {
  const d = useDict()
  const action = chipAction(chip)
  const hint = chip.tooltip ?? `${chip.extName} · ${chip.title}`
  const className = `pane-chip tone-${chip.tone}`
  if (!action) {
    return (
      <Hint label={hint} side="bottom">
        <Badge variant="outline" className={className}>
          {chip.text}
        </Badge>
      </Hint>
    )
  }
  return (
    <Hint label={hint} side="bottom">
      <Badge
        variant="outline"
        className={`${className} pane-chip-action`}
        render={
          <button
            type="button"
            aria-label={
              chip.url
                ? fmt(d.extensions.chipLink, { title: chip.title, text: chip.text, url: chip.url })
                : fmt(d.extensions.chipAction, {
                    title: chip.title,
                    text: chip.text,
                    command: chip.command ?? '',
                  })
            }
            onClick={() => void action()}
          />
        }
      >
        {chip.text}
      </Badge>
    </Hint>
  )
}

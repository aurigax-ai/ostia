import type { PaneChipItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { CopyIcon, PencilSimpleIcon } from '@phosphor-icons/react'
import { parseLocalPort } from '@shared/remote/remotePorts'
import { type JSX, useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fmt, useDict } from '@/lib/app/useDict'
import {
  chipAction,
  openChipUrl,
  type ShownChip,
  usePaneChips,
  useWorkspaceChips,
} from '@/lib/extensions/extensionChips'
import { forwardPort, stopPort } from '@/lib/remote/remoteApi'
import { extensionIcon } from './extensionIcons'

export function PaneChips({ paneId }: { paneId: string }): JSX.Element | null {
  const d = useDict()
  return <ChipList chips={usePaneChips(paneId)} label={d.extensions.chipsLabel} />
}

export function WorkspaceChips({
  workspaceId,
}: {
  workspaceId: string | null
}): JSX.Element | null {
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
}: {
  chips: ShownChip[]
  label: string
  className?: string
}): JSX.Element | null {
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
  const items = chip.items
  const count = items ? (
    <span className="pane-chip-dot" aria-hidden="true" />
  ) : (
    <span className="pane-chip-count" aria-hidden="true">
      {chip.text}
    </span>
  )
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
            // biome-ignore lint/suspicious/noArrayIndexKey: the index tells repeated entries apart and the list is rebuilt, never reordered
            <li key={`${i}:${item.text}`}>
              <ChipItem chip={chip} item={item} />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

function ChipItemText({ item }: { item: PaneChipItem }): JSX.Element {
  return (
    <>
      {item.text}
      {item.detail && <span className="pane-chip-item-detail">{item.detail}</span>}
      {item.port?.error && (
        <span className="pane-chip-item-detail text-destructive">{item.port.error}</span>
      )}
    </>
  )
}

export function ChipItem({ chip, item }: { chip: ShownChip; item: PaneChipItem }): JSX.Element {
  const d = useDict()
  const [editing, setEditing] = useState(false)
  const url = item.url
  const port = item.port
  if (port && editing && chip.workspaceId) {
    return (
      <PortEditor workspaceId={chip.workspaceId} port={port} onDone={() => setEditing(false)} />
    )
  }
  const pencil = port ? (
    <IconButton
      icon={PencilSimpleIcon}
      label={fmt(d.extensions.chipEditPort, { port: String(port.remote) })}
      onClick={() => setEditing(true)}
    />
  ) : null
  if (!url) {
    return (
      <span className="pane-chip-item">
        <span className="pane-chip-item-open font-mono text-ui-sm">
          <ChipItemText item={item} />
        </span>
        {pencil}
      </span>
    )
  }
  return (
    <span className="pane-chip-item">
      <button
        type="button"
        className="pane-chip-item-open font-mono text-ui-sm"
        aria-label={fmt(d.extensions.chipOpenItem, { url })}
        onClick={() => openChipUrl(chip, url)}
      >
        <ChipItemText item={item} />
      </button>
      <IconButton
        icon={CopyIcon}
        label={fmt(d.extensions.chipCopyUrl, { url })}
        onClick={() => void navigator.clipboard.writeText(url)}
      />
      {pencil}
    </span>
  )
}

function PortEditor({
  workspaceId,
  port,
  onDone,
}: {
  workspaceId: string
  port: NonNullable<PaneChipItem['port']>
  onDone: () => void
}): JSX.Element {
  const d = useDict()
  const [text, setText] = useState(port.local === undefined ? '' : String(port.local))
  const [failure, setFailure] = useState<string | null>(null)
  const parsed = parseLocalPort(text)
  const bad = parsed === 'bad'
  const save = async (): Promise<void> => {
    if (parsed === 'bad') return
    const res = await forwardPort(workspaceId, port.remote, parsed)
    if (res.ok) onDone()
    else setFailure(res.message ?? res.error)
  }
  const stop = async (): Promise<void> => {
    const res = await stopPort(workspaceId, port.remote)
    if (res.ok) onDone()
    else setFailure(res.message ?? res.error)
  }
  return (
    <span className="pane-chip-item">
      <Input
        value={text}
        inputMode="numeric"
        className="h-7 w-24 font-mono text-ui-sm"
        aria-label={d.extensions.chipLocalPort}
        aria-invalid={bad || failure !== null}
        title={bad ? d.extensions.chipLocalPortInvalid : (failure ?? undefined)}
        onChange={(e) => {
          setText(e.target.value)
          setFailure(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save()
          if (e.key === 'Escape') onDone()
        }}
      />
      <span className="flex items-center gap-1">
        <Button size="sm" disabled={bad} onClick={() => void save()}>
          {d.extensions.chipSavePort}
        </Button>
        {port.local !== undefined && (
          <Button size="sm" variant="outline" onClick={() => void stop()}>
            {d.extensions.chipStopPort}
          </Button>
        )}
      </span>
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

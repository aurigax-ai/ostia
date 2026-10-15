import { IconButton } from '@/components/common/IconButton'
import { Item, ItemContent, ItemTitle } from '@/components/ui/item'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAgoText } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { openArtifact, useArtifactListing } from '@/lib/files/artifacts'
import { useUIStore } from '@/stores/app/uiStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { FilesIcon } from '@phosphor-icons/react'
import type { ArtifactEntry } from '@shared/artifacts/artifacts'
import { type KeyboardEvent, useMemo, useRef, useState } from 'react'
import { fileIcon } from './fileIcon'

const SCROLL_FROM = 8

function useProduced(workspaceId: string, paneId: string): ArtifactEntry[] {
  const listing = useArtifactListing(workspaceId)
  const producers = useArtifactsStore((s) => s.producers[workspaceId])
  return useMemo(
    () => (listing?.entries ?? []).filter((entry) => producers?.[entry.path] === paneId),
    [listing, producers, paneId],
  )
}

function rowsOf(list: HTMLElement | null): HTMLButtonElement[] {
  return list ? [...list.querySelectorAll<HTMLButtonElement>('button')] : []
}

export function ArtifactChip({
  workspaceId,
  paneId,
}: {
  workspaceId: string
  paneId: string
}): JSX.Element | null {
  const d = useDict()
  const produced = useProduced(workspaceId, paneId)
  const unread = useArtifactsStore((s) => s.unread)
  const ago = useAgoText()
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLUListElement>(null)
  if (produced.length === 0) return null
  const anyUnread = produced.some((entry) => unread[entry.path])
  const marks = (
    <>
      <span className="pane-chip-count" data-testid="artifact-chip-count" aria-hidden="true">
        {produced.length}
      </span>
      {anyUnread ? (
        <span className="pane-chip-dot" data-testid="artifact-chip-dot" aria-hidden="true" />
      ) : null}
    </>
  )
  if (produced.length === 1) {
    const [only] = produced
    return (
      <span className="pane-chip-icon artifact-chip">
        <IconButton
          icon={FilesIcon}
          label={fmt(d.portable.chipOne, { name: only.name })}
          onClick={() => openArtifact(workspaceId, only)}
        />
        {marks}
      </span>
    )
  }
  const close = (): void => setOpen(false)
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const rows = rowsOf(listRef.current)
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const next = at === -1 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length
    rows[next]?.focus()
  }
  const rows = (
    <ul ref={listRef} className="artifact-chip-list" aria-label={d.portable.chip} tabIndex={-1}>
      {produced.map((entry) => {
        const { Icon, color } = fileIcon({ name: entry.name, dir: false }, false)
        return (
          <li key={entry.path}>
            <Item
              size="xs"
              className="w-full text-left"
              render={
                <button
                  type="button"
                  onClick={() => {
                    close()
                    openArtifact(workspaceId, entry)
                  }}
                />
              }
            >
              <span className="artifact-chip-icon" aria-hidden="true">
                <Icon size={16} style={{ color }} />
              </span>
              <ItemContent>
                <ItemTitle className="text-ui-sm">{entry.name}</ItemTitle>
              </ItemContent>
              {unread[entry.path] ? (
                <span className="unread-dot" role="img" aria-label={d.artifacts.unread} />
              ) : null}
              <span className="artifact-meta text-ui-xs">{ago(Date.now() - entry.modified)}</span>
            </Item>
          </li>
        )
      })}
      <li>
        <Item
          size="xs"
          className="w-full text-left"
          render={
            <button
              type="button"
              onClick={() => {
                close()
                useUIStore.getState().showFiles()
              }}
            />
          }
        >
          <ItemContent>
            <ItemTitle className="text-ui-sm">{d.portable.allArtifacts}</ItemTitle>
          </ItemContent>
        </Item>
      </li>
    </ul>
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="pane-chip-icon artifact-chip">
        <PopoverTrigger render={<IconButton icon={FilesIcon} label={d.portable.chip} />} />
        {marks}
      </span>
      <PopoverContent
        align="end"
        className="pane-chip-popover"
        initialFocus={listRef}
        onKeyDown={onKeyDown}
      >
        {produced.length > SCROLL_FROM ? (
          <ScrollArea className="artifact-chip-scroll">{rows}</ScrollArea>
        ) : (
          rows
        )}
      </PopoverContent>
    </Popover>
  )
}

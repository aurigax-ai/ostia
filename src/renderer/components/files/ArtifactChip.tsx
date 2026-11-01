import { FilesIcon } from '@phosphor-icons/react'
import type { ArtifactEntry } from '@shared/artifacts/artifacts'
import { type JSX, useMemo } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { useAgoText } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { openArtifact, useArtifactListing } from '@/lib/files/artifacts'
import { useUIStore } from '@/stores/app/uiStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { fileIcon } from './fileIconFor'

function useProduced(workspaceId: string, paneId: string): ArtifactEntry[] {
  const listing = useArtifactListing(workspaceId)
  const producers = useArtifactsStore((s) => s.producers[workspaceId])
  return useMemo(
    () => (listing?.entries ?? []).filter((entry) => producers?.[entry.path] === paneId),
    [listing, producers, paneId],
  )
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
  return (
    <span className="pane-chip-icon artifact-chip">
      <DropdownMenu trigger={<IconButton icon={FilesIcon} label={d.portable.chip} />}>
        {produced.map((entry) => {
          const { Icon, color } = fileIcon({ name: entry.name, dir: false }, false)
          return (
            <MenuItem
              key={entry.path}
              leading={<Icon size={16} style={{ color }} />}
              hint={
                <>
                  {unread[entry.path] ? (
                    <span className="unread-dot" role="img" aria-label={d.artifacts.unread} />
                  ) : null}
                  {ago(Date.now() - entry.modified)}
                </>
              }
              onClick={() => openArtifact(workspaceId, entry)}
            >
              {entry.name}
            </MenuItem>
          )
        })}
        <MenuItem onClick={() => useUIStore.getState().showFiles()}>
          {d.portable.allArtifacts}
        </MenuItem>
      </DropdownMenu>
      {marks}
    </span>
  )
}

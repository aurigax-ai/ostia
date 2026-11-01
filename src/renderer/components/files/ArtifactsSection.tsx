import { CaretRightIcon, FolderOpenIcon, NotePencilIcon } from '@phosphor-icons/react'
import type { ArtifactEntry } from '@shared/artifacts/artifacts'
import { type JSX, useEffect, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { MenuContent } from '@/components/common/Menu'
import { PortableMenuItems, usePortableFile } from '@/components/editor/PortableActions'
import { PublishDialog } from '@/components/shares/PublishDialog'
import { usePublishing } from '@/components/shares/usePublishing'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { formatBytes, useAgoText } from '@/lib/app/localeFormat'
import { useDict } from '@/lib/app/useDict'
import { useNow } from '@/lib/app/useNow'
import { openArtifact, openPad, opensInOstia } from '@/lib/files/artifacts'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { fileIcon } from './fileIconFor'

const AGE_TICK_MS = 30_000

function ArtifactRow({
  workspaceId,
  entry,
  age,
}: {
  workspaceId: string
  entry: ArtifactEntry
  age: string
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const unread = useArtifactsStore((s) => s.unread[entry.path] === true)
  const { Icon, color } = fileIcon({ name: entry.name, dir: false }, false)
  const portable = usePortableFile(workspaceId, entry.path)
  const publishing = usePublishing(entry.path, portable.run, portable.say)
  const row = (
    <button
      type="button"
      className="artifact-row"
      data-testid="artifact-row"
      data-unread={unread ? 'true' : undefined}
      onClick={() => openArtifact(workspaceId, entry)}
    >
      <Icon size={16} className="file-icon" style={{ color }} />
      <span className="file-name">{entry.name}</span>
      {unread ? <span className="unread-dot" role="img" aria-label={d.artifacts.unread} /> : null}
      <span className="artifact-meta">
        {opensInOstia(entry) ? age : formatBytes(entry.size, locale)}
      </span>
    </button>
  )
  if (!portable.shown) return row
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={row} />
        <MenuContent>
          <PortableMenuItems run={portable.run} publishing={publishing} />
        </MenuContent>
      </ContextMenu>
      <PublishDialog publishing={publishing} />
    </>
  )
}

function PadRow({ workspaceId, path }: { workspaceId: string; path?: string }): JSX.Element {
  const d = useDict()
  const unread = useArtifactsStore((s) => path !== undefined && s.unread[path] === true)
  return (
    <button
      type="button"
      className="artifact-row"
      data-testid="artifact-pad"
      data-unread={unread ? 'true' : undefined}
      onClick={() => void openPad(workspaceId)}
    >
      <NotePencilIcon size={16} className="file-icon" />
      <span className="file-name">{d.artifacts.pad}</span>
      {unread ? <span className="unread-dot" role="img" aria-label={d.artifacts.unread} /> : null}
    </button>
  )
}

export function ArtifactsSection({
  workspaceId,
}: {
  workspaceId: string | null
}): JSX.Element | null {
  const d = useDict()
  const [open, setOpen] = useState(true)
  const listing = useArtifactsStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  const now = useNow(AGE_TICK_MS)
  const ago = useAgoText()

  useEffect(() => {
    if (workspaceId) void useArtifactsStore.getState().refresh(workspaceId)
  }, [workspaceId])

  if (!workspaceId) return null
  const entries = listing?.entries ?? []
  return (
    <section className="artifacts-section" data-testid="artifacts-section">
      <div className="artifacts-head">
        <button
          type="button"
          className="artifacts-toggle"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <CaretRightIcon size={16} className={`file-twisty${open ? ' open' : ''}`} />
          <span>{d.artifacts.title}</span>
        </button>
        <IconButton
          icon={FolderOpenIcon}
          label={d.artifacts.reveal}
          onClick={() => window.ostia.artifacts.reveal(workspaceId)}
        />
      </div>
      {open ? (
        <div className="artifacts-list">
          <PadRow workspaceId={workspaceId} path={listing?.pad} />
          {entries.map((entry) => (
            <ArtifactRow
              key={entry.path}
              workspaceId={workspaceId}
              entry={entry}
              age={ago(now - entry.modified)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/i18n/useDict'
import { openArtifact, openPad, opensInOstia, sizeText } from '@/lib/artifacts'
import { agoText } from '@/lib/dashboard'
import { useArtifactsStore } from '@/stores/artifactsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { CaretRightIcon, FolderOpenIcon, NotePencilIcon } from '@phosphor-icons/react'
import type { ArtifactEntry } from '@shared/artifacts'
import { useEffect, useMemo, useState } from 'react'
import { fileIcon } from './fileIcon'

const AGE_TICK_MS = 30_000

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

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
  const unread = useArtifactsStore((s) => s.unread[entry.path] === true)
  const { Icon, color } = fileIcon({ name: entry.name, dir: false }, false)
  return (
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
      <span className="artifact-meta">{opensInOstia(entry) ? age : sizeText(entry.size)}</span>
    </button>
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

export function ArtifactsSection({ workspaceId }: { workspaceId: string | null }): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const [open, setOpen] = useState(true)
  const listing = useArtifactsStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined))
  const now = useNow()
  const relative = useMemo(
    () => new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'short' }),
    [locale],
  )

  useEffect(() => {
    if (workspaceId) void useArtifactsStore.getState().refresh(workspaceId)
  }, [workspaceId])

  if (!workspaceId) return <></>
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
          <CaretRightIcon size={12} className={`file-twisty${open ? ' open' : ''}`} />
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
              age={agoText(now - entry.modified, d.dashboard.justNow, relative)}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

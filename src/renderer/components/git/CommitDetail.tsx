import { XIcon } from '@phosphor-icons/react'
import type { GitCommitFilesData, GitFailure, GraphCommit } from '@shared/boards/git'
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import {
  absoluteTime,
  failureText,
  type GraphModel,
  indexOfKey,
  relativeTime,
  shortSha,
} from '@/lib/git/gitView'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { FileList, type FolderState, ViewToggle } from './ChangeList'

const DETAIL_DELAY_MS = 120
const MAX_CACHED_DETAILS = 200

type Detail = GitCommitFilesData | GitFailure

function useCommitFiles(workspaceId: string, sha: string | null): Detail | null {
  const cache = useRef(new Map<string, Detail>())
  const [, setLoads] = useState(0)
  useEffect(() => {
    if (!sha || cache.current.has(sha)) return
    let alive = true
    const timer = setTimeout(() => {
      void window.ostia.git.commitFiles(workspaceId, sha).then((res) => {
        const details = cache.current
        details.set(sha, res.ok ? res.data : res)
        for (const oldest of details.keys()) {
          if (details.size <= MAX_CACHED_DETAILS) break
          details.delete(oldest)
        }
        if (alive) setLoads((n) => n + 1)
      })
    }, DETAIL_DELAY_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [workspaceId, sha])
  return sha ? (cache.current.get(sha) ?? null) : null
}

export function DetailHead({
  title,
  meta,
  onClose,
}: {
  title: string
  meta: ReactNode
  onClose: () => void
}): JSX.Element {
  const t = useDict().git
  return (
    <header className="detail-head">
      <div className="detail-title">
        <span className="detail-subject">{title}</span>
        <div className="detail-meta muted">{meta}</div>
      </div>
      <ViewToggle />
      <IconButton icon={XIcon} label={t.closeDetails} onClick={onClose} />
    </header>
  )
}

export function CommitDetail({
  workspaceId,
  commit,
  model,
  now,
  folders,
  onSelect,
  onOpenFile,
}: {
  workspaceId: string
  commit: GraphCommit
  model: GraphModel
  now: number
  folders: FolderState
  onSelect: (key: string | null) => void
  onOpenFile: (sha: string, path: string) => void
}): JSX.Element {
  const t = useDict().git
  const locale = useSettingsStore((s) => s.locale)
  const detail = useCommitFiles(workspaceId, commit.sha)
  return (
    <section className="detail" aria-label={commit.subject} data-sha={commit.sha}>
      <DetailHead
        title={commit.subject}
        onClose={() => onSelect(null)}
        meta={
          <>
            <span className="sha">{commit.sha.slice(0, 10)}</span>
            <span>{commit.author}</span>
            <span title={absoluteTime(commit.time, locale)}>
              {relativeTime(commit.time, now, locale)}
            </span>
            {commit.parents.length > 1 ? <span>{t.merge}</span> : null}
            {commit.parents.length > 0 ? (
              <span className="parents">
                {`${t.parents}: `}
                {commit.parents.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="link sha"
                    aria-label={`${t.parents}: ${shortSha(p)}`}
                    disabled={indexOfKey(model, p) < 0}
                    onClick={() => onSelect(p)}
                  >
                    {shortSha(p)}
                  </button>
                ))}
              </span>
            ) : null}
          </>
        }
      />
      {detail === null ? (
        <output className="muted detail-status">{t.loading}</output>
      ) : 'ok' in detail ? (
        <div className="error detail-status" role="alert">
          {failureText(detail)}
        </div>
      ) : detail.files.length === 0 ? (
        <div className="muted detail-status">{t.noFiles}</div>
      ) : (
        <FileList
          items={detail.files}
          folders={folders}
          scopeKey={`c-${commit.sha}`}
          label={(f) => `${t.openDiff}: ${f.path} (${shortSha(commit.sha)})`}
          onOpen={(f) => onOpenFile(commit.sha, f.path)}
        />
      )}
    </section>
  )
}

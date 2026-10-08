import { GitBranchIcon } from '@phosphor-icons/react'
import type { GitChangesData } from '@shared/git'
import { fmt, useDict } from '../../i18n/useDict'
import { branchLabel } from '../../lib/gitView'
import { isMac } from '../../platform'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import {
  type ChangeHandlers,
  ChangeSections,
  type FolderState,
  Tracking,
  ViewToggle,
} from './ChangeList'
import { GitEmpty } from './GitEmpty'
import { SplitPane } from './SplitPane'

export const CHANGES_SPLIT = 'changes-commit'
const FILES_MIN = 72
const COMMIT_KEYS = isMac ? '⌘Enter' : 'Ctrl+Enter'

function CommitBox({
  canCommit,
  draft,
  onDraft,
  onCommit,
}: {
  canCommit: boolean
  draft: string
  onDraft: (text: string) => void
  onCommit: () => void
}): JSX.Element {
  const t = useDict().git
  return (
    <section className="commit">
      <Textarea
        className="message"
        value={draft}
        placeholder={t.commitPlaceholder}
        aria-label={t.commitPlaceholder}
        onChange={(e) => onDraft(e.target.value)}
        onInput={(e) => onDraft(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || !canCommit) return
          e.preventDefault()
          onCommit()
        }}
      />
      <div className="commit-bar">
        <span className="muted hint">{fmt(t.commitHint, { keys: COMMIT_KEYS })}</span>
        <Button
          type="button"
          size="sm"
          className="primary"
          disabled={!canCommit}
          onClick={onCommit}
        >
          {t.commit}
        </Button>
      </div>
    </section>
  )
}

export function ChangesPage({
  data,
  draft,
  onDraft,
  onCommit,
  folders,
  handlers,
}: {
  data: GitChangesData
  draft: string
  onDraft: (text: string) => void
  onCommit: () => void
  folders: FolderState
  handlers: ChangeHandlers
}): JSX.Element {
  const t = useDict().git
  return (
    <SplitPane
      splitKey={CHANGES_SPLIT}
      label={t.resizeCommit}
      firstClassName="changes-top"
      secondClassName="changes-files"
      defaultFraction={0}
      minFirst={0}
      minSecond={FILES_MIN}
      first={
        <>
          <header className="head">
            <span className="branch">
              <GitBranchIcon />
              {branchLabel(data.branch, t.detached)}
            </span>
            <Tracking branch={data.branch} />
            <span className="spacer" />
            <ViewToggle />
          </header>
          <div className="muted root" title={data.root}>
            {data.root}
          </div>
          <CommitBox
            canCommit={data.counts.staged > 0 && draft.trim().length > 0}
            draft={draft}
            onDraft={onDraft}
            onCommit={onCommit}
          />
        </>
      }
      second={
        <>
          {data.changes.length === 0 ? <GitEmpty title={t.clean} /> : null}
          <ChangeSections data={data} keyPrefix="" folders={folders} handlers={handlers} />
        </>
      }
    />
  )
}

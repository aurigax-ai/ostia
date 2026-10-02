import { CheckIcon, FilePlusIcon, PencilSimpleLineIcon, XIcon } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { type EditHunk, type HunkDecisions, editHunks, hunkCounts } from '../lib/chatHunks'
import { awaitsReview, canUndo, decideHunk, keepEdit, undoEdit } from '../lib/chatReview'
import { workspaceFolder } from '../lib/chatTools'
import type { ToolPartLike } from '../lib/chatTransport'
import { openFileAt } from '../lib/openFile'
import { cn } from '../lib/utils'
import { langFor } from '../monaco/language'
import { answerApproval, useChatToolsStore } from '../stores/chatToolsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { ToolSection as Section, type ToolState, ToolStatus } from './ai-elements/tool'
import { Button } from './ui/button'

const DIFF_LINES_MAX = 400

export type EditCardState =
  | 'preparing'
  | 'pending'
  | 'applied'
  | 'auto'
  | 'undone'
  | 'rejected'
  | 'failed'
  | 'stopped'

const STATUS_ICON: Record<EditCardState, ToolState> = {
  preparing: 'input-available',
  pending: 'approval-requested',
  applied: 'output-available',
  auto: 'output-available',
  undone: 'output-denied',
  rejected: 'output-denied',
  failed: 'output-error',
  stopped: 'output-denied',
}

const DIFF_TONES = {
  add: 'text-add',
  del: 'text-del',
  ctx: 'text-fg-muted',
  hunk: 'text-fg-muted',
} as const

export function shownPath(path: string, workspaceId: string | null): string {
  const folder = workspaceFolder(workspaceId)
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const NO_DECISIONS: HunkDecisions = []

function HunkLines({ hunk }: { hunk: EditHunk }): JSX.Element {
  const rows = [
    ...hunk.leading.map((text) => ({ kind: 'ctx' as const, text: ` ${text}` })),
    ...hunk.removed.map((text) => ({ kind: 'del' as const, text: `-${text}` })),
    ...hunk.added.map((text) => ({ kind: 'add' as const, text: `+${text}` })),
    ...hunk.trailing.map((text) => ({ kind: 'ctx' as const, text: ` ${text}` })),
  ]
  return (
    <>
      {rows.map((line, i) => (
        <div key={`${i}-${line.kind}`} className={DIFF_TONES[line.kind]} data-diff={line.kind}>
          {line.text}
        </div>
      ))}
    </>
  )
}

function hunkSize(hunk: EditHunk): number {
  return hunk.leading.length + hunk.removed.length + hunk.added.length + hunk.trailing.length
}

export function EditHunks({
  hunks,
  decisions,
  onDecide,
}: {
  hunks: readonly EditHunk[]
  decisions: HunkDecisions
  onDecide: ((index: number, decision: 'accepted' | 'rejected') => void) | null
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools.edit
  if (hunks.length === 0) {
    return <p className="text-fg-muted text-ui-xs">{d.chatTools.diffSame}</p>
  }
  let budget = DIFF_LINES_MAX
  const shown = hunks.filter((hunk) => {
    if (budget <= 0) return false
    budget -= hunkSize(hunk)
    return true
  })
  const hidden = hunks.slice(shown.length).reduce((sum, hunk) => sum + hunkSize(hunk), 0)
  return (
    <div className="flex flex-col gap-1">
      <div
        aria-label="diff"
        className="flex max-h-72 flex-col gap-1 overflow-auto rounded-sm bg-bg-sunken p-2 font-mono text-ui-xs"
      >
        {shown.map((hunk) => {
          const decision = decisions[hunk.index] ?? null
          const label = fmt(t.hunk, { n: hunk.index + 1, line: hunk.oldStart })
          return (
            <section
              key={hunk.index}
              aria-label={label}
              className={cn('flex flex-col', decision === 'rejected' && 'opacity-60')}
              data-hunk={hunk.index}
              data-decision={decision ?? undefined}
            >
              <header className="flex items-center gap-1 font-sans text-fg-muted">
                <span className="flex-1 truncate">{label}</span>
                {decision ? <span>{t.hunkStates[decision]}</span> : null}
                {onDecide ? (
                  <>
                    <IconButton
                      icon={CheckIcon}
                      label={fmt(t.acceptHunk, { n: hunk.index + 1 })}
                      aria-pressed={decision === 'accepted'}
                      onClick={() => onDecide(hunk.index, 'accepted')}
                    />
                    <IconButton
                      icon={XIcon}
                      label={fmt(t.rejectHunk, { n: hunk.index + 1 })}
                      aria-pressed={decision === 'rejected'}
                      onClick={() => onDecide(hunk.index, 'rejected')}
                    />
                  </>
                ) : null}
              </header>
              <pre className="whitespace-pre">
                <HunkLines hunk={hunk} />
              </pre>
            </section>
          )
        })}
      </div>
      {hidden > 0 ? (
        <p className="text-fg-muted text-ui-xs">{fmt(d.chatTools.diffMore, { count: hidden })}</p>
      ) : null}
    </div>
  )
}

export function ChatEditCard({
  part,
  name,
  workspaceId,
  busy,
}: {
  part: ToolPartLike
  name: string
  workspaceId: string | null
  busy: boolean
}): JSX.Element {
  const d = useDict()
  const t = d.chatTools.edit
  const id = part.toolCallId
  const pending = useChatToolsStore((s) => s.pending[id])
  const edit = useChatToolsStore((s) => s.edits[id])
  const choices = useChatToolsStore((s) => s.hunkChoices[id])
  const failure = useChatToolsStore((s) => s.failures[id])
  const output = record(part.output)
  const input = record(part.input)
  const before = pending?.detail.before ?? edit?.before
  const after = pending?.detail.after ?? edit?.after
  const hunks = useMemo(
    () => (before === undefined || after === undefined ? null : editHunks(before, after)),
    [before, after],
  )
  const decisions: HunkDecisions = pending ? (choices ?? NO_DECISIONS) : (edit?.decisions ?? [])
  const path =
    pending?.detail.path ??
    edit?.path ??
    (typeof output.path === 'string' ? output.path : null) ??
    (typeof input.path === 'string' ? input.path : '')
  const created = pending ? pending.detail.exists === false : edit ? !edit.existed : output.created
  const state: EditCardState = pending
    ? 'pending'
    : edit
      ? edit.state === 'undone'
        ? 'undone'
        : edit.auto
          ? 'auto'
          : 'applied'
      : part.state === 'output-available'
        ? 'applied'
        : part.state === 'output-denied'
          ? 'rejected'
          : part.state === 'output-error'
            ? 'failed'
            : busy
              ? 'preparing'
              : 'stopped'
  const counts = hunks ? hunkCounts(hunks, decisions) : null
  const added = counts?.added ?? count(output.added)
  const removed = counts?.removed ?? count(output.removed)
  const reason = pending?.detail.reason
  const shown = shownPath(path, workspaceId)
  const HeadIcon = created === true ? FilePlusIcon : PencilSimpleLineIcon
  const target = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  const undoable = canUndo(edit)
  const reviewing = edit !== undefined && awaitsReview(edit)
  const decidable = (state === 'pending' || undoable) && (hunks?.length ?? 0) > 1
  const openDiff = (): void => {
    if (!target || before === undefined || after === undefined) return
    useUIStore.getState().closePalette()
    useLayoutStore.getState().openDiff(target, {
      title: fmt(t.diffTitle, { name: path.split('/').pop() || path }),
      original: before,
      modified: after,
      language: langFor(path),
      path,
    })
  }
  const failureText =
    state === 'failed'
      ? failure
        ? ((t.failures as Record<string, string>)[failure] ?? t.failures.other)
        : null
      : null
  const undoProblem = edit?.undoError
    ? ((t.undoFailed as Record<string, string>)[edit.undoError] ?? t.undoFailed.other)
    : null
  const notKept = edit !== undefined && edit.state === 'applied' && !undoable
  return (
    <section
      aria-label={fmt(t.card, { path: shown })}
      className="chat-tool chat-edit not-typeset flex w-full flex-col gap-2 rounded-md border border-line bg-surface-1 px-2 py-1.5"
      data-tool={name}
      data-state={state}
      data-edit-call={id}
      data-review={reviewing || state === 'pending' || undefined}
      tabIndex={-1}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <HeadIcon aria-hidden className="size-3.5 shrink-0 text-fg-muted" />
        <Hint label={fmt(t.openFile, { path })}>
          <button
            type="button"
            className="chat-file-link min-w-16 flex-1 truncate text-left"
            onClick={() => {
              useUIStore.getState().closePalette()
              openFileAt(path)
            }}
          >
            <span className="font-mono text-fg text-ui-sm">{shown}</span>
          </button>
        </Hint>
        {created === true ? (
          <span className="shrink-0 text-fg-muted text-ui-xs">{t.created}</span>
        ) : null}
        {added !== null && removed !== null ? (
          <span className="flex shrink-0 gap-1.5 font-mono text-ui-xs tabular-nums">
            <span className="text-add">+{added}</span>
            <span className="text-del">-{removed}</span>
          </span>
        ) : null}
        <ToolStatus state={STATUS_ICON[state]} label={t.states[state]} role="status" />
      </header>
      {reason && reason !== 'ask-mode' ? (
        <p className="text-fg text-ui-xs">{t.reasons[reason]}</p>
      ) : null}
      {hunks ? (
        <EditHunks
          hunks={hunks}
          decisions={decisions}
          onDecide={decidable ? (index, choice) => void decideHunk(id, index, choice) : null}
        />
      ) : null}
      {failureText ? (
        <p role="alert" className="text-attn-fg text-ui-xs">
          {failureText}
        </p>
      ) : null}
      {state === 'failed' && !failureText && part.errorText ? (
        <Section label={d.chatTools.error} code={part.errorText} tone="error" />
      ) : null}
      {undoProblem ? (
        <p role="alert" className="text-attn-fg text-ui-xs">
          {undoProblem}
        </p>
      ) : null}
      {notKept ? <p className="text-fg-muted text-ui-xs">{t.notKept}</p> : null}
      {hunks || reviewing ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {target && hunks ? (
            <Button type="button" variant="ghost" size="sm" onClick={openDiff}>
              {t.openDiff}
            </Button>
          ) : null}
          {state === 'pending' ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => answerApproval(id, { approved: false })}
              >
                {t.reject}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => answerApproval(id, { approved: true, scope: 'once' })}
              >
                {t.accept}
              </Button>
            </>
          ) : null}
          {undoable ? (
            <Button type="button" variant="outline" size="sm" onClick={() => void undoEdit(id)}>
              {t.undo}
            </Button>
          ) : null}
          {reviewing ? (
            <Button type="button" size="sm" onClick={() => keepEdit(id)}>
              {t.keep}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

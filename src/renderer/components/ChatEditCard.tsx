import { FilePlusIcon, PencilSimpleLineIcon } from '@phosphor-icons/react'
import { useMemo } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { type DiffSummary, diffSummary } from '../lib/chatDiff'
import { workspaceFolder } from '../lib/chatTools'
import type { ToolPartLike } from '../lib/chatTransport'
import { openFileAt } from '../lib/openFile'
import { langFor } from '../monaco/language'
import { answerApproval, undoEdit, useChatToolsStore } from '../stores/chatToolsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { Hint } from './Hint'
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

function shownPath(path: string, workspaceId: string | null): string {
  const folder = workspaceFolder(workspaceId)
  return path.startsWith(`${folder}/`) ? path.slice(folder.length + 1) : path
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function EditDiff({ diff }: { diff: DiffSummary }): JSX.Element {
  const d = useDict()
  if (diff.lines.length === 0) {
    return <p className="text-fg-muted text-ui-xs">{d.chatTools.diffSame}</p>
  }
  const shown = diff.lines.slice(0, DIFF_LINES_MAX)
  return (
    <div className="flex flex-col gap-1">
      <pre
        aria-label="diff"
        className="max-h-72 overflow-auto rounded-sm bg-bg-sunken p-2 font-mono text-ui-xs"
      >
        {shown.map((line, i) => (
          <div key={`${i}-${line.kind}`} className={DIFF_TONES[line.kind]} data-diff={line.kind}>
            {line.text || ' '}
          </div>
        ))}
      </pre>
      {diff.lines.length > shown.length ? (
        <p className="text-fg-muted text-ui-xs">
          {fmt(d.chatTools.diffMore, { count: diff.lines.length - shown.length })}
        </p>
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
  const pending = useChatToolsStore((s) => s.pending[part.toolCallId])
  const edit = useChatToolsStore((s) => s.edits[part.toolCallId])
  const failure = useChatToolsStore((s) => s.failures[part.toolCallId])
  const output = record(part.output)
  const input = record(part.input)
  const before = pending?.detail.before ?? edit?.before
  const after = pending?.detail.after ?? edit?.after
  const diff = useMemo(
    () => (before === undefined || after === undefined ? null : diffSummary(before, after)),
    [before, after],
  )
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
  const added = diff?.added ?? count(output.added)
  const removed = diff?.removed ?? count(output.removed)
  const reason = pending?.detail.reason
  const shown = shownPath(path, workspaceId)
  const HeadIcon = created === true ? FilePlusIcon : PencilSimpleLineIcon
  const target = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
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
    ? edit.undoError === 'changed'
      ? t.undoFailed.changed
      : t.undoFailed.other
    : null
  return (
    <section
      aria-label={fmt(t.card, { path: shown })}
      className="chat-tool chat-edit not-typeset flex w-full flex-col gap-2 rounded-md border border-line bg-surface-1 px-2 py-1.5"
      data-tool={name}
      data-state={state}
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
      {diff ? <EditDiff diff={diff} /> : null}
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
      {diff ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {target ? (
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
                onClick={() => answerApproval(part.toolCallId, { approved: false })}
              >
                {t.reject}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => answerApproval(part.toolCallId, { approved: true, scope: 'once' })}
              >
                {t.accept}
              </Button>
            </>
          ) : null}
          {state === 'applied' || state === 'auto' ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void undoEdit(part.toolCallId)}
            >
              {t.undo}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

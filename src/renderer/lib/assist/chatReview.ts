import { saveSession } from '@/stores/assist/chatStore'
import {
  type ChatEditRecord,
  type PendingApproval,
  answerApproval,
  nextSeq,
  useChatToolsStore,
} from '@/stores/assist/chatToolsStore'
import type { ChatFsResult, ChatRestoreOutput } from '@shared/assist/chatTools'
import { type HunkDecision, allDecided, contentWith, editHunks } from './chatHunks'
import { dirtyPaths } from './chatTools'

export const EDIT_TOOLS: ReadonlySet<string> = new Set(['edit_file', 'write_file'])

export interface ReviewItem {
  toolCallId: string
  path: string
  pending: boolean
}

const busy = new Set<string>()

export function restoreFile(
  edit: Pick<ChatEditRecord, 'path' | 'root' | 'outside' | 'symlink'>,
  expected: string | null,
  content: string | null,
  check = false,
): Promise<ChatFsResult<ChatRestoreOutput>> {
  return window.ostia.chatTools
    .restore({
      path: edit.path,
      root: edit.root,
      outside: edit.outside,
      symlinks: edit.symlink,
      expected,
      content,
      dirty: dirtyPaths(),
      ...(check ? { check: true } : {}),
    })
    .catch(() => ({ ok: false as const, error: 'failed' as const }))
}

export function canUndo(edit: ChatEditRecord | undefined): edit is ChatEditRecord {
  return edit?.state === 'applied' && edit.before !== undefined && edit.after !== undefined
}

export function awaitsReview(edit: ChatEditRecord): boolean {
  return edit.state === 'applied' && edit.decisions.some((d) => d === null)
}

function commit(edit: ChatEditRecord, patch: Partial<ChatEditRecord>): void {
  const { undoError: _cleared, ...rest } = edit
  const store = useChatToolsStore.getState()
  store.recordEdit({ ...rest, ...patch, seq: nextSeq(edit.sessionId) })
  if (patch.version !== undefined) store.setVersion(edit.sessionId, edit.path, patch.version)
  void saveSession(edit.sessionId)
}

function failed(edit: ChatEditRecord, error: ChatEditRecord['undoError']): void {
  useChatToolsStore.getState().recordEdit({ ...edit, undoError: error })
}

async function once(toolCallId: string, work: () => Promise<void>): Promise<void> {
  if (busy.has(toolCallId)) return
  busy.add(toolCallId)
  try {
    await work()
  } finally {
    busy.delete(toolCallId)
  }
}

export function undoEdit(toolCallId: string): Promise<void> {
  return once(toolCallId, async () => {
    const edit = useChatToolsStore.getState().edits[toolCallId]
    if (!canUndo(edit)) return
    const res = await restoreFile(edit, edit.version, edit.existed ? (edit.before ?? '') : null)
    if (!res.ok) failed(edit, res.error)
    else commit(edit, { state: 'undone', version: res.version })
  })
}

async function rewrite(edit: ChatEditRecord, decisions: (HunkDecision | null)[]): Promise<void> {
  const before = edit.before ?? ''
  const after = edit.after ?? ''
  const now = contentWith(before, after, edit.decisions)
  const next = contentWith(before, after, decisions)
  const allRejected = decisions.length > 0 && decisions.every((d) => d === 'rejected')
  if (next === now) {
    commit(edit, { decisions, ...(allRejected ? { state: 'undone' as const } : {}) })
    return
  }
  const res = await restoreFile(edit, edit.version, allRejected && !edit.existed ? null : next)
  if (!res.ok) {
    failed(edit, res.error)
    return
  }
  commit(edit, {
    decisions,
    version: res.version,
    ...(allRejected ? { state: 'undone' as const } : {}),
  })
}

function pendingHunks(pending: PendingApproval): number {
  return editHunks(pending.detail.before ?? '', pending.detail.after ?? '').length
}

export function decideHunk(
  toolCallId: string,
  index: number,
  decision: HunkDecision,
): Promise<void> {
  const store = useChatToolsStore.getState()
  const pending = store.pending[toolCallId]
  if (pending) {
    store.chooseHunk(toolCallId, index, decision)
    const choices = useChatToolsStore.getState().hunkChoices[toolCallId] ?? []
    if (allDecided(pendingHunks(pending), choices)) {
      answerApproval(
        toolCallId,
        choices.includes('accepted') ? { approved: true, scope: 'once' } : { approved: false },
      )
    }
    return Promise.resolve()
  }
  return once(toolCallId, async () => {
    const edit = useChatToolsStore.getState().edits[toolCallId]
    if (!canUndo(edit) || index >= edit.decisions.length) return
    const decisions = [...edit.decisions]
    decisions[index] = decision
    await rewrite(edit, decisions)
  })
}

export function keepEdit(toolCallId: string): void {
  const edit = useChatToolsStore.getState().edits[toolCallId]
  if (!edit || !awaitsReview(edit)) return
  commit(edit, { decisions: edit.decisions.map((d) => d ?? 'accepted') })
}

export function reviewItems(
  sessionId: string,
  pending: Readonly<Record<string, PendingApproval>>,
  edits: Readonly<Record<string, ChatEditRecord>>,
): ReviewItem[] {
  const applied = Object.values(edits)
    .filter((e) => e.sessionId === sessionId && awaitsReview(e))
    .sort((a, b) => a.seq - b.seq)
    .map((e) => ({ toolCallId: e.toolCallId, path: e.path, pending: false }))
  const waiting = Object.values(pending)
    .filter((p) => p.sessionId === sessionId && EDIT_TOOLS.has(p.toolName))
    .map((p) => ({ toolCallId: p.toolCallId, path: p.detail.path ?? '', pending: true }))
  return [...applied, ...waiting]
}

export function acceptAll(items: readonly ReviewItem[]): void {
  for (const item of items) {
    if (item.pending) answerApproval(item.toolCallId, { approved: true, scope: 'once' })
    else keepEdit(item.toolCallId)
  }
}

export async function rejectAll(items: readonly ReviewItem[]): Promise<void> {
  for (const item of items) {
    if (item.pending) answerApproval(item.toolCallId, { approved: false })
  }
  const { edits } = useChatToolsStore.getState()
  const applied = items
    .filter((i) => !i.pending)
    .map((i) => edits[i.toolCallId])
    .filter((e): e is ChatEditRecord => e !== undefined)
    .sort((a, b) => b.seq - a.seq)
  for (const edit of applied) await undoEdit(edit.toolCallId)
}

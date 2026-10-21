import { parseEdits } from '@shared/assist/chatEdits'
import {
  type BuiltinChatTool,
  CHAT_DIRTY_PATHS_MAX,
  type ChatFsFailure,
} from '@shared/assist/chatTools'
import { knownVersion, nextSeq, useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { useEditorStatus } from '@/stores/files/editorStatusStore'
import { contentWith, editHunks, hunkCounts, settle } from './chatHunks'
import {
  DENIED,
  fsError,
  gate,
  pathOf,
  readsOutside,
  type ToolOutcome,
  type ToolRun,
} from './chatToolGate'

function writeFailure(run: ToolRun, failure: ChatFsFailure, path: string): ToolOutcome {
  useChatToolsStore.getState().recordFailure(run.toolCallId, failure.error)
  return fsError(failure, path)
}

function isRepositoryPath(path: string): boolean {
  return path.split('/').includes('.git')
}

function changedSinceRead(run: ToolRun, path: string, version: string | null): boolean {
  const known = knownVersion(run.sessionId, path)
  return known !== null && known !== version
}

export function dirtyPaths(): string[] {
  const { dirty } = useEditorStatus.getState()
  return Object.keys(dirty)
    .filter((path) => dirty[path])
    .slice(0, CHAT_DIRTY_PATHS_MAX)
}

interface PlannedWrite {
  path: string
  existed: boolean
  before: string
  after: string
  base: string | null
  outside: boolean
  symlink: boolean
  unsaved: boolean
}

function partialNote(rejected: number, total: number): string {
  return `The user rejected ${rejected} of ${total} changes, so the file differs from what you proposed. Read it again before editing it.`
}

async function applyWrite(
  name: BuiltinChatTool,
  input: Record<string, unknown>,
  run: ToolRun,
  plan: PlannedWrite,
): Promise<ToolOutcome> {
  const answer = await gate(
    run,
    {
      name,
      access: 'write',
      outside: plan.outside,
      symlink: plan.symlink,
      unsaved: plan.unsaved,
      repository: isRepositoryPath(plan.path),
    },
    input,
    { path: plan.path, exists: plan.existed, before: plan.before, after: plan.after },
  )
  const store = useChatToolsStore.getState()
  const chosen = store.hunkChoices[run.toolCallId] ?? []
  store.clearHunks(run.toolCallId)
  if (answer && !answer.approved) return DENIED
  const hunks = editHunks(plan.before, plan.after)
  const decisions = answer ? settle(hunks.length, chosen) : hunks.map(() => null)
  const content = answer ? contentWith(plan.before, plan.after, decisions) : plan.after
  if (hunks.length > 0 && decisions.every((d) => d === 'rejected')) return DENIED
  const res = await window.ostia.chatTools.write({
    path: plan.path,
    root: run.root,
    outside: plan.outside,
    symlinks: plan.symlink,
    content,
    base: plan.base,
  })
  if (!res.ok) return writeFailure(run, res, plan.path)
  store.recordEdit({
    toolCallId: run.toolCallId,
    sessionId: run.sessionId,
    path: res.path,
    root: run.root,
    existed: plan.existed,
    before: plan.before,
    after: plan.after,
    version: res.version,
    outside: plan.outside,
    symlink: plan.symlink,
    auto: answer === null,
    state: 'applied',
    seq: nextSeq(run.sessionId),
    decisions,
  })
  store.setVersion(run.sessionId, res.path, res.version)
  const { added, removed } = hunkCounts(hunks, decisions)
  const rejected = decisions.filter((d) => d === 'rejected').length
  const output = { path: res.path, created: res.created, added, removed }
  return {
    state: 'done',
    output:
      rejected > 0
        ? { ...output, rejectedChanges: rejected, note: partialNote(rejected, hunks.length) }
        : output,
  }
}

export async function editFile(input: Record<string, unknown>, run: ToolRun): Promise<ToolOutcome> {
  const edits = parseEdits(input)
  if (!edits) {
    return { state: 'error', error: 'edits must be a list of {old_text, new_text} replacements' }
  }
  const path = pathOf(input, run)
  const call = (outside: boolean) =>
    window.ostia.chatTools.plan({ path, root: run.root, edits, outside, dirty: dirtyPaths() })
  let plan = await call(readsOutside(run.sessionId))
  if (!plan.ok && plan.error === 'outside-folder') {
    const answer = await gate(run, { name: 'edit_file', access: 'read', outside: true }, input, {
      path,
    })
    if (answer && !answer.approved) return DENIED
    plan = await call(true)
  }
  if (!plan.ok) return writeFailure(run, plan, path)
  if (changedSinceRead(run, plan.path, plan.version)) {
    return writeFailure(run, { ok: false, error: 'changed' }, plan.path)
  }
  return applyWrite('edit_file', input, run, {
    path: plan.path,
    existed: true,
    before: plan.before,
    after: plan.after,
    base: plan.version,
    outside: plan.outside,
    symlink: plan.symlink,
    unsaved: plan.unsaved,
  })
}

export async function writeFile(
  input: Record<string, unknown>,
  run: ToolRun,
): Promise<ToolOutcome> {
  if (typeof input.content !== 'string') return { state: 'error', error: 'content is required' }
  const path = pathOf(input, run)
  const preview = await window.ostia.chatTools.preview({
    path,
    root: run.root,
    dirty: dirtyPaths(),
  })
  if (!preview.ok) return writeFailure(run, preview, path)
  if (preview.exists && changedSinceRead(run, preview.path, preview.version)) {
    return writeFailure(run, { ok: false, error: 'changed' }, preview.path)
  }
  if (preview.exists && preview.text === input.content) {
    return writeFailure(run, { ok: false, error: 'no-change' }, preview.path)
  }
  return applyWrite('write_file', input, run, {
    path: preview.path,
    existed: preview.exists,
    before: preview.text,
    after: input.content,
    base: preview.version,
    outside: preview.outside,
    symlink: preview.symlink,
    unsaved: preview.unsaved,
  })
}

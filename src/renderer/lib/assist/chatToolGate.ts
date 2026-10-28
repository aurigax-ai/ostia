import type { ChatToolSpec } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import type {
  BuiltinChatTool,
  ChatFsError,
  ChatFsFailure,
  ChatFsResult,
} from '@shared/assist/chatTools'
import { resolveLinkPath } from '@shared/files/fileLinks'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  type ApprovalDetail,
  grantsFor,
  modeFor,
  requestApproval,
  standingGrants,
} from '@/stores/assist/chatToolsStore'
import {
  type ApprovalAnswer,
  decideTool,
  readsOutsideUnasked,
  type ToolCheck,
} from './chatToolPermissions'

export type ToolOutcome =
  | { state: 'done'; output: unknown }
  | { state: 'error'; error: string }
  | { state: 'denied' }

export interface ToolRun {
  sessionId: string
  workspaceId: string | null
  root: string
  callId?: string
  toolCallId: string
  signal: AbortSignal
  onApproval: (approvalId: string) => void
  onAnswer: (approvalId: string, approved: boolean) => void
}

export interface ChatToolDef {
  spec: ChatToolSpec
  group: string
  run: (input: Record<string, unknown>, run: ToolRun) => Promise<ToolOutcome>
}
export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : undefined
}

const FS_ERRORS: Record<ChatFsError, string> = {
  'outside-folder': 'That path is outside the workspace folder.',
  'not-allowed': `That path is outside the folders ${PRODUCT_DISPLAY_NAME} may touch.`,
  'not-found': 'No such file or folder.',
  'not-a-file': 'That path is not a regular file.',
  'not-a-directory': 'That path is not a folder.',
  'too-large': 'The file is too large.',
  binary: 'The file is binary, not text.',
  invalid: 'The path, query or edits are invalid.',
  failed: 'The operation failed.',
  changed:
    'The file changed on disk since it was last read; nothing was written. Read it again, then retry.',
  'through-symlink': 'That path goes through a symlink.',
  'no-match':
    'old_text was not found. It must match the file exactly, including whitespace and indentation. Read the file again.',
  ambiguous:
    'old_text matches more than one place. Add surrounding lines so it matches once, or set replace_all.',
  'no-change': 'The edits leave the file unchanged.',
  unsaved: 'The file has unsaved edits in the editor.',
}

function fsErrorText(failure: ChatFsFailure, path: string): string {
  const which = failure.edit === undefined ? '' : `Edit ${failure.edit + 1}: `
  const count = failure.count === undefined ? '' : ` (${failure.count} matches)`
  return `${which}${FS_ERRORS[failure.error]}${count} (${failure.path ?? path})`
}

export function fsError(failure: ChatFsFailure, path: string): ToolOutcome {
  return { state: 'error', error: fsErrorText(failure, path) }
}

export const DENIED: ToolOutcome = { state: 'denied' }

export async function gate(
  run: ToolRun,
  check: Omit<ToolCheck, 'mode' | 'grants' | 'standing' | 'alwaysAsk'>,
  input: Record<string, unknown>,
  shown: ApprovalDetail,
): Promise<ApprovalAnswer | null> {
  const { name } = check
  const decision = decideTool({
    ...check,
    mode: modeFor(run.sessionId),
    grants: grantsFor(run.sessionId),
    standing: standingGrants(),
    alwaysAsk: new Set(useSettingsStore.getState().agent.alwaysAsk),
  })
  if (decision.run) return null
  const detail = decision.reason ? { ...shown, reason: decision.reason } : shown
  const approvalId = `ap-${run.toolCallId}`
  run.onApproval(approvalId)
  const answer = await requestApproval(
    {
      toolCallId: run.toolCallId,
      sessionId: run.sessionId,
      toolName: name,
      kind: decision.kind,
      grantable: decision.grantKey !== null,
      input,
      detail,
    },
    decision,
    run.signal,
  )
  run.onAnswer(approvalId, answer.approved)
  return answer
}

export function readsOutside(sessionId: string): boolean {
  return readsOutsideUnasked({ grants: grantsFor(sessionId), standing: standingGrants() })
}

export function pathOf(input: Record<string, unknown>, run: ToolRun, key = 'path'): string {
  const raw = str(input[key]).trim()
  return resolveLinkPath(raw || '.', run.root)
}

export async function readGated<T>(
  name: BuiltinChatTool,
  input: Record<string, unknown>,
  run: ToolRun,
  path: string,
  call: (outside: boolean) => Promise<ChatFsResult<T>>,
): Promise<ToolOutcome> {
  const outside = readsOutside(run.sessionId)
  let res = await call(outside)
  if (!res.ok && res.error === 'outside-folder') {
    const answer = await gate(run, { name, access: 'read', outside: true }, input, { path })
    if (answer && !answer.approved) return DENIED
    res = await call(true)
  }
  if (!res.ok) return fsError(res, path)
  const { ok: _ok, ...output } = res
  return { state: 'done', output }
}

import {
  type ChatToolAccess,
  READ_OUTSIDE_GRANT,
  isStandingChatGrant,
} from '@shared/assist/chatTools'

export const CHAT_MODES = ['ask', 'write'] as const

export type ChatMode = (typeof CHAT_MODES)[number]

export const DEFAULT_CHAT_MODE: ChatMode = 'ask'

export type ApprovalKind = 'read-outside' | 'act' | 'write' | 'command' | 'mcp'

export type ToolAccess = ChatToolAccess | 'mcp'

export type WriteAskReason = 'ask-mode' | 'outside' | 'symlink' | 'repository' | 'unsaved'

export interface ToolCheck {
  name: string
  access: ToolAccess
  mode: ChatMode
  grants: ReadonlySet<string>
  standing: ReadonlySet<string>
  outside?: boolean
  symlink?: boolean
  repository?: boolean
  unsaved?: boolean
}

export type ToolDecision =
  | { run: true }
  | { run: false; kind: ApprovalKind; grantKey: string | null; reason?: WriteAskReason }

export type ApprovalScope = 'once' | 'chat' | 'always'

export type CommandChoice = 'insert' | 'run'

export type ApprovalAnswer =
  | { approved: false }
  | { approved: true; scope: ApprovalScope; choice?: CommandChoice }

function writeAskReason(check: ToolCheck): WriteAskReason | null {
  if (check.outside) return 'outside'
  if (check.symlink) return 'symlink'
  if (check.repository) return 'repository'
  if (check.unsaved) return 'unsaved'
  return check.mode === 'write' ? null : 'ask-mode'
}

export function decideTool(check: ToolCheck): ToolDecision {
  const { name, access } = check
  const granted = (key: string): boolean => check.grants.has(key) || check.standing.has(key)
  switch (access) {
    case 'read':
      if (!check.outside || granted(READ_OUTSIDE_GRANT)) return { run: true }
      return { run: false, kind: 'read-outside', grantKey: READ_OUTSIDE_GRANT }
    case 'act':
      return granted(name) ? { run: true } : { run: false, kind: 'act', grantKey: name }
    case 'mcp':
      return granted(name) ? { run: true } : { run: false, kind: 'mcp', grantKey: name }
    case 'command':
      return { run: false, kind: 'command', grantKey: null }
    case 'write': {
      const reason = writeAskReason(check)
      return reason ? { run: false, kind: 'write', grantKey: null, reason } : { run: true }
    }
  }
}

export function readsOutsideUnasked(grants: Pick<ToolCheck, 'grants' | 'standing'>): boolean {
  return decideTool({ ...grants, name: '', access: 'read', mode: DEFAULT_CHAT_MODE, outside: true })
    .run
}

export function alwaysGrantAfter(decision: ToolDecision, answer: ApprovalAnswer): string | null {
  if (decision.run || !answer.approved || answer.scope !== 'always') return null
  return isStandingChatGrant(decision.grantKey) ? decision.grantKey : null
}

export function grantsAfter(
  grants: ReadonlySet<string>,
  decision: ToolDecision,
  answer: ApprovalAnswer,
): Set<string> {
  const next = new Set(grants)
  if (!decision.run && decision.grantKey && answer.approved && answer.scope === 'chat') {
    next.add(decision.grantKey)
  }
  return next
}

import type { ChatToolAccess } from '@shared/chatTools'

export const CHAT_MODES = ['ask', 'write'] as const

export type ChatMode = (typeof CHAT_MODES)[number]

export const DEFAULT_CHAT_MODE: ChatMode = 'ask'

export type ApprovalKind = 'read-outside' | 'act' | 'write' | 'command' | 'mcp'

export type ToolAccess = ChatToolAccess | 'mcp'

export const READ_OUTSIDE_GRANT = 'read-outside'

export type WriteAskReason = 'ask-mode' | 'outside' | 'symlink' | 'repository' | 'unsaved'

export interface ToolCheck {
  name: string
  access: ToolAccess
  mode: ChatMode
  grants: ReadonlySet<string>
  outside?: boolean
  symlink?: boolean
  repository?: boolean
  unsaved?: boolean
}

export type ToolDecision =
  | { run: true }
  | { run: false; kind: ApprovalKind; grantKey: string | null; reason?: WriteAskReason }

export type ApprovalScope = 'once' | 'chat'

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
  const { name, access, grants } = check
  switch (access) {
    case 'read':
      if (!check.outside || grants.has(READ_OUTSIDE_GRANT)) return { run: true }
      return { run: false, kind: 'read-outside', grantKey: READ_OUTSIDE_GRANT }
    case 'act':
      return grants.has(name) ? { run: true } : { run: false, kind: 'act', grantKey: name }
    case 'mcp':
      return grants.has(name) ? { run: true } : { run: false, kind: 'mcp', grantKey: name }
    case 'command':
      return { run: false, kind: 'command', grantKey: null }
    case 'write': {
      const reason = writeAskReason(check)
      return reason ? { run: false, kind: 'write', grantKey: null, reason } : { run: true }
    }
  }
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

import type { ChatToolAccess } from '@shared/chatTools'

export type ApprovalKind = 'read-outside' | 'act' | 'write' | 'command' | 'mcp'

export type ToolAccess = ChatToolAccess | 'mcp'

export const READ_OUTSIDE_GRANT = 'read-outside'

export type ToolDecision =
  | { run: true }
  | { run: false; kind: ApprovalKind; grantKey: string | null }

export type ApprovalScope = 'once' | 'chat'

export type CommandChoice = 'insert' | 'run'

export type ApprovalAnswer =
  | { approved: false }
  | { approved: true; scope: ApprovalScope; choice?: CommandChoice }

function confirmKind(name: string): ApprovalKind {
  return name === 'propose_command' ? 'command' : 'write'
}

export function decideTool(
  name: string,
  access: ToolAccess,
  grants: ReadonlySet<string>,
  outside = false,
): ToolDecision {
  switch (access) {
    case 'read':
      if (!outside || grants.has(READ_OUTSIDE_GRANT)) return { run: true }
      return { run: false, kind: 'read-outside', grantKey: READ_OUTSIDE_GRANT }
    case 'act':
      return grants.has(name) ? { run: true } : { run: false, kind: 'act', grantKey: name }
    case 'mcp':
      return grants.has(name) ? { run: true } : { run: false, kind: 'mcp', grantKey: name }
    default:
      return { run: false, kind: confirmKind(name), grantKey: null }
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

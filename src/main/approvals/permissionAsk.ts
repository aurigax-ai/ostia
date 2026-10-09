import {
  PERMISSION_CHOICES,
  type PermissionChoice,
  normalizePermissionAsk,
} from '../../shared/agents/agentPermissions'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { Questions } from './questions'

export interface PermissionAskDeps {
  questions: () => Questions | null
  phoneCanAnswer: () => boolean
}

export interface PermissionAskResult {
  decision: PermissionChoice | null
}

const NO_DECISION: PermissionAskResult = { decision: null }

export async function askPermission(
  params: unknown,
  ctx: Pick<ControlMethodContext, 'identity' | 'conn'>,
  deps: PermissionAskDeps,
): Promise<PermissionAskResult> {
  const current = deps.questions()
  if (!current || !deps.phoneCanAnswer()) return NO_DECISION
  const parsed = normalizePermissionAsk(params)
  if (!parsed) return NO_DECISION
  const ticket = current.ask({
    ...parsed.content,
    permission: parsed.permission,
    externalId: ctx.identity.externalId,
    windowId: ctx.identity.windowId,
    paneId: ctx.identity.paneId,
  })
  if (!ticket.ok) return NO_DECISION
  const closed = ctx.conn.onClose(() => current.withdraw(ticket.id))
  const outcome = await ticket.outcome
  closed.dispose()
  if (outcome.outcome !== 'answered') return NO_DECISION
  const choice = outcome.choices[0]
  return PERMISSION_CHOICES.includes(choice as PermissionChoice)
    ? { decision: choice as PermissionChoice }
    : NO_DECISION
}

export function registerPermissionAsk(deps: PermissionAskDeps): void {
  registerControlMethod('permission.ask', {
    cap: 'drive-self',
    handler: (params, ctx) => askPermission(params, ctx, deps),
  })
}

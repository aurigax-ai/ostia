import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import { approvals } from './approvals'
import { type AuthedConn, connHasCap } from './controlAuth'
import type { PaneIdentity } from './idRegistry'

export function needsElevation(cap: Capability): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, `needs-elevation: ${cap}`)
}

export async function ensureCaps(
  authed: AuthedConn,
  identity: PaneIdentity,
  caps: readonly Capability[],
  action: string,
  detail: string,
): Promise<void> {
  const missing = [...new Set(caps)].filter((cap) => !connHasCap(authed, cap))
  if (missing.length === 0) return
  const approver = approvals()
  if (!approver || identity.kind !== 'pane' || identity.externalId !== authed.externalId) {
    throw needsElevation(missing[0])
  }
  const outcome = await approver.request({
    externalId: authed.externalId,
    windowId: identity.windowId,
    paneId: identity.paneId,
    workspaceId: identity.workspaceId,
    caps: missing,
    action,
    detail,
  })
  if (outcome === 'timeout') {
    throw new ResponseError(ErrorCodes.InvalidRequest, `not-approved: ${missing.join(', ')}`)
  }
  if (outcome === 'deny') {
    throw new ResponseError(ErrorCodes.InvalidRequest, `denied: ${missing.join(', ')}`)
  }
}

import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { type Capability, capabilityRefusalHint } from '../../shared/capabilities'
import { type AuthedConn, capAllowedHere, connHasCap } from '../control/controlAuth'
import type { PaneIdentity } from '../control/idRegistry'
import { approvals } from './approvals'

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
  const fenced = missing.find((cap) => !capAllowedHere(authed, cap))
  if (fenced) throw new ResponseError(ErrorCodes.InvalidRequest, `sandboxed: ${fenced}`)
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
    throw new ResponseError(ErrorCodes.InvalidRequest, `not-approved: ${missing.join(', ')}`, {
      hint: capabilityRefusalHint('not-approved', missing),
    })
  }
  if (outcome === 'deny') {
    throw new ResponseError(ErrorCodes.InvalidRequest, `denied: ${missing.join(', ')}`, {
      hint: capabilityRefusalHint('denied', missing),
    })
  }
}

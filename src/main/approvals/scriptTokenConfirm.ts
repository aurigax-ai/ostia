import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { ScriptTokenScope } from '../../shared/permissions/scriptTokens'
import { fail } from './scriptTokenRequests'
import type { PresenceResult } from './userPresence'

export interface PresenceRequest {
  action: 'generate' | 'regenerate'
  name: string
}

export type UserPresenceCheck = (request: PresenceRequest) => Promise<PresenceResult>

let requireUserPresence: UserPresenceCheck = async () => ({
  ok: false,
  code: 'unavailable',
  detail: 'no user presence check is set up',
})

export function setUserPresenceCheck(check: UserPresenceCheck): void {
  requireUserPresence = check
}

export async function checkUserPresence(request: PresenceRequest): Promise<PresenceResult> {
  try {
    return await requireUserPresence(request)
  } catch (err) {
    return { ok: false, code: 'failed', detail: (err as Error).message }
  }
}

export async function confirmUserPresence(request: PresenceRequest): Promise<void> {
  const what = `${request.action} the script token "${request.name}"`
  const result = await checkUserPresence(request)
  if (!result.ok) {
    throw fail(`presence-${result.code}: could not confirm it is you to ${what} (${result.detail})`)
  }
}

export function describeScope(scope: ScriptTokenScope): string {
  if (scope.kind === 'all') return 'every workspace'
  const parts = [
    ...scope.groups.map((id) => `group ${id}`),
    ...scope.workspaces.map((id) => `workspace ${id}`),
    ...(scope.ownWorkspaces ? ['the workspaces it creates there'] : []),
  ]
  return parts.join(', ')
}

export function describeExpiry(expiresAt: string | null): string {
  return expiresAt === null
    ? 'NEVER expires (warning: it stays valid until revoked)'
    : `expires ${expiresAt}`
}

export function approvalCaps(caps: readonly Capability[], scope: ScriptTokenScope): Capability[] {
  return ['settings-write', ...caps, ...(scope.kind === 'all' ? (['all-workspaces'] as const) : [])]
}

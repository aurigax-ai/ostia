import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { ensureCaps } from '../approvals/controlElevation'
import type { Reach } from '../approvals/reach'
import { connHasCap } from '../control/controlAuth'
import type { ControlMethodContext } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import { type PaneRefDeps, refFailure, resolvePaneRef } from './paneRef'

export function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

export function record(raw: unknown): Record<string, unknown> {
  return isRecord(raw) ? raw : {}
}

export type PaneReach = 'input' | 'read' | 'close' | 'move' | 'message'

export interface ReachFacts {
  caller: { paneId: string; workspaceId: string; sandboxed: boolean }
  target: { paneId: string; workspaceId: string; manager: boolean; confined: boolean }
  ownChild: boolean
  managedBy: boolean
  sameScope: boolean
}

export type ReachVerdict = { allowed: true; caps: Capability[] } | { allowed: false; error: string }

const REACH_CAPS: Readonly<Record<PaneReach, Capability>> = {
  input: 'type-other-pane',
  read: 'read-other-pane',
  close: 'kill-pane',
  move: 'type-other-pane',
  message: 'send-other-pane',
}

function managerReach(kind: PaneReach, facts: ReachFacts): ReachVerdict {
  if (kind !== 'message') return { allowed: false, error: 'unknown-pane' }
  if (facts.caller.sandboxed) return { allowed: false, error: 'sandboxed' }
  return {
    allowed: true,
    caps: facts.managedBy ? ['send-other-pane'] : ['send-other-pane', 'all-workspaces'],
  }
}

export function paneReach(kind: PaneReach, facts: ReachFacts): ReachVerdict {
  const { caller, target } = facts
  if (target.manager) return managerReach(kind, facts)
  if (caller.paneId === target.paneId && kind !== 'close') {
    return kind === 'input' ? { allowed: false, error: 'own-pane' } : { allowed: true, caps: [] }
  }
  const sameWorkspace = caller.workspaceId === target.workspaceId
  if (caller.sandboxed && !(sameWorkspace && target.confined)) {
    return { allowed: false, error: 'sandboxed' }
  }
  const sameScope = sameWorkspace || facts.sameScope
  if (facts.ownChild && sameScope) return { allowed: true, caps: ['process'] }
  return {
    allowed: true,
    caps: [REACH_CAPS[kind], ...(sameScope ? [] : (['all-workspaces'] as const))],
  }
}

export interface PaneReachDeps extends PaneRefDeps {
  inScope: Reach['inScope']
  isChild: (ownerPaneId: string, paneId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
  isConfined: (paneId: string) => boolean
}

const REFUSALS: Readonly<Record<string, string>> = {
  'own-pane': 'own-pane: a pane cannot type into itself',
  sandboxed: SANDBOXED_REFUSAL,
}

export const PANE_REFS_MAX = 32

export function paneRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: panes')
  if (raw.length > PANE_REFS_MAX) throw fail('too-many: panes')
  if (!raw.every((ref) => typeof ref === 'string' && ref)) throw fail('bad-request: panes')
  return [...new Set(raw as string[])]
}

export async function paneTarget(
  deps: PaneRefDeps,
  raw: unknown,
  ctx: ControlMethodContext,
  destructive = false,
): Promise<PaneIdentity> {
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: pane')
  const resolved = await resolvePaneRef(deps, raw, ctx, destructive)
  if ('found' in resolved) return resolved.found
  throw fail(refFailure(raw, resolved))
}

async function reachVerdict(
  deps: Pick<PaneReachDeps, 'inScope' | 'isChild' | 'isSandboxed' | 'isConfined'>,
  kind: PaneReach,
  to: PaneIdentity,
  ctx: ControlMethodContext,
): Promise<ReachVerdict> {
  const me = ctx.identity
  const sandboxed = deps.isSandboxed(me.workspaceId)
  const sameScope = !sandboxed && to.manager !== true && (await deps.inScope(ctx, to.workspaceId))
  return paneReach(kind, {
    caller: {
      paneId: me.paneId,
      workspaceId: me.workspaceId,
      sandboxed,
    },
    target: {
      paneId: to.paneId,
      workspaceId: to.workspaceId,
      manager: to.manager === true,
      confined: deps.isConfined(to.paneId),
    },
    ownChild: deps.isChild(me.paneId, to.paneId),
    managedBy: to.manager === true && deps.isChild(to.paneId, me.paneId),
    sameScope,
  })
}

export async function holdsPaneReach(
  deps: Pick<PaneReachDeps, 'inScope' | 'isChild' | 'isSandboxed' | 'isConfined'>,
  kind: PaneReach,
  to: PaneIdentity,
  ctx: ControlMethodContext,
): Promise<boolean> {
  const verdict = await reachVerdict(deps, kind, to, ctx)
  return verdict.allowed && verdict.caps.every((cap) => connHasCap(ctx.authed, cap))
}

export async function ensurePaneReach(
  deps: Pick<PaneReachDeps, 'inScope' | 'isChild' | 'isSandboxed' | 'isConfined'>,
  kind: PaneReach,
  to: PaneIdentity,
  ctx: ControlMethodContext,
  ask: { ref: string; method: string; detail: string },
): Promise<void> {
  const me = ctx.identity
  const verdict = await reachVerdict(deps, kind, to, ctx)
  if (!verdict.allowed) {
    throw fail(
      verdict.error === 'unknown-pane' ? `unknown-pane: ${ask.ref}` : REFUSALS[verdict.error],
    )
  }
  await ensureCaps(ctx.authed, me, verdict.caps, ask.method, ask.detail)
}

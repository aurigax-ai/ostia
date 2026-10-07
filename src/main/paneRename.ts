import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import type { CommandResult, CommandTarget } from '../shared/types'
import { targetOf } from './attention'
import { ensureCaps } from './controlElevation'
import { registerControlMethod } from './controlServer'
import { type PaneIdentity, resolveExternal, windowOfWorkspace } from './idRegistry'

export const NAME_MAX = 200

export interface PaneRenameDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
}

function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function hasControlCharacter(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

export function cleanName(raw: unknown, field: string): string {
  if (typeof raw !== 'string') throw fail(`bad-request: ${field}`)
  if (hasControlCharacter(raw)) throw fail(`bad-request: ${field} has control characters`)
  const name = raw.trim()
  if (name.length > NAME_MAX) throw fail(`too-long: ${field} (max ${NAME_MAX})`)
  return name
}

export function renameCaps(self: boolean, sameWorkspace: boolean): Capability[] {
  if (self) return ['drive-self']
  return sameWorkspace ? ['send-other-pane'] : ['send-other-pane', 'all-workspaces']
}

function targetPane(raw: unknown, me: PaneIdentity): PaneIdentity {
  if (raw === undefined) return me
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: pane')
  const found = resolveExternal(raw)
  if (found?.kind !== 'pane' || (found.manager && found !== me)) {
    throw fail(`unknown-pane: ${raw}`)
  }
  return found
}

async function run(
  deps: PaneRenameDeps,
  target: CommandTarget,
  id: string,
  args: unknown,
): Promise<void> {
  const res = await deps.execCommand(target, id, args)
  if (!res.ok) throw fail(`${res.error.code}: ${res.error.message}`)
}

export function registerPaneRenameMethods(deps: PaneRenameDeps): void {
  registerControlMethod('pane.rename', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const title = cleanName(p.title, 'title')
      const me = ctx.identity
      if (me.kind === 'script' && p.pane === undefined) throw fail('bad-request: pane')
      const to = targetPane(p.pane, me)
      const caps = renameCaps(to === me, to.workspaceId === me.workspaceId)
      const detail = title
        ? `rename ${to.externalId} to ${JSON.stringify(title)}`
        : `let ${to.externalId} take its title from the program again`
      await ensureCaps(ctx.authed, me, caps, 'pane.rename', detail)
      await run(deps, targetOf(to), 'pane.rename', { title })
      return { ok: true, paneId: to.externalId, title }
    },
  })

  registerControlMethod('workspace.rename', {
    handler: async (raw, ctx) => {
      const p = record(raw)
      const name = cleanName(p.name, 'name')
      const me = ctx.identity
      if (p.workspace !== undefined && (typeof p.workspace !== 'string' || !p.workspace)) {
        throw fail('bad-request: workspace')
      }
      const workspaceId = (p.workspace as string | undefined) ?? me.workspaceId
      const windowId = workspaceId ? windowOfWorkspace(workspaceId) : undefined
      if (!workspaceId || !windowId) throw fail(`unknown-workspace: ${workspaceId}`)
      const self = workspaceId === me.workspaceId
      const detail = name
        ? `rename workspace ${workspaceId} to ${JSON.stringify(name)}`
        : `reset the name of workspace ${workspaceId}`
      await ensureCaps(ctx.authed, me, renameCaps(self, self), 'workspace.rename', detail)
      await run(deps, { windowId, workspaceId, paneId: null }, 'workspace.rename', { name })
      return { ok: true, workspaceId, name }
    },
  })
}

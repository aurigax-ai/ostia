import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import { ensureCaps } from '../approvals/controlElevation'
import type { Reach } from '../approvals/reach'
import { targetOf } from '../attention/attention'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { fail, paneTarget, record } from './paneReach'
import type { PaneRefDeps } from './paneRef'

const NAME_MAX = 200

export interface PaneRenameDeps {
  processPane: PaneRefDeps['processPane']
  isSandboxed: PaneRefDeps['isSandboxed']
  isConfined: PaneRefDeps['isConfined']
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  reach: Pick<Reach, 'inScope' | 'visible'>
  windowOfWorkspace: (workspaceId: string) => string | undefined
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

export function renameCaps(self: boolean, sameScope: boolean): Capability[] {
  if (self) return ['drive-self']
  return sameScope ? ['send-other-pane'] : ['send-other-pane', 'all-workspaces']
}

async function targetPane(
  deps: PaneRefDeps,
  raw: unknown,
  me: PaneIdentity,
  ctx: ControlMethodContext,
): Promise<PaneIdentity> {
  if (raw === undefined) return me
  const found = await paneTarget(deps, raw, ctx)
  if (found.manager && found !== me) throw fail(`unknown-pane: ${raw}`)
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
      const to = await targetPane(
        {
          processPane: deps.processPane,
          visible: deps.reach.visible,
          isSandboxed: deps.isSandboxed,
          isConfined: deps.isConfined,
        },
        p.pane,
        me,
        ctx,
      )
      const caps =
        to === me
          ? renameCaps(true, true)
          : renameCaps(false, await deps.reach.inScope(ctx, to.workspaceId))
      const detail = title
        ? `rename ${to.externalId} to ${JSON.stringify(title)}`
        : `let ${to.externalId} take its title from the program again`
      await ensureCaps(ctx.authed, me, caps, 'pane.rename', detail)
      await run(deps, targetOf(to), 'pane.rename', { title })
      return { ok: true, paneId: to.externalId, title }
    },
  })

  registerControlMethod('workspace.rename', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const name = cleanName(p.name, 'name')
      const me = ctx.identity
      const missing = me.kind === 'script' && p.workspace === undefined
      if (
        missing ||
        (p.workspace !== undefined && (typeof p.workspace !== 'string' || !p.workspace))
      ) {
        throw fail('bad-request: workspace')
      }
      const workspaceId = (p.workspace as string | undefined) ?? me.workspaceId
      const windowId = workspaceId ? deps.windowOfWorkspace(workspaceId) : undefined
      if (!workspaceId || !windowId) throw fail(`unknown-workspace: ${workspaceId}`)
      const self = workspaceId === me.workspaceId
      const detail = name
        ? `rename workspace ${workspaceId} to ${JSON.stringify(name)}`
        : `reset the name of workspace ${workspaceId}`
      const caps = self
        ? renameCaps(true, true)
        : renameCaps(false, await deps.reach.inScope(ctx, workspaceId))
      await ensureCaps(ctx.authed, me, caps, 'workspace.rename', detail)
      await run(deps, { windowId, workspaceId, paneId: null }, 'workspace.rename', { name })
      return { ok: true, workspaceId, name }
    },
  })
}

import { WAKE_WAIT_MAX_MS } from '../../shared/extensions'
import { ensureCaps } from '../approvals/controlElevation'
import { registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { type PaneIoDeps, checkSessions, notHibernated, sessionConflict } from './paneIo'

export type ExtensionWakeDeps = Pick<PaneIoDeps, 'hibernated' | 'wake' | 'panes' | 'waking'> & {
  openedBy: (caller: PaneIdentity, paneId: string) => boolean
}

function waitMsOf(raw: unknown): number | null | 'bad' {
  if (raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 'bad'
  return Math.min(Math.round(raw), WAKE_WAIT_MAX_MS)
}

function codeOf(err: unknown): { ok: false; error: string; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: message.split(':')[0] ?? 'failed', message }
}

export function registerExtensionWake(deps: ExtensionWakeDeps): void {
  registerControlMethod('ext.wakePane', {
    callers: 'extensions',
    cap: 'type-other-pane',
    handler: async (raw, ctx) => {
      const p = (raw ?? {}) as { paneId?: unknown; waitMs?: unknown }
      const waitMs = waitMsOf(p.waitMs)
      if (waitMs === 'bad')
        return { ok: false, error: 'invalid-params', message: 'waitMs is a positive number' }
      await ensureCaps(
        ctx.authed,
        ctx.identity,
        ['all-workspaces'],
        'ext.wakePane',
        `wake ${String(p.paneId)}`,
      )
      const found = typeof p.paneId === 'string' ? resolveExternal(p.paneId) : undefined
      if (found?.kind !== 'pane' || found.manager) {
        return { ok: false, error: 'unknown-pane', message: 'no open pane has that id' }
      }
      if (!deps.openedBy(ctx.identity, found.externalId)) {
        return {
          ok: false,
          error: 'not-reached',
          message:
            'ext.wakePane is only for a pane you opened with ext.runAgent or ext.openTerminal',
        }
      }
      const to: PaneIdentity = found
      try {
        if (!(await deps.hibernated(to))) throw notHibernated(to)
        checkSessions([to], await deps.panes())
        const outcome = await deps.wake(to)
        if (outcome.conflict) throw sessionConflict(to, `"${outcome.conflict}"`)
        if (!outcome.woke) throw notHibernated(to)
      } catch (err) {
        return codeOf(err)
      }
      deps.waking.start(to.paneId)
      if (waitMs === null) return { ok: true, outcome: 'woke' }
      const ended = await deps.waking.until([to.paneId], waitMs, (cancel) =>
        ctx.conn.onClose(cancel),
      )
      if (ended.how === 'started') return { ok: true, outcome: 'started' }
      if (ended.how === 'timeout') return { ok: true, outcome: 'timedOut' }
      if (ended.how === 'closed') return { ok: true, outcome: 'closed' }
      return { ok: true, outcome: 'resume-failed' }
    },
  })
}

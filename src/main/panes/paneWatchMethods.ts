import { actThenConfirm, confirmed, mismatch } from '../../shared/common/actThenConfirm'
import { unwatchPanes, watchesOf, watchPane } from '../agents/busStore'
import { registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { WATCH_UNTIL, WATCH_UNTIL_DEFAULT, type WatchUntil } from './paneEvents'
import {
  ensurePaneReach,
  fail,
  type PaneReachDeps,
  paneRefs,
  paneTarget,
  record,
} from './paneReach'

const WATCHES_MAX = 32

function untilParam(raw: unknown): WatchUntil[] {
  if (raw === undefined) return [...WATCH_UNTIL_DEFAULT]
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: until')
  for (const state of raw) {
    if (!(WATCH_UNTIL as readonly unknown[]).includes(state)) {
      throw fail(`bad-request: until ${String(state)} (known: ${WATCH_UNTIL.join(', ')})`)
    }
  }
  return [...new Set(raw as WatchUntil[])]
}

export function registerPaneWatchMethods(deps: PaneReachDeps): void {
  registerControlMethod('pane.watch', {
    handler: async (raw, ctx) => {
      const p = record(raw)
      const me = ctx.identity.externalId
      if (p.off !== undefined && typeof p.off !== 'boolean') throw fail('bad-request: off')
      if (p.off === true) {
        const named = p.panes === undefined ? undefined : paneRefs(p.panes)
        const targets: string[] | undefined = named
          ? await Promise.all(
              named.map(async (ref) => (await paneTarget(deps, ref, ctx)).externalId),
            )
          : undefined
        unwatchPanes(me, targets)
        return { watching: watchesOf(me).map(watchView) }
      }
      const refs = paneRefs(p.panes)
      const until = untilParam(p.until)
      const targets: { ref: string; to: PaneIdentity }[] = []
      for (const ref of refs) targets.push({ ref, to: await paneTarget(deps, ref, ctx) })
      for (const { ref, to } of targets) {
        if (to.externalId === me) throw fail('bad-request: a pane cannot watch itself')
        await ensurePaneReach(deps, 'read', to, ctx, {
          ref,
          method: 'pane.watch',
          detail: `watch ${to.externalId}: its state changes arrive as mail`,
        })
      }
      const existing = watchesOf(me)
      const fresh = targets.filter(({ to }) => !existing.some((w) => w.watched === to.externalId))
      if (existing.length + fresh.length > WATCHES_MAX) throw fail('too-many: watches')
      const seen = await actThenConfirm({
        act: () => {
          for (const { to } of targets) watchPane(me, to.externalId, until)
        },
        observe: () => {
          const held = watchesOf(me)
          const missing = targets.find(({ to }) => !held.some((w) => w.watched === to.externalId))
          return missing
            ? mismatch(`not-watching: ${missing.to.externalId} is not on your watch list`)
            : confirmed(held.map(watchView))
        },
        signal: () => () => {},
        timeoutMs: 0,
        onTimeout: () => mismatch('not-watching: the watch list did not change'),
      })
      if (!seen.ok) throw fail(seen.reason)
      return { watching: seen.value }
    },
  })
}

function watchView(watch: { watched: string; until: string[] }) {
  return {
    pane: watch.watched,
    until: watch.until,
    open: resolveExternal(watch.watched)?.kind === 'pane',
  }
}

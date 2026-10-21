import { getByPaneId } from '../../control/idRegistry'
import type { AppLog } from '../../diagnostics/appLog'
import { orphanVerdict, planRecovery, type ReapReason, RecoveryBook } from '../ptyReaper'
import type { PtyEntry } from './ptyRegistry'

interface PtyRecoveryDeps {
  ptys: Map<string, PtyEntry>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
  closedPanes: Set<string>
  killPty: (paneId: string, reason: ReapReason) => void
  appLog: () => AppLog | null
}

export function createPtyRecovery({
  ptys,
  movingPanes,
  recoveryHeld,
  closedPanes,
  killPty,
  appLog,
}: PtyRecoveryDeps) {
  const recovery = new RecoveryBook()

  function windowOfPane(paneId: string): string | undefined {
    return getByPaneId(paneId)?.windowId
  }

  function scheduleReap(paneId: string, entry: PtyEntry): void {
    if (entry.killTimer) clearTimeout(entry.killTimer)
    entry.killTimer = setTimeout(
      () => reapIfOrphaned(paneId, entry),
      recovery.graceFor(windowOfPane(paneId)),
    )
  }

  function reapIfOrphaned(paneId: string, entry: PtyEntry): void {
    entry.killTimer = null
    const verdict = orphanVerdict({
      current: ptys.get(paneId) === entry,
      owners: entry.session.ownerCount,
      moving: movingPanes.has(paneId) || entry.keepAlive,
      held: recoveryHeld.has(paneId),
      recovering: recovery.isRecovering(windowOfPane(paneId)),
    })
    if (verdict === 'wait') scheduleReap(paneId, entry)
    else if (verdict === 'reap')
      killPty(paneId, closedPanes.has(paneId) ? 'closed' : 'grace-expired')
  }

  function startRecovery(windowId: string, reason: string): void {
    recovery.start(windowId)
    appLog()?.info('window-recovering', { window: windowId, reason })
    for (const [paneId, entry] of ptys) {
      if (entry.killTimer && windowOfPane(paneId) === windowId) scheduleReap(paneId, entry)
    }
  }

  function finishRecovery(windowId: string, livePaneIds: Set<string>): void {
    if (!recovery.end(windowId)) return
    const windowPtys = [...ptys]
      .filter(([paneId, entry]) => !entry.keepAlive && windowOfPane(paneId) === windowId)
      .map(([paneId, entry]) => ({ paneId, owners: entry.session.ownerCount }))
    const { hold, reap } = planRecovery(windowPtys, livePaneIds)
    for (const paneId of hold) {
      const entry = ptys.get(paneId)
      if (entry?.killTimer) clearTimeout(entry.killTimer)
      if (entry) entry.killTimer = null
      recoveryHeld.add(paneId)
    }
    for (const paneId of reap) killPty(paneId, 'closed')
    appLog()?.info('window-recovered', { window: windowId, held: hold.length, reaped: reap.length })
  }

  function releaseWindowPtys(windowId: string): void {
    recovery.end(windowId)
    for (const paneId of [...recoveryHeld]) {
      if (windowOfPane(paneId) !== windowId) continue
      recoveryHeld.delete(paneId)
      const entry = ptys.get(paneId)
      if (entry && entry.session.ownerCount === 0) scheduleReap(paneId, entry)
    }
  }

  function holdPtys(paneIds: readonly string[]): void {
    for (const paneId of paneIds) {
      const entry = ptys.get(paneId)
      if (!entry) continue
      movingPanes.add(paneId)
      if (entry.killTimer) {
        clearTimeout(entry.killTimer)
        entry.killTimer = null
      }
    }
  }

  function releaseMovingPane(paneId: string): void {
    if (!movingPanes.delete(paneId)) return
    const entry = ptys.get(paneId)
    if (entry && entry.session.ownerCount === 0) killPty(paneId, 'closed')
  }

  return {
    windowOfPane,
    scheduleReap,
    startRecovery,
    finishRecovery,
    releaseWindowPtys,
    holdPtys,
    releaseMovingPane,
  }
}

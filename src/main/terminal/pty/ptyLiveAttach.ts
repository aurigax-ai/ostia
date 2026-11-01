import type { BrowserWindow } from 'electron'
import type { PtyAttachResult, PtySpawnOptions } from '../../../shared/terminal/ptyApi'
import { shellName } from '../../../shared/terminal/terminalShell'
import { CoalescedOutput } from '../ptyFlow'
import type { Subscriber, SubscriberRole } from '../ptySession'
import type { PtyEntry } from './ptyRegistry'

export const COVERED_REPLAY_MAX = 262_144

interface LiveAttachDeps {
  windows: Map<string, BrowserWindow>
  movingPanes: Set<string>
  recoveryHeld: Set<string>
}

export type LiveAttach = ReturnType<typeof createLiveAttach>

export function createLiveAttach({ windows, movingPanes, recoveryHeld }: LiveAttachDeps) {
  function windowShown(wid: string): boolean {
    const win = windows.get(wid)
    return win !== undefined && !win.isDestroyed() && win.isVisible() && !win.isMinimized()
  }

  function subscriberFor(
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    subId: string,
  ): (entry: PtyEntry) => Subscriber {
    return (entry: PtyEntry): Subscriber => {
      const role: SubscriberRole = opts.role === 'observer' ? 'observer' : 'owner'
      const lane = role === 'owner' ? entry.flow.open(subId, () => windowShown(subId)) : null
      const output = new CoalescedOutput((data) => {
        if (e.sender.isDestroyed()) return
        e.sender.send(`pty:data:${paneId}`, data)
        lane?.sent(data.length)
      })
      let covered: { from: number; skipped: number } | null = null
      const uncover = (): void => {
        if (!covered) return
        const { data } = entry.session.since(covered.from)
        covered = null
        output.push(data)
      }
      return {
        id: subId,
        role,
        send: (data) => {
          if (covered) {
            covered.skipped += data.length
            if (covered.skipped <= COVERED_REPLAY_MAX) return
            uncover()
            covered = { from: entry.session.cursor, skipped: 0 }
            return
          }
          output.push(data)
        },
        flush: () => output.flush(),
        cover: (hidden) => {
          if (!hidden) uncover()
          else if (!covered) covered = { from: entry.session.cursor, skipped: 0 }
        },
        close: () => {
          output.close()
          lane?.close()
        },
      }
    }
  }

  function attachExisting(
    existing: PtyEntry,
    e: Electron.IpcMainInvokeEvent,
    paneId: string,
    opts: PtySpawnOptions,
    mkSub: (entry: PtyEntry) => Subscriber,
  ): PtyAttachResult {
    const subId = String(e.sender.id)
    if (existing.killTimer) {
      clearTimeout(existing.killTimer)
      existing.killTimer = null
    }
    movingPanes.delete(paneId)
    recoveryHeld.delete(paneId)
    existing.subs.set(subId, e.sender)
    existing.session.addLiveSubscriber(mkSub(existing))
    const { data, cursor, dropped, startsBefore } = existing.session.since(opts.sinceCursor ?? 0)
    return {
      created: false,
      buffer: data,
      cursor,
      dropped,
      blockSeqBase: existing.mirror.blockSeqBase + startsBefore,
      shell: shellName(existing.shell) || undefined,
      sandboxed: existing.sandboxed,
      ...(existing.sandboxStamp ? { sandboxStamp: existing.sandboxStamp } : {}),
      ...(existing.kept ? { kept: true } : {}),
      ...(existing.kept && existing.kept.linkState !== 'up'
        ? { link: existing.kept.linkState }
        : {}),
      cols: existing.pty.cols,
      rows: existing.pty.rows,
      ...(existing.hold ? { held: true as const } : {}),
      ...(existing.markNonce ? { markNonce: existing.markNonce } : {}),
    }
  }

  return { subscriberFor, attachExisting }
}

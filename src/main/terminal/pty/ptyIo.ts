import type { MirrorHandle, MirrorSink } from '../../manager/portal'
import { type PaneIo, pastedText } from '../../panes/paneIo'
import type { SubscriberRole } from '../ptySession'
import type { PtyEntry } from './ptyRegistry'

export function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
}

function resizeForAll(paneId: string, entry: PtyEntry, cols: number, rows: number): void {
  if (entry.pty.cols === cols && entry.pty.rows === rows) return
  resizePty(entry, cols, rows)
  for (const wc of entry.subs.values()) {
    if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
  }
}

interface PtyIoDeps {
  ptys: Map<string, PtyEntry>
}

export type PtyIo = ReturnType<typeof createPtyIo>

export function createPtyIo({ ptys }: PtyIoDeps) {
  const paneIo: PaneIo = {
    read: async (paneId, lines) => {
      const entry = ptys.get(paneId)
      return entry ? entry.mirror.screenText(lines) : null
    },
    write: (paneId, data) => {
      const entry = ptys.get(paneId)
      if (!entry) return false
      const pasted = entry.kept ? pastedText(data) : null
      if (entry.kept && pasted !== null) entry.kept.paste(pasted)
      else entry.pty.write(data)
      return true
    },
    bracketedPaste: (paneId) => {
      const entry = ptys.get(paneId)
      if (!entry) return false
      return entry.kept !== null || entry.mirror.bracketedPaste
    },
    outputCursor: (paneId) => ptys.get(paneId)?.session.cursor,
  }

  function releasePtyFlow(subId: string): void {
    for (const entry of ptys.values()) entry.flow.release(subId)
  }

  function hidePtyFlow(wid: string): void {
    for (const entry of ptys.values()) entry.flow.hidden(wid)
  }

  const MIRROR_SUBSCRIBER = 'portal-mirror'

  function attachMirror(paneId: string, sink: MirrorSink): MirrorHandle | null {
    const entry = ptys.get(paneId)
    if (!entry) return null
    const onExit = (code: number): void => sink.exit(code)
    entry.exitListeners.add(onExit)
    entry.session.addSubscriber(
      { id: MIRROR_SUBSCRIBER, role: 'owner', send: (data) => sink.data(data) },
      0,
    )
    return {
      write: (data) => {
        if (ptys.get(paneId) === entry) entry.pty.write(data)
      },
      resize: (cols, rows) => {
        if (ptys.get(paneId) === entry) resizeForAll(paneId, entry, cols, rows)
      },
      detach: () => {
        entry.exitListeners.delete(onExit)
        entry.session.removeSubscriber(MIRROR_SUBSCRIBER)
      },
    }
  }

  function ptyResize(rendererPaneId: string, cols: number, rows: number): void {
    const entry = ptys.get(rendererPaneId)
    if (entry) resizeForAll(rendererPaneId, entry, cols, rows)
  }

  function ptyWrite(rendererPaneId: string, data: string): void {
    ptys.get(rendererPaneId)?.pty.write(data)
  }

  let gwSubSeq = 0

  function attachPhoneObserver(
    rendererPaneId: string,
    opts: {
      sinceCursor?: number
      role?: 'observer' | 'owner'
      sendData: (data: string) => void
    },
  ): { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null {
    const entry = ptys.get(rendererPaneId)
    if (!entry) return null
    const id = `gw-${++gwSubSeq}`
    const role: SubscriberRole = opts.role === 'owner' ? 'owner' : 'observer'
    const { cursor, dropped } = entry.session.addSubscriber(
      { id, role, send: (data) => opts.sendData(data) },
      opts.sinceCursor ?? 0,
    )
    return {
      cursor,
      dropped,
      cols: entry.pty.cols,
      rows: entry.pty.rows,
      detach: () => entry.session.removeSubscriber(id),
    }
  }
  return {
    paneIo,
    releasePtyFlow,
    hidePtyFlow,
    attachMirror,
    ptyResize,
    ptyWrite,
    attachPhoneObserver,
  }
}

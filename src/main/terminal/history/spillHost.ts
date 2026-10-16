import type { SpillSink } from './historySpill'
import { SpillTerminal } from './spillTerminal'

export type BlockEnd = { line: number; endCol: number; exitCode: number }

export type SpillRequest =
  | {
      kind: 'open'
      session: number
      history: number
      cols: number
      rows: number
      end: number
      seqOffset: number
    }
  | { kind: 'write'; session: number; data: string }
  | { kind: 'restore'; session: number; history: string; hold: boolean }
  | { kind: 'resize'; session: number; cols: number; rows: number }
  | { kind: 'tail'; session: number; id: number }
  | { kind: 'pendingEnd'; session: number; seq: number; id: number }
  | { kind: 'close'; session: number }

export type SpillEvent =
  | { kind: 'append'; session: number; text: string; count: number }
  | { kind: 'blockStarted'; session: number; seq: number; start: number; command: string | null }
  | {
      kind: 'blockEnded'
      session: number
      seq: number
      end: number
      endCol: number
      exitCode: number
      command: string | null
    }
  | { kind: 'wipe'; session: number }
  | { kind: 'flush'; session: number }
  | { kind: 'closed'; session: number }
  | { kind: 'reply'; id: number; tail?: string[]; pendingEnd?: BlockEnd | null }

export interface SpillHostPort {
  postMessage(event: SpillEvent): void
  on(type: 'message', listener: (request: SpillRequest) => void): unknown
}

function postingSink(
  port: SpillHostPort,
  session: number,
  ends: Map<number, number>,
  history: number,
): SpillSink {
  return {
    get end() {
      return ends.get(history) ?? 0
    },
    live: true,
    append: (batch) => {
      ends.set(history, (ends.get(history) ?? 0) + batch.length)
      port.postMessage({ kind: 'append', session, text: batch.join('\n'), count: batch.length })
    },
    blockStarted: (seq, start, command) =>
      port.postMessage({ kind: 'blockStarted', session, seq, start, command }),
    blockEnded: (seq, blockEnd, endCol, exitCode, command) =>
      port.postMessage({
        kind: 'blockEnded',
        session,
        seq,
        end: blockEnd,
        endCol,
        exitCode,
        command,
      }),
    wipe: () => port.postMessage({ kind: 'wipe', session }),
    flush: () => port.postMessage({ kind: 'flush', session }),
  }
}

export function serveSpill(port: SpillHostPort): void {
  const sessions = new Map<number, SpillTerminal>()
  const ends = new Map<number, number>()
  port.on('message', (request) => {
    if (request.kind === 'open') {
      if (!ends.has(request.history)) ends.set(request.history, request.end)
      const sink = postingSink(port, request.session, ends, request.history)
      sessions.set(
        request.session,
        new SpillTerminal(request.cols, request.rows, sink, request.seqOffset),
      )
      return
    }
    const spill = sessions.get(request.session)
    switch (request.kind) {
      case 'write':
        spill?.write(request.data)
        return
      case 'restore':
        spill?.restore(request.history, request.hold)
        return
      case 'resize':
        spill?.resize(request.cols, request.rows)
        return
      case 'tail':
        void (spill?.tail() ?? Promise.resolve([])).then((tail) =>
          port.postMessage({ kind: 'reply', id: request.id, tail }),
        )
        return
      case 'pendingEnd':
        void (spill?.pendingEnd(request.seq) ?? Promise.resolve(null)).then((pendingEnd) =>
          port.postMessage({ kind: 'reply', id: request.id, pendingEnd }),
        )
        return
      case 'close':
        sessions.delete(request.session)
        void (spill?.close() ?? Promise.resolve()).then(() =>
          port.postMessage({ kind: 'closed', session: request.session }),
        )
    }
  })
}

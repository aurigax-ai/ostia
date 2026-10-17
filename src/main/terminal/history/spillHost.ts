import type { SpillSink } from './historySpill'
import { SpillTerminal } from './spillTerminal'

export type BlockEnd = { line: number; endCol: number; exitCode: number }

export type SpillRequest =
  | { kind: 'open'; session: number; cols: number; rows: number; end: number; seqOffset: number }
  | { kind: 'write'; session: number; data: Uint8Array; chars: number }
  | { kind: 'resync'; session: number; screen: string }
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
  | { kind: 'parsed'; session: number; chars: number }
  | { kind: 'closed'; session: number; seqEnd: number }
  | { kind: 'reply'; id: number; tail?: string[]; pendingEnd?: BlockEnd | null }

export interface SpillHostPort {
  postMessage(event: SpillEvent): void
  on(type: 'message', listener: (request: SpillRequest) => void): unknown
}

function postingSink(port: SpillHostPort, session: number, start: number): SpillSink {
  let end = start
  return {
    get end() {
      return end
    },
    live: true,
    append: (batch) => {
      end += batch.length
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
  port.on('message', (request) => {
    if (request.kind === 'open') {
      const sink = postingSink(port, request.session, request.end)
      sessions.set(
        request.session,
        new SpillTerminal(request.cols, request.rows, sink, request.seqOffset),
      )
      return
    }
    const spill = sessions.get(request.session)
    switch (request.kind) {
      case 'write': {
        const { session, chars } = request
        const parsed = () => port.postMessage({ kind: 'parsed', session, chars })
        if (spill) spill.write(request.data, parsed)
        else parsed()
        return
      }
      case 'resync':
        spill?.resync(request.screen)
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
        void (spill?.close() ?? Promise.resolve(0)).then((seqEnd) =>
          port.postMessage({ kind: 'closed', session: request.session, seqEnd }),
        )
    }
  })
}

import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { type StreamEvent, lastTurns } from '../../shared/agents/agentStream'
import { codexNotification, codexTurn } from '../../shared/agents/codexStream'
import type { CodexNotice, CodexRpc } from './codexRpc'
import type { StreamSource } from './streamSource'

export interface CodexSourceDeps {
  threadId: string
  connect: (onNotice: CodexNotice) => Promise<CodexRpc>
  closed: () => void
}

const NO_ROLLOUT = /no rollout/i

function turnsOf(response: unknown): unknown[] {
  return isRecord(response) && Array.isArray(response.data) ? [...response.data].reverse() : []
}

function trailingMessageDropped(turn: unknown): unknown {
  if (!isRecord(turn) || turn.status !== 'inProgress' || !Array.isArray(turn.items)) return turn
  const last = turn.items[turn.items.length - 1]
  return isRecord(last) && last.type === 'agentMessage'
    ? { ...turn, items: turn.items.slice(0, -1) }
    : turn
}

export function codexSource({ threadId, connect, closed }: CodexSourceDeps): StreamSource {
  let rpc: CodexRpc | null = null
  let subscribed = false
  let subscribing: Promise<void> | null = null
  let sink: ((events: StreamEvent[]) => void) | null = null
  let buffered: StreamEvent[] = []
  const emitted = new Set<string>()

  const subscribe = (): Promise<void> => {
    if (subscribed || !rpc) return Promise.resolve()
    subscribing ??= rpc
      .request('thread/resume', { threadId, excludeTurns: true })
      .then(() => {
        subscribed = true
      })
      .catch((err: unknown) => {
        if (!(err instanceof Error && NO_ROLLOUT.test(err.message))) throw err
      })
      .finally(() => {
        subscribing = null
      })
    return subscribing
  }

  const fresh = (events: StreamEvent[]): StreamEvent[] =>
    events.filter((event) => {
      const key =
        event.type === 'turn.started'
          ? `turn:${event.turn}`
          : event.type === 'turn.ended'
            ? `end:${event.turn}`
            : (event.type === 'prompt' || event.type === 'tool.result') && !('append' in event)
              ? `${event.type}:${event.id}`
              : null
      if (key === null) return true
      if (emitted.has(key)) return false
      emitted.add(key)
      return true
    })

  const onNotice: CodexNotice = (method, params) => {
    if (method === 'thread/status/changed' && !subscribed) void subscribe().catch(() => {})
    if (!isRecord(params) || params.threadId !== threadId) return
    const events = codexNotification(method, params)
    if (events.length === 0) return
    if (sink) {
      const out = fresh(events)
      if (out.length > 0) sink(out)
    } else {
      buffered.push(...events)
    }
  }

  return {
    backfill: async (turns) => {
      const client = await connect(onNotice)
      rpc = client
      void client.closed.then(() => {
        if (rpc === client) closed()
      })
      await subscribe()
      const response = await client
        .request('thread/turns/list', {
          threadId,
          limit: turns,
          itemsView: 'full',
          sortDirection: 'desc',
        })
        .catch((err: unknown) => {
          if (err instanceof Error && NO_ROLLOUT.test(err.message)) return null
          throw err
        })
      const events = lastTurns(
        fresh(turnsOf(response).flatMap((turn) => codexTurn(trailingMessageDropped(turn)))),
        turns,
      )
      return { events, truncated: false }
    },
    live: (emit) => {
      sink = emit
      const pending = fresh(buffered)
      buffered = []
      if (pending.length > 0) emit(pending)
    },
    close: () => {
      sink = null
      rpc?.close()
      rpc = null
    },
  }
}

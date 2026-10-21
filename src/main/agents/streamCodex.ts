import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { lastTurns, type StreamEnd, type StreamEvent } from '../../shared/agents/agentStream'
import { codexNotification, codexTurn } from '../../shared/agents/codexStream'
import type { CodexNotice, CodexRpc } from './codexRpc'
import type { StreamSource } from './streamSource'

export interface CodexSourceDeps {
  threadId: string
  connect: (onNotice: CodexNotice) => Promise<CodexRpc>
  closed: (reason: StreamEnd) => void
}

const NO_ROLLOUT = /no rollout/i
const RESUBSCRIBE_MS = 1000
const RESUBSCRIBE_MAX = 300

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
  let subscribing: Promise<boolean> | null = null
  let sink: ((events: StreamEvent[]) => void) | null = null
  let buffered: StreamEvent[] = []
  let retry: ReturnType<typeof setTimeout> | null = null
  let attempts = 0
  let shown = 0
  const emitted = new Set<string>()

  const subscribe = (): Promise<boolean> => {
    if (subscribed) return Promise.resolve(true)
    const client = rpc
    if (!client) return Promise.resolve(false)
    subscribing ??= client
      .request('thread/resume', { threadId, excludeTurns: true })
      .then(() => {
        subscribed = true
        return true
      })
      .catch((err: unknown) => {
        if (err instanceof Error && NO_ROLLOUT.test(err.message)) return false
        throw err
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

  const stored = async (client: CodexRpc, turns: number): Promise<StreamEvent[]> => {
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
    return lastTurns(
      fresh(turnsOf(response).flatMap((turn) => codexTurn(trailingMessageDropped(turn)))),
      turns,
    )
  }

  const subscribeLater = (ms = RESUBSCRIBE_MS): void => {
    if (subscribed || retry || !sink) return
    retry = setTimeout(async () => {
      retry = null
      const client = rpc
      if (!client || subscribed) return
      attempts += 1
      const ok = await subscribe().catch(() => false)
      if (!ok) {
        if (attempts >= RESUBSCRIBE_MAX) closed('unavailable')
        else subscribeLater()
        return
      }
      const missed = await stored(client, shown).catch(() => [])
      if (sink && missed.length > 0) sink(missed)
    }, ms)
  }

  const onNotice: CodexNotice = (method, params) => {
    if (method === 'thread/status/changed' && !subscribed && sink) {
      if (retry) clearTimeout(retry)
      retry = null
      subscribeLater(0)
    }
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
      shown = turns
      void client.closed.then(() => {
        if (rpc === client) closed('agent-closed')
      })
      await subscribe()
      return { events: await stored(client, turns), truncated: false }
    },
    live: (emit) => {
      sink = emit
      const pending = fresh(buffered)
      buffered = []
      if (pending.length > 0) emit(pending)
      subscribeLater()
    },
    close: () => {
      sink = null
      if (retry) clearTimeout(retry)
      retry = null
      rpc?.close()
      rpc = null
    },
  }
}

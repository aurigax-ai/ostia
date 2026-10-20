import type { StreamEvent } from '../../shared/agents/agentStream'

const BODY_FIELDS = ['text', 'input', 'output', 'diff'] as const

type Body = (typeof BODY_FIELDS)[number]

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function bodyOf(event: StreamEvent): Body | null {
  for (const field of BODY_FIELDS) {
    if (field in event && typeof (event as Record<string, unknown>)[field] === 'string') {
      return field
    }
  }
  return null
}

function prefixLength(text: string, fits: (piece: string) => boolean): number {
  let low = 1
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(text.slice(0, mid))) low = mid
    else high = mid - 1
  }
  const last = text.charCodeAt(low - 1)
  return low > 1 && last >= 0xd800 && last <= 0xdbff ? low - 1 : low
}

function splitText(event: StreamEvent, field: Body, budget: number): StreamEvent[] {
  const record = event as unknown as Record<string, unknown>
  const text = record[field] as string
  const pieces: StreamEvent[] = []
  let rest = text
  let head = true
  while (rest.length > 0) {
    const shell = head
      ? record
      : { type: record.type, turn: record.turn, id: record.id, append: true }
    const take = prefixLength(rest, (piece) => bytes({ ...shell, [field]: piece }) <= budget)
    pieces.push({ ...shell, [field]: rest.slice(0, take) } as StreamEvent)
    rest = rest.slice(take)
    head = false
  }
  return pieces
}

function splitPlan(event: Extract<StreamEvent, { type: 'plan' }>, budget: number): StreamEvent[] {
  const pieces: StreamEvent[] = []
  let items: typeof event.items = []
  const flush = (): void => {
    if (items.length === 0) return
    pieces.push({ ...event, items, ...(pieces.length > 0 ? { append: true as const } : {}) })
    items = []
  }
  for (const item of event.items) {
    const probe = { ...event, items: [...items, item], append: true }
    if (items.length > 0 && bytes(probe) > budget) flush()
    items.push(item)
  }
  flush()
  return pieces
}

export function splitEvent(event: StreamEvent, budget: number): StreamEvent[] {
  if (bytes(event) <= budget) return [event]
  if (event.type === 'plan') return splitPlan(event, budget)
  const field = bodyOf(event)
  return field ? splitText(event, field, budget) : [event]
}

interface StreamFrame {
  paneId: string
  seq: number
  backfill: boolean
  events: StreamEvent[]
}

function envelope(frame: StreamFrame): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'event',
    params: {
      type: 'agent.stream',
      payload: {
        paneId: frame.paneId,
        seq: frame.seq,
        ...(frame.backfill ? { backfill: true } : {}),
        events: frame.events,
      },
    },
  })
}

export function packFrames(
  paneId: string,
  firstSeq: number,
  backfill: boolean,
  events: readonly StreamEvent[],
  maxBytes: number,
): string[] {
  const empty = envelope({ paneId, seq: firstSeq + 9_999_999, backfill, events: [] })
  const budget = maxBytes - Buffer.byteLength(empty) - 2
  const frames: string[] = []
  let current: StreamEvent[] = []
  let used = 0
  let seq = firstSeq
  const flush = (): void => {
    if (current.length === 0) return
    frames.push(envelope({ paneId, seq, backfill, events: current }))
    seq += 1
    current = []
    used = 0
  }
  for (const event of events) {
    for (const piece of splitEvent(event, budget)) {
      const size = bytes(piece) + 1
      if (used + size > budget) flush()
      current.push(piece)
      used += size
    }
  }
  flush()
  return frames
}

import type { StreamEvent } from '../../shared/agents/agentStream'

const BODY_FIELDS = ['text', 'input', 'output', 'diff', 'target'] as const

type Body = (typeof BODY_FIELDS)[number]

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export class FrameTooLarge extends Error {}

function bodyOf(event: StreamEvent): Body | null {
  const record = event as unknown as Record<string, unknown>
  let longest: Body | null = null
  for (const field of BODY_FIELDS) {
    const value = record[field]
    if (typeof value !== 'string') continue
    if (longest === null || value.length > (record[longest] as string).length) longest = field
  }
  return longest
}

function prefixLength(text: string, maxChars: number, fits: (piece: string) => boolean): number {
  let low = 1
  let high = Math.min(text.length, maxChars)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(text.slice(0, mid))) low = mid
    else high = mid - 1
  }
  const last = text.charCodeAt(low - 1)
  return low > 1 && last >= 0xd800 && last <= 0xdbff ? low - 1 : low
}

function splitText(event: StreamEvent, field: Body, budget: number): StreamEvent[] {
  let head = true
  const record = event as unknown as Record<string, unknown>
  const text = record[field] as string
  const pieces: StreamEvent[] = []
  if (bytes({ ...record, [field]: '' }) > budget) {
    pieces.push(...splitEvent({ ...record, [field]: '' } as StreamEvent, budget))
    head = false
  }
  let rest = text
  while (rest.length > 0) {
    const shell = head
      ? record
      : { type: record.type, turn: record.turn, id: record.id, append: true }
    const take = prefixLength(
      rest,
      budget,
      (piece) => bytes({ ...shell, [field]: piece }) <= budget,
    )
    pieces.push({ ...shell, [field]: rest.slice(0, take) } as StreamEvent)
    rest = rest.slice(take)
    head = false
  }
  return pieces
}

function splitPlan(event: Extract<StreamEvent, { type: 'plan' }>, budget: number): StreamEvent[] {
  const pieces: StreamEvent[] = []
  let items: typeof event.items = []
  const shell = bytes({ ...event, items: [], append: true })
  let size = shell
  const flush = (): void => {
    if (items.length === 0) return
    pieces.push({ ...event, items, ...(pieces.length > 0 ? { append: true as const } : {}) })
    items = []
    size = shell
  }
  for (const item of event.items) {
    const grown = size + bytes(item) + (items.length > 0 ? 1 : 0)
    if (items.length > 0 && grown > budget) flush()
    size += bytes(item) + (items.length > 0 ? 1 : 0)
    items.push(item)
  }
  flush()
  if (pieces.some((piece) => bytes(piece) > budget)) throw new FrameTooLarge('plan item too large')
  return pieces
}

export function splitEvent(event: StreamEvent, budget: number): StreamEvent[] {
  if (bytes(event) <= budget) return [event]
  if (event.type === 'plan') return splitPlan(event, budget)
  const field = bodyOf(event)
  if (!field) throw new FrameTooLarge('event has nothing to split')
  return splitText(event, field, budget)
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
      if (size - 1 > budget) throw new FrameTooLarge('event does not fit a frame')
      if (used + size > budget) flush()
      current.push(piece)
      used += size
    }
  }
  flush()
  return frames
}

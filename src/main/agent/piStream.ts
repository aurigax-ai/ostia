import type { AgentEvent, AgentHistoryEntry } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { lastTurns, STREAM_TURNS_MAX, type StreamEvent } from '../../shared/agents/agentStream'
import type { TurnStepKind } from '../../shared/agents/turnHook'

const KEPT_EVENTS_MAX = 5000

const TOOLS: Record<string, { kind: TurnStepKind; target?: string; input?: string }> = {
  read_file: { kind: 'read', target: 'path' },
  open_file: { kind: 'read', target: 'path' },
  propose_command: { kind: 'command', input: 'command' },
  open_url: { kind: 'web', target: 'url' },
}

function field(input: Record<string, unknown>, name: string | undefined): string | undefined {
  const value = name === undefined ? undefined : input[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export class PiStream {
  private events: StreamEvent[] = []
  private readonly listeners = new Set<(events: StreamEvent[]) => void>()
  private turns = 0
  private turn: string | null = null
  private items = 0
  private text: string | null = null
  private readonly resulted = new Set<string>()

  seed(history: readonly AgentHistoryEntry[]): void {
    for (const entry of history) {
      if (entry.role === 'user') this.prompt(entry.text)
      else {
        const turn = this.begun()
        this.push({ type: 'text', turn, id: this.nextId(), text: entry.text })
      }
    }
    if (this.turn !== null) this.end('done')
  }

  prompt(text: string): void {
    if (this.turn !== null) this.end('interrupted')
    this.turns += 1
    this.turn = `t${this.turns}`
    this.text = null
    this.push({ type: 'turn.started', turn: this.turn })
    this.push({ type: 'prompt', turn: this.turn, id: this.nextId(), text })
  }

  event(event: AgentEvent): void {
    if (event.type === 'text-delta') {
      const turn = this.begun()
      const continued = this.text !== null
      this.text ??= this.nextId()
      this.push(
        {
          type: 'text',
          turn,
          id: this.text,
          text: event.text,
          ...(continued ? { append: true as const } : {}),
        },
        continued,
      )
    } else if (event.type === 'tool-call') {
      this.text = null
      const spec = TOOLS[event.name]
      const target = field(event.input, spec?.target)
      const input =
        field(event.input, spec?.input) ??
        (spec || Object.keys(event.input).length === 0 ? undefined : JSON.stringify(event.input))
      this.push({
        type: 'tool',
        turn: this.begun(),
        id: event.toolCallId,
        kind: spec?.kind ?? 'other',
        name: event.name,
        ...(target ? { target } : {}),
        ...(input ? { input } : {}),
      })
    } else if (event.type === 'tool-done') {
      if (!this.resulted.delete(event.toolCallId)) {
        this.toolResult(event.toolCallId, '', event.isError)
        this.resulted.delete(event.toolCallId)
      }
    } else if (event.type === 'turn-end') {
      if (this.turn !== null) this.end('done')
    } else if (this.turn !== null) {
      this.end('failed')
    }
  }

  toolResult(toolCallId: string, output: string, isError: boolean): void {
    this.resulted.add(toolCallId)
    this.push({
      type: 'tool.result',
      turn: this.begun(),
      id: toolCallId,
      output,
      ...(isError ? { isError: true as const } : {}),
    })
  }

  snapshot(turns: number): StreamEvent[] {
    return lastTurns(this.events, turns).map((event) => ({ ...event }))
  }

  subscribe(listener: (events: StreamEvent[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private begun(): string {
    if (this.turn === null) {
      this.turns += 1
      this.turn = `t${this.turns}`
      this.push({ type: 'turn.started', turn: this.turn })
    }
    return this.turn
  }

  private end(status: 'done' | 'interrupted' | 'failed'): void {
    if (this.turn === null) return
    this.push({ type: 'turn.ended', turn: this.turn, status })
    this.turn = null
    this.text = null
  }

  private nextId(): string {
    this.items += 1
    return `x${this.items}`
  }

  private push(event: StreamEvent, merge = false): void {
    const last = this.events.at(-1)
    if (merge && last?.type === 'text' && event.type === 'text' && last.id === event.id) {
      last.text += event.text
    } else {
      this.events.push({ ...event })
    }
    if (this.events.length > KEPT_EVENTS_MAX) {
      this.events = lastTurns(this.events, STREAM_TURNS_MAX)
      if (this.events.length > KEPT_EVENTS_MAX) this.events = this.events.slice(-KEPT_EVENTS_MAX)
    }
    for (const listener of [...this.listeners]) listener([event])
  }
}

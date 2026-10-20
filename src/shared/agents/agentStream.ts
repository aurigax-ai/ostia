import type { TurnStepKind } from './turnHook'

export const STREAM_TURNS_MAX = 50
export const STREAM_TURNS_DEFAULT = 5

export type StreamAgent = 'claude' | 'codex' | 'pi'

export type PlanStatus = 'pending' | 'active' | 'done'

export interface PlanItem {
  text: string
  status: PlanStatus
}

export type EditChange = 'add' | 'update' | 'delete'

export type TurnEnd = 'done' | 'interrupted' | 'failed'

export type StreamEnd = 'pane-closed' | 'agent-closed'

export type StreamEvent =
  | { type: 'turn.started'; turn: string }
  | { type: 'turn.ended'; turn: string; status: TurnEnd }
  | { type: 'prompt'; turn: string; id: string; text: string; append?: true }
  | { type: 'text'; turn: string; id: string; text: string; append?: true }
  | {
      type: 'tool'
      turn: string
      id: string
      kind: TurnStepKind
      name: string
      target?: string
      input?: string
      append?: true
    }
  | {
      type: 'tool.result'
      turn: string
      id: string
      output: string
      exitCode?: number
      isError?: true
      append?: true
    }
  | {
      type: 'edit'
      turn: string
      id: string
      path: string
      change: EditChange
      diff: string
      append?: true
    }
  | { type: 'plan'; turn: string; id: string; items: PlanItem[]; append?: true }
  | { type: 'session'; session: string }
  | { type: 'ask'; askId: string; kind: string }
  | { type: 'ask.resolved'; askId: string; outcome: string }
  | { type: 'live' }
  | { type: 'ended'; reason: StreamEnd }

export function turnsStarted(events: readonly StreamEvent[]): number {
  return events.filter((event) => event.type === 'turn.started').length
}

export function lastTurns(events: readonly StreamEvent[], turns: number): StreamEvent[] {
  const starts: number[] = []
  events.forEach((event, index) => {
    if (event.type === 'turn.started') starts.push(index)
  })
  const first = starts.length > turns ? starts[starts.length - turns] : 0
  return events.slice(first)
}

import { EventEmitter } from 'node:events'
import type { SessionLiveState } from '../shared/types'

export interface NotifyEventPayload {
  title: string
  body?: string
  from: string
}

export interface PaneStateEventPayload {
  paneId: string
  generation: number
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export interface PlatformEventPayloads {
  notify: NotifyEventPayload
  'agent.needs-input': { sessionId: string }
  'agent.done': { sessionId: string }
  'session.state': { sessionId: string; state: SessionLiveState }
  'pane.state': PaneStateEventPayload
}

export type PlatformEventType = keyof PlatformEventPayloads

export const PLATFORM_EVENT_TYPES: readonly PlatformEventType[] = [
  'notify',
  'agent.needs-input',
  'agent.done',
  'session.state',
  'pane.state',
]

export const platformEvents = new EventEmitter()

export function emitPlatformEvent<T extends PlatformEventType>(
  type: T,
  payload: PlatformEventPayloads[T],
): void {
  platformEvents.emit(type, payload)
}

export function emitSessionState(sessionId: string, state: SessionLiveState): void {
  emitPlatformEvent('session.state', { sessionId, state })
  if (state === 'waiting') emitPlatformEvent('agent.needs-input', { sessionId })
  else if (state === 'done') emitPlatformEvent('agent.done', { sessionId })
}

import { EventEmitter } from 'node:events'
import type { ArtifactChangeKind } from '../shared/artifacts'
import type { WorkspaceLiveState } from '../shared/types'
import type { Ask, AskResolved } from './asks'

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
  'session.state': { sessionId: string; state: WorkspaceLiveState }
  'pane.state': PaneStateEventPayload
  'ask.created': { ask: Ask }
  'ask.resolved': AskResolved
  'artifact.changed': { sessionId: string; path: string; change: ArtifactChangeKind }
}

export type PlatformEventType = keyof PlatformEventPayloads

export const PLATFORM_EVENT_TYPES: readonly PlatformEventType[] = [
  'notify',
  'agent.needs-input',
  'agent.done',
  'session.state',
  'pane.state',
  'ask.created',
  'ask.resolved',
  'artifact.changed',
]

export const platformEvents = new EventEmitter()

export function emitPlatformEvent<T extends PlatformEventType>(
  type: T,
  payload: PlatformEventPayloads[T],
): void {
  platformEvents.emit(type, payload)
}

export function emitSessionState(sessionId: string, state: WorkspaceLiveState): void {
  emitPlatformEvent('session.state', { sessionId, state })
  if (state === 'waiting') emitPlatformEvent('agent.needs-input', { sessionId })
  else if (state === 'done') emitPlatformEvent('agent.done', { sessionId })
}

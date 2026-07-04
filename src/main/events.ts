/**
 * Main-side platform event bus — decouples event EMITTERS (`notify.ts`, `index.ts`'s
 * lifecycle/terminal-state mirrors) from the event CONSUMER (the LAN gateway,
 * `gateway/server.ts`'s `broadcastEvent`), per `pine-companion/NETWORK-CONTRACT.md` §7
 * ("Server→client events"). A plain `node:events` `EventEmitter`: emitters call
 * `emitPlatformEvent` with zero awareness of whether the gateway is even running (it's
 * OFF BY DEFAULT), and the gateway subscribes on `startGateway` / unsubscribes on
 * `stopGateway`. Routing it through here rather than having emitters import the gateway
 * directly avoids an import cycle — the gateway already pulls in a wide swath of main
 * (`GatewayControlDeps`), so a back-edge from `notify.ts`/`index.ts` into the gateway
 * would risk one for no benefit, since nothing here needs to know who's listening.
 */
import { EventEmitter } from 'node:events'
import type { SessionLiveState } from '../shared/types'

/** `notify` toolbelt fire (`notify.ts`) — same fields as its persisted log entry, minus `ts`. */
export interface NotifyEventPayload {
  title: string
  body?: string
  from: string
}

/**
 * `pane.state` (contract §7: "carries the same shape as `pane.info`" — see
 * `gateway/controlDispatch.ts`'s `pane.info` result). `paneId` here is the pane's EXTERNAL id
 * (as `pane.list`/`pane.info` hand it to a phone), not main's internal renderer paneId — callers
 * must resolve it via `idRegistry.getByPaneId` before emitting.
 */
export interface PaneStateEventPayload {
  paneId: string
  generation: number
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

/** One entry per event type this bus carries — keeps every `emitPlatformEvent`/`onPlatformEvent`
 *  call site checked against the right payload shape. */
export interface PlatformEventPayloads {
  notify: NotifyEventPayload
  'agent.needs-input': { sessionId: string }
  'agent.done': { sessionId: string }
  'session.state': { sessionId: string; state: SessionLiveState }
  'pane.state': PaneStateEventPayload
}

export type PlatformEventType = keyof PlatformEventPayloads

/** Every event type the gateway broadcasts (`gateway/server.ts`'s `subscribePlatformEvents`) —
 *  kept alongside `PlatformEventPayloads` so a new event type can't be added to one without the
 *  other. (Contract §7 also lists `board.changed`/`caps.changed` as event types; neither has an
 *  emitter yet, so they're intentionally out of this union.) */
export const PLATFORM_EVENT_TYPES: readonly PlatformEventType[] = [
  'notify',
  'agent.needs-input',
  'agent.done',
  'session.state',
  'pane.state',
]

/** The bus itself. Prefer the typed `emitPlatformEvent`/`onPlatformEvent`/`offPlatformEvent`
 *  wrappers below over calling `.emit`/`.on`/`.off` directly — they keep the payload shape
 *  checked against `PlatformEventPayloads`. */
export const platformEvents = new EventEmitter()

/** Fire a platform event. No-op if nothing is subscribed (e.g. the gateway is off). */
export function emitPlatformEvent<T extends PlatformEventType>(
  type: T,
  payload: PlatformEventPayloads[T],
): void {
  platformEvents.emit(type, payload)
}

/** Subscribe to a platform event type. Returned listener reference is what `offPlatformEvent`
 *  needs to unsubscribe — callers should hold onto it (see `gateway/server.ts`). */
export function onPlatformEvent<T extends PlatformEventType>(
  type: T,
  listener: (payload: PlatformEventPayloads[T]) => void,
): void {
  platformEvents.on(type, listener)
}

/** Unsubscribe a listener previously passed to `onPlatformEvent` for the same `type`. */
export function offPlatformEvent<T extends PlatformEventType>(
  type: T,
  listener: (payload: PlatformEventPayloads[T]) => void,
): void {
  platformEvents.off(type, listener)
}

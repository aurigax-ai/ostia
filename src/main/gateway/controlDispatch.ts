/**
 * Pure JSON-RPC method dispatch for the LAN gateway's phone-facing control API
 * (`pine-companion/NETWORK-CONTRACT.md` §7, Phase C batch 2). Factored out of `server.ts` so the
 * device-cap gating + target resolution + command-elevation logic is unit-testable without
 * touching `ws`/Electron (mirrors how `controlAuth.ts` is the pure half of `controlServer.ts`'s
 * socket wiring, or how `layout/tree.ts` is the pure half of `layoutStore.ts`).
 *
 * `server.ts` calls `dispatchGatewayMethod` for every authed WS text frame except `hello`
 * (no device yet) and `whoami` (handled inline there, predates this module), then translates the
 * `RpcOutcome` into a JSON-RPC response frame. This module never touches the socket itself.
 *
 * The gateway is its OWN capability broker for phone clients (contract §0.1): a phone isn't a
 * pane, so it bypasses the internal pane-token broker (`controlAuth.ts`/`capabilityStore.ts`)
 * entirely — every method here is gated on the DEVICE's phone-facing capability strings
 * (`gateway/devices.ts`'s `Device.caps`: `read`/`board.read`/`notify`/`command`/`input`/
 * `board.write`/`destructive`), not the internal `Capability` union `command.exec`'s target
 * command descriptors are expressed in. `missingCapForPhone` is what reconciles the two
 * vocabularies for `command.exec`.
 */
import { DEFAULT_CAPABILITIES } from '../../shared/capabilities'
import type { Capability } from '../../shared/capabilities'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import { resolveExternal } from '../idRegistry'
import type { KanbanBoard, NoProjectWorkDir } from '../kanban'
import type { PaneEntry, SessionEntry } from '../paneList'

/** Everything `dispatchGatewayMethod` needs from the rest of main — the gateway's counterpart to
 *  `ControlServerDeps` (`controlServer.ts`), plus the two workspace-wide reads
 *  (`listPanes`/`listSessions`, `src/main/paneList.ts`) and the board read (`kanban.ts`). */
export interface GatewayControlDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  listPanes: () => Promise<PaneEntry[]>
  listSessions: () => Promise<SessionEntry[]>
  kanbanGet: (sessionId: string) => KanbanBoard | NoProjectWorkDir
  /**
   * Resolve "the primary window" for `command.list`'s default target and `command.exec`'s
   * fallback when the phone doesn't name a pane — batch 2 keeps this simple (the caller's own
   * first live window, same as `execCommand`'s no-`windowId` fallback in `index.ts`) since the
   * phone isn't scoped to any one window the way a pane is. Undefined only when no window is
   * open at all.
   */
  primaryWindowId: () => string | undefined
}

export type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: unknown }

function needsElevation(cap: string): RpcOutcome {
  return { ok: false, code: -32003, message: 'needs-elevation', data: { cap } }
}

function invalidParams(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

/**
 * Does a phone holding `deviceCaps` satisfy `desc`'s (internal-`Capability`-typed) requirements?
 * Returns the first missing internal capability, or null if `desc` is fully within reach.
 *
 * - `DEFAULT_CAPABILITIES` (drive-self, read-board, notify, wiki-read/write, settings-read,
 *   board-write, process, vault-read/write) need nothing beyond the phone's own `command` cap
 *   (already gated by the caller before this runs) — every pane holds these by default, so a
 *   phone that can call `command.exec` at all can reach them.
 * - The internal `destructive` capability maps 1:1 onto the phone's own `destructive` cap
 *   (contract §5's elevated, always-confirm-on-device cap).
 * - Every OTHER elevated internal capability (`send-other-pane`, `kill-pane`, `workspace-wide`,
 *   `shell`, `phone`, `gateway`, `browse`, `settings-write`) has NO phone-facing equivalent the
 *   pairing contract ever grants (§5's phone cap vocabulary tops out at
 *   read/board.read/notify/command/input/board.write/destructive) — a command requiring one of
 *   those is unconditionally out of a phone's reach, not just "gate until granted".
 */
function missingCapForPhone(desc: CommandDescriptor, deviceCaps: string[]): Capability | null {
  for (const cap of desc.capabilities) {
    if (cap === 'destructive') {
      if (!deviceCaps.includes('destructive')) return cap
      continue
    }
    if (DEFAULT_CAPABILITIES.includes(cap)) continue
    return cap
  }
  return null
}

/**
 * `command.exec`'s `target`: a pane's EXTERNAL id (as returned by `pane.list`), resolved to an
 * internal `CommandTarget` via `idRegistry`. Omitted -> a sensible default (the primary window,
 * no session/pane scope — fine for `target:'none'`/`target:'active'`-with-no-real-pane commands)
 * since the phone isn't itself a pane. A NON-EMPTY but unresolvable target is a hard error —
 * never silently falls back to the default, which would let a stale/mistyped pane id silently
 * retarget an action.
 */
function resolveTarget(target: unknown, primaryWindowId: string | undefined): CommandTarget | null {
  if (target === undefined || target === null) {
    return { windowId: primaryWindowId, sessionId: '', paneId: null }
  }
  if (typeof target !== 'string' || !target) return null
  const identity = resolveExternal(target)
  if (!identity) return null
  return { windowId: identity.windowId, sessionId: identity.sessionId, paneId: identity.paneId }
}

/** Dispatch one already-authenticated phone method call. Never throws for a "normal" failure
 *  (unknown command, missing params, ...) — those come back as `{ok:false, ...}`; only a thrown
 *  `deps` error (e.g. `execCommand` rejecting) propagates, for `server.ts` to catch. */
export async function dispatchGatewayMethod(
  method: string,
  params: unknown,
  deviceCaps: string[],
  deps: GatewayControlDeps,
): Promise<RpcOutcome> {
  const p = (params ?? {}) as Record<string, unknown>
  const hasCap = (cap: string): boolean => deviceCaps.includes(cap)

  switch (method) {
    case 'session.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { sessions: await deps.listSessions() } }
    }

    case 'pane.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { panes: await deps.listPanes() } }
    }

    case 'command.list': {
      if (!hasCap('read')) return needsElevation('read')
      const windowId = deps.primaryWindowId()
      return { ok: true, result: { commands: windowId ? deps.listCommandsFor(windowId) : [] } }
    }

    case 'command.exec': {
      if (!hasCap('command')) return needsElevation('command')
      const id = p.id
      if (typeof id !== 'string' || !id) return invalidParams('missing command id')
      const windowId = deps.primaryWindowId()
      const descriptors = windowId ? deps.listCommandsFor(windowId) : []
      const desc = descriptors.find((d) => d.id === id)
      if (!desc) {
        return {
          ok: true,
          result: {
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${id}'` },
          },
        }
      }
      const missing = missingCapForPhone(desc, deviceCaps)
      if (missing) return needsElevation(missing)
      const target = resolveTarget(p.target, windowId)
      if (!target) return invalidParams('unknown pane target')
      return { ok: true, result: await deps.execCommand(target, id, p.args) }
    }

    case 'pane.info': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      if (!identity) return invalidParams('unknown paneId')
      const state = deps.getTerminalState(identity.paneId)
      return {
        ok: true,
        result: {
          paneId,
          generation: state?.generation ?? 0,
          cwd: state?.cwd,
          running: state?.running ?? false,
          blockCount: state?.blockCount ?? 0,
          lastExitCode: state?.lastExitCode,
        },
      }
    }

    case 'cwd.get': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      const cwd = identity ? (deps.getTerminalState(identity.paneId)?.cwd ?? null) : null
      return { ok: true, result: { cwd } }
    }

    case 'board.get': {
      if (!hasCap('board.read')) return needsElevation('board.read')
      // Contract §7's `{ scope? }` — batch 2 keeps this simple: `scope` (if given) IS the
      // sessionId to read; otherwise pick the caller's first known session. Kanban has no
      // workspace-wide view (it's inherently per-project), so SOME session must be chosen.
      let sessionId = typeof p.scope === 'string' ? p.scope : undefined
      if (!sessionId) sessionId = (await deps.listSessions())[0]?.sessionId
      if (!sessionId) return { ok: true, result: { columns: [], cards: [] } }
      return { ok: true, result: deps.kanbanGet(sessionId) }
    }

    default:
      return { ok: false, code: -32601, message: `method not found: ${method}` }
  }
}

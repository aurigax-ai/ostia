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
import type { Capability } from '../../shared/capabilities'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import { resolveExternal } from '../idRegistry'
import type { KanbanBoard, KanbanCard, KanbanUpdateResult, NoProjectWorkDir } from '../kanban'
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
  /** `board.update {cardId, patch}` (device cap `board.write`) — mirrors `kanbanGet` above. */
  kanbanUpdate: (
    sessionId: string,
    cardId: string,
    patch: Partial<Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>>,
  ) => KanbanUpdateResult
  /**
   * Resolve "the primary window" for `command.list`'s default target and `command.exec`'s
   * fallback when the phone doesn't name a pane — batch 2 keeps this simple (the caller's own
   * first live window, same as `execCommand`'s no-`windowId` fallback in `index.ts`) since the
   * phone isn't scoped to any one window the way a pane is. Undefined only when no window is
   * open at all.
   */
  primaryWindowId: () => string | undefined
  /**
   * Phase C batch 3 (contract §6): live PTY streaming for a paired phone. Registers a
   * subscriber on the desktop's existing multi-subscriber `PtySession` (`index.ts`'s `ptys`
   * map) — `role:'observer'` (read-only) or `'owner'` — returning the resume cursor/drop flag/
   * pty dimensions plus a `detach`. Returns null when `rendererPaneId` has no live pty.
   *
   * NOT dispatched through `dispatchGatewayMethod` below: `pty.attach`/`pty.detach` need a
   * live, per-socket `sendData` bound to the actual `ws` connection (for binary `0x01` output
   * frames) and per-socket detach-fn tracking (for `pty.detach` / WS-close cleanup) — neither
   * fits the pure `Promise<RpcOutcome>` shape every other method returns. `server.ts` handles
   * `pty.attach`/`pty.detach` inline instead, the same way it already special-cases `hello`/
   * `whoami` before ever reaching this switch (see the pinned "pty.attach is method-not-found
   * here" test in `controlDispatch.test.ts`).
   */
  attachPhoneObserver: (
    rendererPaneId: string,
    opts: { sinceCursor?: number; role?: 'observer' | 'owner'; sendData: (data: string) => void },
  ) => { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null
  /** Resize a pane's pty (SIGWINCH) — called from `server.ts`'s binary `0x03` frame handler. */
  ptyResize: (rendererPaneId: string, cols: number, rows: number) => void
  /** Write input bytes into a pane's pty — called from `server.ts`'s binary `0x02` frame
   *  handler, only once it's confirmed the socket is attached as `owner`. */
  ptyWrite: (rendererPaneId: string, data: string) => void
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
 * Strict phone-cap -> internal-cap allow map (security fix: a phone holding only the `command`
 * cap used to be able to run ANY registered command — including ones whose descriptor requires
 * an elevated, cross-boundary internal capability like `kill-pane`/`shell`/`workspace-wide`,
 * because the old check treated every `DEFAULT_CAPABILITIES` internal cap as automatically
 * in reach of `command` alone). This is now an ALLOWLIST: an internal capability is reachable
 * from a phone ONLY if it's listed here, gated behind holding the specific phone-facing cap
 * named as its key — everything else (including several `DEFAULT_CAPABILITIES`-default internal
 * caps like `process`/`vault-read`/`wiki-write`/`settings-read` that have no phone-facing
 * equivalent in the pairing contract's §5 vocabulary) is unconditionally out of a phone's reach.
 * `input` is deliberately absent — it's the pty binary-frame channel (`server.ts`), never a
 * `command.exec` capability.
 */
const PHONE_CAP_ALLOWS: Partial<Record<string, Capability[]>> = {
  read: ['read-board'],
  command: ['drive-self'],
  'board.read': ['read-board'],
  'board.write': ['board-write'],
  notify: ['notify'],
  destructive: ['destructive'],
}

/**
 * Does a phone holding `deviceCaps` satisfy `desc`'s (internal-`Capability`-typed) requirements?
 * Returns the first missing internal capability, or null if `desc` is fully within reach —
 * "within reach" meaning every required internal cap is in the UNION of `PHONE_CAP_ALLOWS`
 * entries for the phone caps this device actually holds.
 */
function missingCapForPhone(desc: CommandDescriptor, deviceCaps: string[]): Capability | null {
  const allowed = new Set<Capability>()
  for (const phoneCap of deviceCaps) {
    for (const cap of PHONE_CAP_ALLOWS[phoneCap] ?? []) allowed.add(cap)
  }
  for (const cap of desc.capabilities) {
    if (!allowed.has(cap)) return cap
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

/**
 * `board.get`/`board.update`'s `{ scope? }`: `scope` (if given) IS the sessionId to act on;
 * otherwise pick the caller's first known session. Kanban has no workspace-wide view (it's
 * inherently per-project), so SOME session must be chosen. Shared by both methods so they pick
 * the same board a scope-less caller would expect to read and write.
 */
async function resolveBoardSessionId(
  scope: unknown,
  deps: GatewayControlDeps,
): Promise<string | undefined> {
  if (typeof scope === 'string' && scope) return scope
  return (await deps.listSessions())[0]?.sessionId
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
      const sessionId = await resolveBoardSessionId(p.scope, deps)
      if (!sessionId) return { ok: true, result: { columns: [], cards: [] } }
      return { ok: true, result: deps.kanbanGet(sessionId) }
    }

    case 'board.update': {
      if (!hasCap('board.write')) return needsElevation('board.write')
      const cardId = p.cardId
      if (typeof cardId !== 'string' || !cardId) return invalidParams('missing cardId')
      const patch = (p.patch ?? {}) as Partial<
        Pick<KanbanCard, 'title' | 'body' | 'column' | 'assignee'>
      >
      const sessionId = await resolveBoardSessionId(p.scope, deps)
      if (!sessionId) return invalidParams('no session available')
      return { ok: true, result: deps.kanbanUpdate(sessionId, cardId, patch) }
    }

    default:
      return { ok: false, code: -32601, message: `method not found: ${method}` }
  }
}

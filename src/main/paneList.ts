/**
 * `pane.list`/`session.list` (Phase C batch 2) — bridges the renderer's OWN view of panes
 * (kind/title/cwd, owned by `layoutStore`) and sessions (name/workDir, owned by `sessionsStore`)
 * into main's external-id view. The renderer owns pane kinds/titles + session names; main owns
 * external ids (`idRegistry`) — this module is what reconciles the two, fixing the long-noted
 * "no pane.list yet" gap (`.claude/skills/pine/SKILL.md`'s coordination recipe,
 * `src/main/browse.ts`'s header comment).
 *
 * Exported as plain async functions (not just `registerControlMethod` handlers) so BOTH the
 * local pane-token-authenticated control socket (this file's `registerPaneListMethods`) and the
 * LAN gateway's phone-facing control API (`src/main/gateway/controlDispatch.ts`, injected as
 * `listPanes`/`listSessions` deps from `index.ts`) can call the exact same logic without a second
 * implementation living behind two different JSON-RPC transports.
 */
import type { Capability } from '../shared/capabilities'
import type { CommandResult, CommandTarget, TerminalStateSnapshot } from '../shared/types'
import { registerControlMethod } from './controlServer'
import { getByPaneId } from './idRegistry'

/** What the renderer's OWN `pane.list` command (`src/renderer/commands/builtins.ts`) reports —
 *  `paneId` here is the INTERNAL (renderer) pane id, not yet mapped to an external id. */
interface RendererPaneEntry {
  paneId: string
  sessionId: string
  kind: string
  title: string
  cwd?: string
}

/** The renderer's OWN `session.list` command's entry — passed through verbatim below (sessions
 *  have no external-id concept the way panes do). */
export interface SessionEntry {
  sessionId: string
  name: string
  kind: string
  workDir: string
  state: string
}

/** `pane.list`'s public shape (control socket + gateway): `paneId` is now the EXTERNAL id, and
 *  `running`/`blockCount`/`lastExitCode` are merged in from main's terminal-state read-model
 *  (`src/main/index.ts`'s `getTerminalState`) where available. */
export interface PaneEntry {
  paneId: string
  sessionId: string
  kind: string
  title: string
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export interface PaneListDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
}

/**
 * `pane.list`/`session.list` are workspace-wide reads (`target: 'none'` in the renderer registry)
 * — no caller-scoped session/pane applies, so this placeholder target is just what
 * `execCommand` needs to pick a window: omitting `windowId` falls back to the first live window
 * (`src/main/index.ts`'s `execCommand`), and both renderer commands ignore `sessionId`/`paneId`.
 */
const GLOBAL_TARGET: CommandTarget = { sessionId: '', paneId: null }

/**
 * Every pane across every session, with internal renderer paneIds mapped to EXTERNAL ids via
 * `idRegistry.getByPaneId` — a pane with no external id yet (its `pane-created` lifecycle event
 * hasn't landed in main) is dropped rather than surfaced with a useless internal id.
 */
export async function listPanes(deps: PaneListDeps): Promise<PaneEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'pane.list', { allSessions: true })
  if (!res.ok) return []
  const panes = (res.result as RendererPaneEntry[] | undefined) ?? []
  const mapped: PaneEntry[] = []
  for (const p of panes) {
    const identity = getByPaneId(p.paneId)
    if (!identity) continue
    const state = deps.getTerminalState(p.paneId)
    mapped.push({
      paneId: identity.externalId,
      sessionId: p.sessionId,
      kind: p.kind,
      title: p.title,
      cwd: state?.cwd ?? p.cwd,
      running: state?.running ?? false,
      blockCount: state?.blockCount ?? 0,
      lastExitCode: state?.lastExitCode,
    })
  }
  return mapped
}

/** Every session (sidebar entry) — a pass-through of the renderer's own `session.list`. */
export async function listSessions(
  deps: Pick<PaneListDeps, 'execCommand'>,
): Promise<SessionEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'session.list', {})
  return res.ok ? ((res.result as SessionEntry[] | undefined) ?? []) : []
}

const READ_BOARD: Capability = 'read-board'

/** Wire `pane.list`/`session.list` onto the local control socket, gated on the same `read-board`
 *  DEFAULT capability `pane.info`/`cwd.get` already use (every pane holds it). */
export function registerPaneListMethods(deps: PaneListDeps): void {
  registerControlMethod('pane.list', { cap: READ_BOARD, handler: () => listPanes(deps) })
  registerControlMethod('session.list', { cap: READ_BOARD, handler: () => listSessions(deps) })
}

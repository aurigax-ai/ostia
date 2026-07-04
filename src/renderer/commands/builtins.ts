import { type DropZone, allPanes } from '../layout/tree'
import type { Direction, SurfaceKind } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import type { SessionKind, SessionState } from '../stores/sessionsStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type CommandContext, commands } from './registry'

/** `pane.list`'s per-pane entry — main (`src/main/paneList.ts`) maps `paneId` (internal here) to
 *  an EXTERNAL id via `idRegistry` before handing this to the control socket / gateway. */
interface PaneListEntry {
  paneId: string
  sessionId: string
  kind: SurfaceKind
  title: string
  cwd?: string
}

/** `session.list`'s per-session entry — sessions have no external-id concept, so main passes
 *  this straight through (unlike `pane.list`, which remaps ids). */
interface SessionListEntry {
  sessionId: string
  name: string
  kind: SessionKind
  workDir: string
  state: SessionState
}

/** Walk a dot-path (e.g. `appearance.terminal.size`) into a value; undefined if absent. */
function getByPath(root: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      if (acc !== null && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key]
      }
      return undefined
    }, root)
}

/**
 * Register Phase 0's built-in commands. Each is a thin wrapper over a store —
 * but routing them through the registry means the palette/CLI/agents added later
 * get them for free. Palette-friendly commands take no required args (they act
 * on the "current" pane); the parameterized ones are marked hidden.
 *
 * "Current" = the focused pane in the active session.
 */
export function registerBuiltinCommands(): void {
  commands.setContextProvider((): CommandContext => {
    const sessionId = useSessionsStore.getState().activeSessionId
    const layout = useLayoutStore.getState().bySession[sessionId]
    return { activeSessionId: sessionId, activePaneId: layout?.activePaneId ?? null }
  })

  // Parameterized primitive — used by pane buttons with an explicit target.
  commands.register<{ paneId?: string; direction: Direction }>({
    id: 'pane.split',
    title: 'Split Pane',
    category: 'Pane',
    hidden: true,
    run: ({ paneId, direction }, ctx) => {
      const target = paneId ?? ctx.activePaneId
      if (ctx.activeSessionId && target) {
        useLayoutStore.getState().split(ctx.activeSessionId, target, direction)
      }
    },
  })

  // Palette-friendly wrappers — delegate to the pane.split primitive (acts on the current pane).
  commands.register({
    id: 'pane.splitRight',
    title: 'Split Pane Right',
    category: 'Pane',
    run: () => commands.exec('pane.split', { direction: 'horizontal' }),
  })

  commands.register({
    id: 'pane.splitDown',
    title: 'Split Pane Down',
    category: 'Pane',
    run: () => commands.exec('pane.split', { direction: 'vertical' }),
  })

  commands.register<{ paneId?: string }>({
    id: 'pane.close',
    title: 'Close Pane',
    category: 'Pane',
    // Elevated: closing a pane is destructive/cross-boundary-capable (a remote caller could
    // target ANY pane, not just its own) — a phone's `command` cap alone must not reach this
    // (see `gateway/controlDispatch.ts`'s `PHONE_CAP_ALLOWS`, which has no entry for `kill-pane`).
    capabilities: ['kill-pane'],
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeSessionId && target) {
        useLayoutStore.getState().closePane(ctx.activeSessionId, target)
      }
    },
  })

  commands.register<{ paneId: string }>({
    id: 'pane.focus',
    title: 'Focus Pane',
    category: 'Pane',
    hidden: true,
    run: ({ paneId }, ctx) => {
      if (ctx.activeSessionId && paneId) {
        useLayoutStore.getState().focusPane(ctx.activeSessionId, paneId)
      }
    },
  })

  // Relocate a pane via drag-and-drop (header drag → drop on another pane's edge/center).
  commands.register<{ sourceId: string; targetId: string; zone: DropZone }>({
    id: 'pane.move',
    title: 'Move Pane',
    category: 'Pane',
    hidden: true,
    run: ({ sourceId, targetId, zone }, ctx) => {
      if (ctx.activeSessionId) {
        useLayoutStore.getState().movePane(ctx.activeSessionId, sourceId, targetId, zone)
      }
    },
  })

  // Remove a pane from this window (used after it's torn off into a new window).
  commands.register<{ paneId: string }>({
    id: 'pane.remove',
    title: 'Remove Pane',
    category: 'Pane',
    hidden: true,
    // Elevated — same reasoning as `pane.close` above; this also closes a pane (post-tear-off).
    capabilities: ['kill-pane'],
    run: ({ paneId }, ctx) => {
      if (ctx.activeSessionId) useLayoutStore.getState().removePane(ctx.activeSessionId, paneId)
    },
  })

  // Sessions — sidebar entries, each anchored at a workDir.
  commands.register({
    id: 'session.new',
    title: 'New Session',
    category: 'Session',
    target: 'none',
    run: () => {
      useUIStore.getState().leaveSettings() // don't create the session hidden behind Settings
      useSessionsStore.getState().addSession()
    },
  })

  commands.register({
    id: 'palette.toggle',
    title: 'Command Palette',
    category: 'View',
    target: 'none',
    run: () => useUIStore.getState().togglePalette(),
  })

  commands.register({
    id: 'view.toggleRail',
    title: 'Toggle Sidebar',
    category: 'View',
    target: 'none',
    run: () => useUIStore.getState().toggleRail(),
  })

  commands.register({
    id: 'app.openSettings',
    title: 'Open Settings',
    category: 'App',
    target: 'none',
    run: () => useUIStore.getState().openSettings(),
  })

  // `pine open <path>` — opens a file in the editor surface of the caller's session.
  commands.register<{ path: string }>({
    id: 'editor.open',
    title: 'Open File',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: ({ path }, ctx) => {
      if (ctx.activeSessionId && path) useLayoutStore.getState().openFile(ctx.activeSessionId, path)
    },
  })

  // `pine browser new [url]` — opens `url` (default about:blank) in a browser surface of the
  // caller's session: reuses an existing browser pane if there is one, else splits a new one.
  commands.register<{ url?: string } | undefined>({
    id: 'browser.new',
    title: 'New Browser',
    hidden: true,
    capabilities: ['browse'],
    target: 'active',
    run: (args, ctx) => {
      if (ctx.activeSessionId) {
        useLayoutStore.getState().openBrowser(ctx.activeSessionId, args?.url || 'about:blank')
      }
    },
  })

  // Palette-friendly wrapper — delegates to browser.new with no url (opens about:blank).
  commands.register({
    id: 'browser.open',
    title: 'Open Browser',
    category: 'App',
    capabilities: ['browse'],
    run: () => commands.exec('browser.new'),
  })

  // `pine kanban open` — opens (or focuses an existing) kanban board pane for the caller's
  // session. Capped `read-board` (same default cap `kanban.get` uses) — the board itself is
  // still mutated through `kanban:mutate`'s own control methods, this command just opens the UI.
  commands.register<undefined>({
    id: 'kanban.open',
    title: 'Open Board',
    category: 'App',
    capabilities: ['read-board'],
    target: 'active',
    run: (_args, ctx) => {
      if (ctx.activeSessionId) useLayoutStore.getState().openSurface(ctx.activeSessionId, 'kanban')
    },
  })

  // `pine wiki open` — opens (or focuses an existing) wiki pane for the caller's session.
  commands.register<undefined>({
    id: 'wiki.open',
    title: 'Open Wiki',
    category: 'App',
    capabilities: ['wiki-read'],
    target: 'active',
    run: (_args, ctx) => {
      if (ctx.activeSessionId) useLayoutStore.getState().openSurface(ctx.activeSessionId, 'wiki')
    },
  })

  // `pane.list` — the long-noted "list all panes" gap (see `.claude/skills/pine/SKILL.md`'s
  // coordination recipe / `src/main/browse.ts`'s header comment). Walks the caller's active
  // session's layout tree by default, or every session's when `allSessions` is set — main
  // (`src/main/paneList.ts`) is what actually exposes this externally, remapping each internal
  // `paneId` here to its `idRegistry` EXTERNAL id and merging in `getTerminalState`'s `running`.
  commands.register<{ allSessions?: boolean } | undefined, PaneListEntry[]>({
    id: 'pane.list',
    title: 'List Panes',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: (args, ctx) => {
      const sessionIds = args?.allSessions
        ? useSessionsStore.getState().sessions.map((s) => s.id)
        : ctx.activeSessionId
          ? [ctx.activeSessionId]
          : []
      const bySession = useLayoutStore.getState().bySession
      const result: PaneListEntry[] = []
      for (const sessionId of sessionIds) {
        const layout = bySession[sessionId]
        if (!layout) continue
        for (const pane of allPanes(layout.root)) {
          result.push({
            paneId: pane.id,
            sessionId,
            kind: pane.kind,
            title: pane.title,
            cwd: pane.cwd,
          })
        }
      }
      return result
    },
  })

  // `session.list` — the sidebar's sessions, verbatim (no id remapping needed: unlike panes,
  // sessions have no external identity/idRegistry entry of their own).
  commands.register<Record<string, never> | undefined, SessionListEntry[]>({
    id: 'session.list',
    title: 'List Sessions',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () =>
      useSessionsStore.getState().sessions.map((s) => ({
        sessionId: s.id,
        name: s.name,
        kind: s.kind,
        workDir: s.workDir,
        state: s.state,
      })),
  })

  // `pine settings get [key]` — the whole settings state, or a dot-path value within it.
  commands.register<{ key?: string } | undefined, unknown>({
    id: 'settings.get',
    title: 'Get Setting',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => {
      const { locale, appearance, behavior } = useSettingsStore.getState()
      const state = { locale, appearance, behavior }
      const key = args?.key
      return key ? getByPath(state, key) : state
    },
  })

  // `pine settings set <key> <value>` — deep-set a dot-path into the settings store
  // (source of truth stays settingsStore, so the UI updates live).
  commands.register<{ key: string; value: unknown }, { ok: true }>({
    id: 'settings.set',
    title: 'Set Setting',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key, value }) => {
      useSettingsStore.getState().setByPath(key, value)
      return { ok: true }
    },
  })
}

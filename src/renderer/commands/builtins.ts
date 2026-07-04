import type { DropZone } from '../layout/tree'
import type { Direction } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type CommandContext, commands } from './registry'

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

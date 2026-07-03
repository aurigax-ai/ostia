import type { DropZone } from '../layout/tree'
import type { Direction } from '../layout/types'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useUIStore } from '../stores/uiStore'
import { type CommandContext, commands } from './registry'

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
    run: () => {
      useUIStore.getState().leaveSettings() // don't create the session hidden behind Settings
      useSessionsStore.getState().addSession()
    },
  })

  commands.register({
    id: 'palette.toggle',
    title: 'Command Palette',
    category: 'View',
    run: () => useUIStore.getState().togglePalette(),
  })

  commands.register({
    id: 'view.toggleRail',
    title: 'Toggle Sidebar',
    category: 'View',
    run: () => useUIStore.getState().toggleRail(),
  })

  commands.register({
    id: 'app.openSettings',
    title: 'Open Settings',
    category: 'App',
    run: () => useUIStore.getState().openSettings(),
  })
}

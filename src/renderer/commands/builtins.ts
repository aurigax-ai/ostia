import type { AttentionState } from '@shared/types'
import { type DropZone, allPanes } from '../layout/tree'
import type { Direction, SurfaceKind } from '../layout/types'
import { jumpToLatestUnread, signalPane } from '../lib/sessionActivity'
import { useLayoutStore } from '../stores/layoutStore'
import { saveWorkspaceNow } from '../stores/persistence'
import type { SessionKind, SessionState } from '../stores/sessionsStore'
import { useSessionsStore } from '../stores/sessionsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { type CommandContext, commands } from './registry'

interface PaneListEntry {
  paneId: string
  sessionId: string
  kind: SurfaceKind
  title: string
  cwd?: string
}

interface SessionListEntry {
  sessionId: string
  name: string
  kind: SessionKind
  workDir: string
  state: SessionState
}

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

async function delegate(ctx: CommandContext, id: string, args?: unknown): Promise<unknown> {
  const r = await commands.execWith(ctx, id, args)
  if (!r.ok) throw new Error(r.error.message)
  return r.result
}

export function registerBuiltinCommands(): void {
  commands.setContextProvider((): CommandContext => {
    const sessionId = useSessionsStore.getState().activeSessionId
    const layout = useLayoutStore.getState().bySession[sessionId]
    return { activeSessionId: sessionId, activePaneId: layout?.activePaneId ?? null }
  })

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

  commands.register({
    id: 'pane.splitRight',
    title: 'Split Pane Right',
    category: 'Pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'horizontal' }),
  })

  commands.register({
    id: 'pane.splitDown',
    title: 'Split Pane Down',
    category: 'Pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'vertical' }),
  })

  commands.register<{ paneId?: string }>({
    id: 'pane.close',
    title: 'Close Pane',
    category: 'Pane',
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

  commands.register<{ paneId?: string; zoom?: boolean } | undefined>({
    id: 'pane.zoom',
    title: 'Zoom Pane',
    category: 'Pane',
    hidden: true,
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeSessionId && target) {
        useLayoutStore.getState().zoomPane(ctx.activeSessionId, target, args?.zoom)
      }
    },
  })

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

  commands.register<{ state: AttentionState; message?: string }>({
    id: 'attention.set',
    title: 'Set Pane Attention',
    category: 'Pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: ({ state, message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      signalPane(ctx.activePaneId, { type: 'set', state, message, at: Date.now() })
    },
  })

  commands.register<{ message: string }>({
    id: 'attention.notify',
    title: 'Mark Pane Unread',
    category: 'Pane',
    hidden: true,
    capabilities: ['notify'],
    run: ({ message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      signalPane(ctx.activePaneId, { type: 'notify', message, waiting: false, at: Date.now() })
    },
  })

  commands.register<undefined, { paneId: string | null }>({
    id: 'attention.jumpToLatest',
    title: 'Jump to Latest Unread',
    category: 'View',
    target: 'none',
    run: () => ({ paneId: jumpToLatestUnread() }),
  })

  commands.register({
    id: 'session.new',
    title: 'New Session',
    category: 'Session',
    target: 'none',
    run: () => {
      useUIStore.getState().leaveSettings()
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

  commands.register({
    id: 'browser.open',
    title: 'Open Browser',
    category: 'App',
    capabilities: ['browse'],
    run: (_args, ctx) => delegate(ctx, 'browser.new'),
  })

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

  commands.register<undefined, { saved: boolean }>({
    id: 'session.save',
    title: 'Save Session',
    category: 'App',
    capabilities: ['settings-write'],
    target: 'none',
    run: () => {
      const enabled = useSettingsStore.getState().behavior.restoreSession
      saveWorkspaceNow()
      return { saved: enabled }
    },
  })

  commands.register<{ key?: string } | undefined, unknown>({
    id: 'settings.get',
    title: 'Get Setting',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => {
      const { locale, appearance, behavior, capabilities } = useSettingsStore.getState()
      const state = { locale, appearance, behavior, capabilities }
      const key = args?.key
      return key ? getByPath(state, key) : state
    },
  })

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

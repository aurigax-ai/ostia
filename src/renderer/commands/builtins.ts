import { type AgentResume, resumeCommand } from '@shared/agentResume'
import { wantsDesktopBanner } from '@shared/notificationSettings'
import { PRODUCT_NAME } from '@shared/product'
import type { AttentionState } from '@shared/types'
import { type WorkspaceGroupColor, normalizeGroupName } from '@shared/workspaceGroups'
import { ZOOM_DEFAULT, stepZoom } from '@shared/zoom'
import { type DropZone, allPanes, findPane } from '../layout/tree'
import type { Direction, SurfaceKind } from '../layout/types'
import { postAgentNotification } from '../lib/agentNotification'
import {
  type BlockPart,
  copyBlock,
  insertCommand,
  rerunBlock,
  stepBlock,
} from '../lib/blockActions'
import { setKeybindingSetting } from '../lib/chords'
import { requestCloseOthers, requestClosePane } from '../lib/closeConfirm'
import { wakePane } from '../lib/hibernationScheduler'
import { startNewWorkspace } from '../lib/newWorkspace'
import { isStaleAgentReport } from '../lib/paneAgent'
import { openWorkflowPicker } from '../lib/workflows'
import {
  goToWorkspace,
  isPaneViewed,
  jumpToLatestUnread,
  markWorkspaceRead,
  signalPane,
} from '../lib/workspaceActivity'
import { isMac } from '../platform'
import { settingsSchemaAt } from '../settings/settingsSchema'
import { useBlocksStore } from '../stores/blocksStore'
import { useHistorySearchStore } from '../stores/historySearchStore'
import { useLayoutStore } from '../stores/layoutStore'
import { saveSnapshotNow } from '../stores/persistence'
import {
  type InputMode,
  type SettingChange,
  getByPath,
  useSettingsStore,
} from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import type { WorkspaceKind, WorkspaceState } from '../stores/workspacesStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { type CommandContext, commands } from './registry'

interface PaneListEntry {
  paneId: string
  workspaceId: string
  kind: SurfaceKind
  title: string
  cwd?: string
  filePath?: string
}

interface WorkspaceListEntry {
  workspaceId: string
  name: string
  kind: WorkspaceKind
  workDir: string
  state: WorkspaceState
  activePaneId?: string
  groupId?: string
}

interface WorkspaceGroupEntry {
  groupId: string
  name: string
  color?: WorkspaceGroupColor
  collapsed: boolean
  workspaceIds: string[]
}

const PROGRAM_SETTINGS: readonly {
  group: 'behavior' | 'notifications' | 'agents' | 'terminal'
  field: string
}[] = [
  { group: 'behavior', field: 'externalEditor' },
  { group: 'notifications', field: 'command' },
  { group: 'agents', field: 'autoResume' },
  { group: 'terminal', field: 'warnOnRiskyPaste' },
]

export function launchesProgram(key: string, value: unknown): string | null {
  const path = key.split('.').filter(Boolean).join('.')
  const state = useSettingsStore.getState()
  for (const { group, field } of PROGRAM_SETTINGS) {
    const setting = `${group}.${field}`
    if (path === setting || path.startsWith(`${setting}.`)) return setting
    if (path !== group || typeof value !== 'object' || value === null || !(field in value)) continue
    const current = (state[group] as unknown as Record<string, unknown>)[field]
    if ((value as Record<string, unknown>)[field] !== current) return setting
  }
  return null
}

const isKeybindingPath = (key: string): boolean =>
  key === 'keybindings' || key.startsWith('keybindings.')

function readableSettings() {
  const s = useSettingsStore.getState()
  return {
    locale: s.locale,
    appearance: s.appearance,
    behavior: s.behavior,
    terminal: s.terminal,
    panes: s.panes,
    notifications: s.notifications,
    sidebar: s.sidebar,
    workspaces: s.workspaces,
    browser: s.browser,
    editor: s.editor,
    agents: s.agents,
    workspaceGroups: s.workspaceGroups,
    keybindings: { ...s.keybindings },
    capabilities: s.capabilities,
    approvals: s.approvals,
    actions: s.actions,
  }
}

function settingResult(change: SettingChange): { previous: unknown; value: unknown } {
  return { previous: change.previous, value: change.value }
}

async function delegate(ctx: CommandContext, id: string, args?: unknown): Promise<unknown> {
  const r = await commands.execWith(ctx, id, args)
  if (!r.ok) throw new Error(r.error.message)
  return r.result
}

const WORKSPACE_DIR = /^(\/|~(\/|$))/

export function registerBuiltinCommands(): void {
  commands.setContextProvider((): CommandContext => {
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
    const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
    return { activeWorkspaceId: workspaceId, activePaneId: layout?.activePaneId ?? null }
  })

  commands.register<{ paneId?: string; direction: Direction }>({
    id: 'pane.split',
    title: 'Split Pane',
    category: 'Pane',
    hidden: true,
    run: ({ paneId, direction }, ctx) => {
      const target = paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().split(ctx.activeWorkspaceId, target, direction)
      }
    },
  })

  commands.register<{ paneId?: string } | undefined>({
    id: 'tab.new',
    title: 'New Terminal Tab',
    category: 'Pane',
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'terminal')
      }
    },
  })

  commands.register<{ paneId?: string } | undefined>({
    id: 'tab.newBrowser',
    title: 'New Browser Tab',
    category: 'Pane',
    capabilities: ['browse'],
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'browser')
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
    run: async (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        await requestClosePane(ctx.activeWorkspaceId, target)
      }
    },
  })

  commands.register<{ paneId: string }>({
    id: 'pane.focus',
    title: 'Focus Pane',
    category: 'Pane',
    hidden: true,
    run: ({ paneId }, ctx) => {
      if (ctx.activeWorkspaceId && paneId) {
        useLayoutStore.getState().focusPane(ctx.activeWorkspaceId, paneId)
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
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().zoomPane(ctx.activeWorkspaceId, target, args?.zoom)
      }
    },
  })

  commands.register<{ sourceId: string; targetId: string; zone: DropZone }>({
    id: 'pane.move',
    title: 'Move Pane',
    category: 'Pane',
    hidden: true,
    run: ({ sourceId, targetId, zone }, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().movePane(ctx.activeWorkspaceId, sourceId, targetId, zone)
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
      if (isStaleAgentReport(ctx.activePaneId, state)) return
      const seen = isPaneViewed(ctx.activePaneId)
      signalPane(ctx.activePaneId, { type: 'set', state, message, at: Date.now() })
      if (state === 'waiting' || state === 'done') {
        postAgentNotification(ctx.activePaneId, state, message, seen)
      }
    },
  })

  commands.register<AgentResume>({
    id: 'resume.set',
    title: 'Set Agent Resume Token',
    category: 'Pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: (resume, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      useLayoutStore.getState().setResume(ctx.activeWorkspaceId, ctx.activePaneId, resume)
      useBlocksStore.getState().markAgent(ctx.activePaneId, resume.agent)
    },
  })

  commands.register<undefined, { resumed: boolean }>({
    id: 'agent.resume',
    title: 'Resume Agent',
    category: 'Pane',
    capabilities: ['shell'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) return { resumed: false }
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      if (pane?.kind !== 'terminal' || !pane.resume) return { resumed: false }
      if (pane.hibernated) return { resumed: wakePane(pane.id) }
      return { resumed: insertCommand(pane.id, resumeCommand(pane.resume), true) }
    },
  })

  commands.register<{ message: string }, { desktop: boolean }>({
    id: 'attention.notify',
    title: 'Mark Pane Unread',
    category: 'Pane',
    hidden: true,
    capabilities: ['notify'],
    run: ({ message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      const seen = isPaneViewed(ctx.activePaneId)
      signalPane(ctx.activePaneId, { type: 'notify', message, waiting: false, at: Date.now() })
      return {
        desktop: wantsDesktopBanner(useSettingsStore.getState().notifications, 'message', seen),
      }
    },
  })

  commands.register<undefined, { paneId: string | null }>({
    id: 'attention.jumpToLatest',
    title: 'Jump to Latest Unread',
    category: 'View',
    target: 'none',
    run: () => ({ paneId: jumpToLatestUnread() }),
  })

  const blockStep = (id: string, title: string, dir: 'prev' | 'next'): void =>
    commands.register<undefined, { blockId: string | null }>({
      id,
      title,
      category: 'Terminal',
      capabilities: ['drive-self'],
      run: (_args, ctx) => ({
        blockId: ctx.activePaneId ? stepBlock(ctx.activePaneId, dir) : null,
      }),
    })
  blockStep('block.selectPrev', 'Select Previous Block', 'prev')
  blockStep('block.selectNext', 'Select Next Block', 'next')

  const blockCopy = (id: string, title: string, part: BlockPart): void =>
    commands.register<{ blockId?: string } | undefined, { copied: boolean }>({
      id,
      title,
      category: 'Terminal',
      capabilities: ['drive-self'],
      run: async (args, ctx) => ({
        copied: ctx.activePaneId ? await copyBlock(ctx.activePaneId, part, args?.blockId) : false,
      }),
    })
  blockCopy('block.copyCommand', 'Copy Block Command', 'command')
  blockCopy('block.copyOutput', 'Copy Block Output', 'output')
  blockCopy('block.copyBoth', 'Copy Block Command and Output', 'both')

  commands.register<{ blockId?: string } | undefined, { rerun: boolean }>({
    id: 'block.rerun',
    title: 'Rerun Block Command',
    category: 'Terminal',
    capabilities: ['shell'],
    run: (args, ctx) => ({
      rerun: ctx.activePaneId ? rerunBlock(ctx.activePaneId, args?.blockId) : false,
    }),
  })

  commands.register({
    id: 'history.search',
    title: 'Search Command History',
    category: 'Terminal',
    target: 'none',
    run: () => useHistorySearchStore.getState().setOpen(true),
  })

  commands.register({
    id: 'workflows.search',
    title: 'Workflows: Search',
    category: 'Workflows',
    target: 'none',
    run: (_args, ctx) => openWorkflowPicker(ctx.activeWorkspaceId, ctx.activePaneId),
  })

  commands.register<void, { inputMode: InputMode }>({
    id: 'terminal.toggleInputEditor',
    title: 'Toggle Input Editor',
    category: 'Terminal',
    target: 'none',
    capabilities: ['settings-write'],
    run: () => {
      const settings = useSettingsStore.getState()
      const inputMode = settings.behavior.inputMode === 'editor' ? 'terminal' : 'editor'
      settings.setBehavior({ inputMode })
      return { inputMode }
    },
  })

  commands.register<{ command: string }, { inserted: boolean }>({
    id: 'history.insert',
    title: 'Insert Command',
    hidden: true,
    capabilities: ['shell'],
    run: ({ command }, ctx) => ({
      inserted: ctx.activePaneId ? insertCommand(ctx.activePaneId, command) : false,
    }),
  })

  commands.register<{ text?: string } | undefined>({
    id: 'workspace.describe',
    title: 'Describe Workspace',
    category: 'Workspace',
    hidden: true,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      useWorkspacesStore.getState().describe(ctx.activeWorkspaceId, args?.text ?? '')
    },
  })

  commands.register<{ name: string }, { groupId: string | null }>({
    id: 'workspace.group',
    title: 'Move Workspace to Group',
    category: 'Workspace',
    hidden: true,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      if (typeof args?.name !== 'string' || !normalizeGroupName(args.name)) {
        throw new Error('missing group name')
      }
      const store = useWorkspacesStore.getState()
      store.moveToGroupNamed(ctx.activeWorkspaceId, args.name)
      const moved = useWorkspacesStore
        .getState()
        .workspaces.find((w) => w.id === ctx.activeWorkspaceId)
      return { groupId: moved?.groupId ?? null }
    },
  })

  commands.register({
    id: 'workspace.newGroup',
    title: 'Move Workspace to New Group',
    category: 'Workspace',
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) useWorkspacesStore.getState().createGroup(ctx.activeWorkspaceId)
    },
  })

  commands.register({
    id: 'workspace.ungroup',
    title: 'Remove Workspace from Group',
    category: 'Workspace',
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      useWorkspacesStore.getState().leaveGroup(ctx.activeWorkspaceId)
    },
  })

  commands.register({
    id: 'workspace.toggleGroup',
    title: 'Collapse or Expand Workspace Group',
    category: 'Workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const groupId = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)?.groupId
      const group = store.groups.find((g) => g.id === groupId)
      if (group) store.setGroupCollapsed(group.id, !group.collapsed)
    },
  })

  commands.register({
    id: 'workspace.deleteGroup',
    title: 'Delete Workspace Group',
    category: 'Workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const groupId = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)?.groupId
      if (groupId) store.deleteGroup(groupId)
    },
  })

  commands.register({
    id: 'workspace.togglePin',
    title: 'Pin or Unpin Workspace',
    category: 'Workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const current = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)
      if (current) store.setPinned(current.id, !current.pinned)
    },
  })

  commands.register({
    id: 'workspace.markRead',
    title: 'Mark Workspace as Read',
    category: 'Workspace',
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) markWorkspaceRead(ctx.activeWorkspaceId)
    },
  })

  commands.register({
    id: 'workspace.closeOthers',
    title: 'Close Other Workspaces',
    category: 'Workspace',
    capabilities: ['kill-pane'],
    run: async (_args, ctx) => {
      if (ctx.activeWorkspaceId) await requestCloseOthers(ctx.activeWorkspaceId)
    },
  })

  commands.register<{ index: number }, { switched: boolean }>({
    id: 'workspace.goto',
    title: 'Go to Workspace',
    category: 'Workspace',
    hidden: true,
    target: 'none',
    run: ({ index }) => ({ switched: goToWorkspace(index) }),
  })

  commands.register<{ dir?: unknown; name?: unknown } | undefined, { workspaceId: string | null }>({
    id: 'workspace.new',
    title: 'New Workspace',
    category: 'Workspace',
    target: 'none',
    argsSchema: {
      type: 'object',
      properties: { dir: { type: 'string' }, name: { type: 'string' } },
    },
    run: (args) => {
      const dir = args?.dir
      const name = args?.name
      if (dir !== undefined && (typeof dir !== 'string' || !WORKSPACE_DIR.test(dir))) {
        throw new Error('dir must be an absolute path or start with ~')
      }
      if (name !== undefined && typeof name !== 'string') throw new Error('name must be a string')
      useUIStore.getState().leaveSettings()
      return { workspaceId: startNewWorkspace({ dir, name }) }
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

  const zoomBy = (direction: 1 | -1): void => {
    const settings = useSettingsStore.getState()
    settings.setZoom(stepZoom(settings.appearance.zoom, direction))
  }

  commands.register({
    id: 'view.zoomIn',
    title: 'Zoom In',
    category: 'View',
    target: 'none',
    run: () => zoomBy(1),
  })

  commands.register({
    id: 'view.zoomOut',
    title: 'Zoom Out',
    category: 'View',
    target: 'none',
    run: () => zoomBy(-1),
  })

  commands.register({
    id: 'view.zoomReset',
    title: 'Reset Zoom',
    category: 'View',
    target: 'none',
    run: () => useSettingsStore.getState().setZoom(ZOOM_DEFAULT),
  })

  commands.register({
    id: 'app.openSettings',
    title: 'Open Settings',
    category: 'App',
    target: 'none',
    run: () => useUIStore.getState().openSettings(),
  })

  commands.register({
    id: 'assist.settings',
    title: 'Assistant: Settings',
    category: 'Assistant',
    target: 'none',
    run: () => useUIStore.getState().openSettings('assistant'),
  })

  commands.register({
    id: 'app.quit',
    title: `Quit ${PRODUCT_NAME}`,
    category: 'App',
    target: 'none',
    capabilities: ['destructive'],
    run: () => window.pine.window.quit(),
  })

  commands.register<{ path: string }>({
    id: 'editor.open',
    title: 'Open File',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: ({ path }, ctx) => {
      if (ctx.activeWorkspaceId && path)
        useLayoutStore.getState().openFile(ctx.activeWorkspaceId, path)
    },
  })

  commands.register<{ url?: string } | undefined>({
    id: 'browser.new',
    title: 'New Browser',
    hidden: true,
    capabilities: ['browse'],
    target: 'active',
    run: (args, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().openBrowser(ctx.activeWorkspaceId, args?.url || 'about:blank')
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

  commands.register<{ allWorkspaces?: boolean } | undefined, PaneListEntry[]>({
    id: 'pane.list',
    title: 'List Panes',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: (args, ctx) => {
      const workspaceIds = args?.allWorkspaces
        ? useWorkspacesStore.getState().workspaces.map((s) => s.id)
        : ctx.activeWorkspaceId
          ? [ctx.activeWorkspaceId]
          : []
      const byWorkspace = useLayoutStore.getState().byWorkspace
      const result: PaneListEntry[] = []
      for (const workspaceId of workspaceIds) {
        const layout = byWorkspace[workspaceId]
        if (!layout) continue
        for (const pane of allPanes(layout.root)) {
          result.push({
            paneId: pane.id,
            workspaceId,
            kind: pane.kind,
            title: pane.title,
            cwd: pane.cwd,
            ...(pane.kind === 'editor' && pane.filePath ? { filePath: pane.filePath } : {}),
          })
        }
      }
      return result
    },
  })

  commands.register<Record<string, never> | undefined, WorkspaceListEntry[]>({
    id: 'workspace.list',
    title: 'List Workspaces',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () =>
      useWorkspacesStore.getState().workspaces.map((s) => {
        const activePaneId = useLayoutStore.getState().byWorkspace[s.id]?.activePaneId
        return {
          workspaceId: s.id,
          name: s.name,
          kind: s.kind,
          workDir: s.workDir,
          state: s.state,
          ...(activePaneId ? { activePaneId } : {}),
          ...(s.groupId ? { groupId: s.groupId } : {}),
        }
      }),
  })

  commands.register<Record<string, never> | undefined, WorkspaceGroupEntry[]>({
    id: 'workspace.groups',
    title: 'List Workspace Groups',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () => {
      const { workspaces, groups } = useWorkspacesStore.getState()
      return groups.map((g) => ({
        groupId: g.id,
        name: g.name,
        ...(g.color ? { color: g.color } : {}),
        collapsed: Boolean(g.collapsed),
        workspaceIds: workspaces.filter((w) => w.groupId === g.id).map((w) => w.id),
      }))
    },
  })

  commands.register<undefined, { saved: boolean }>({
    id: 'workspace.save',
    title: 'Save Workspace',
    category: 'App',
    capabilities: ['settings-write'],
    target: 'none',
    run: () => {
      const enabled = useSettingsStore.getState().behavior.restoreWorkspace
      saveSnapshotNow()
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
      const state = readableSettings()
      const key = args?.key
      if (key && isKeybindingPath(key)) {
        const id = key.split('.').slice(1).join('.')
        return id ? state.keybindings[id] : state.keybindings
      }
      return key ? getByPath(state, key) : state
    },
  })

  commands.register<
    { key: string; value: unknown; dryRun?: boolean },
    { previous: unknown; value: unknown; applied: boolean }
  >({
    id: 'settings.set',
    title: 'Set Setting',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key, value, dryRun }) => {
      const program = launchesProgram(key, value)
      if (program) throw new Error(`${program} can only be changed by you in Settings`)
      if (isKeybindingPath(key)) {
        const previous = getByPath(readableSettings(), key) ?? null
        if (!dryRun) setKeybindingSetting(key, value, isMac)
        return { previous, value, applied: !dryRun }
      }
      const settings = useSettingsStore.getState()
      const change = dryRun ? settings.previewSetting(key, value) : settings.setByPath(key, value)
      return { ...settingResult(change), applied: !dryRun }
    },
  })

  commands.register<{ key: string }, { previous: unknown; value: unknown }>({
    id: 'settings.unset',
    title: 'Reset Setting',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key }) => {
      const program = launchesProgram(key, undefined)
      if (program) throw new Error(`${program} can only be changed by you in Settings`)
      return settingResult(useSettingsStore.getState().unsetByPath(key))
    },
  })

  commands.register<{ key?: string } | undefined, unknown>({
    id: 'settings.schema',
    title: 'Settings Schema',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => settingsSchemaAt(args?.key),
  })
}

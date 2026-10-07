import { type AgentResume, resumeCommand } from '@shared/agentResume'
import type { CmuxImportReport } from '@shared/cmuxSession'
import { wantsDesktopBanner } from '@shared/notificationSettings'
import { OPEN_FILES_COMMAND, parseFileTargets } from '@shared/openFiles'
import { PROGRAM_SETTINGS } from '@shared/programSettings'
import type { AttentionState } from '@shared/types'
import { type WorkspaceGroupColor, normalizeGroupName } from '@shared/workspaceGroups'
import { stepZoom } from '@shared/zoom'
import { currentDict } from '../i18n/useDict'
import {
  type DropZone,
  type FocusDirection,
  allPanes,
  findPane,
  splitTabOfPane,
  tabIdOf,
  tabNeighbor,
} from '../layout/tree'
import type { Direction, SurfaceKind } from '../layout/types'
import { postAgentNotification } from '../lib/agentNotification'
import {
  type BlockPart,
  copyBlock,
  insertCommand,
  rerunBlock,
  stepBlock,
} from '../lib/blockActions'
import { browserProfileIn, openerOf } from '../lib/browserProfile'
import { announceBusMessage } from '../lib/busNotice'
import { setKeybindingSetting } from '../lib/chords'
import { clearKeepingScrollback } from '../lib/clearTerminal'
import {
  closePaneForAgent,
  requestCloseOthers,
  requestClosePane,
  requestCloseWorkspace,
} from '../lib/closeConfirm'
import { runCmuxImport } from '../lib/cmuxImport'
import { focusActivePaneWhenReady } from '../lib/focusNewTerminal'
import { wakePane } from '../lib/hibernationScheduler'
import { mergeRefusalText } from '../lib/mergeRefusalText'
import { startNewWorkspace, startScratchWorkspace } from '../lib/newWorkspace'
import { openRequestedFiles } from '../lib/openFile'
import {
  FILES_PREFIX,
  GO_TO_FILE_COMMAND,
  GO_TO_WORKSPACE_COMMAND,
  GO_TO_WORKSPACE_SYMBOL_COMMAND,
  SYMBOLS_PREFIX,
  WORKSPACES_PREFIX,
} from '../lib/paletteModes'
import { type PaneAgentReport, isStaleAgentReport, paneAgentReport } from '../lib/paneAgent'
import { terminalFor } from '../lib/terminalHandles'
import { resetZoom } from '../lib/wheelZoom'
import { openWorkflowPicker } from '../lib/workflows'
import {
  focusAdjacentTab,
  focusPaneInDirection,
  goToWorkspace,
  isPaneViewed,
  jumpToLatestUnread,
  markWorkspaceRead,
  signalPane,
  stepWorkspace,
} from '../lib/workspaceActivity'
import { loadMergeTargets, requestMergeWorkspace } from '../lib/workspaceMerge'
import { anchorToFocusedPane, canMoveWorkspace, moveWorkspaceTo } from '../lib/workspaceProjects'
import { isMac } from '../platform'
import { keymapSettingValue, terminalKeymapSettingValue } from '../settings/keymapSetting'
import { settingsSchemaAt } from '../settings/settingsSchema'
import { useAgentTurnStore } from '../stores/agentTurnStore'
import { useAttentionStore } from '../stores/attentionStore'
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
import { useUpdateStore } from '../stores/updateStore'
import type { WorkspaceKind, WorkspaceState } from '../stores/workspacesStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { registerBrowserCommands } from './browserCommands'
import { type CoreCommandId, registerCore } from './core'
import { type CommandContext, commands } from './registry'

interface PaneListEntry extends PaneAgentReport {
  paneId: string
  workspaceId: string
  kind: SurfaceKind
  title: string
  cwd?: string
  filePath?: string
  splitTabId?: string
  splitTabName?: string
  hibernated?: true
}

interface WorkspaceListEntry {
  workspaceId: string
  name: string
  customName?: string
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

const HUMAN_ONLY_ROOTS: readonly string[] = ['privacy', 'terminalKeys']

export function launchesProgram(key: string, value: unknown): string | null {
  const path = key.split('.').filter(Boolean).join('.')
  const root = path.split('.')[0]
  if (HUMAN_ONLY_ROOTS.includes(root)) return root
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

const KEYMAP_KEY = 'keymap'
const TERMINAL_KEYMAP_KEY = 'terminalKeymap'

type TerminalHandle = NonNullable<ReturnType<typeof terminalFor>>

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
    keymap: s.keymap,
    terminalKeymap: s.terminalKeymap,
    keybindings: { ...s.keybindings },
    terminalKeys: { ...s.terminalKeys },
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

const PANE_FOCUS_COMMANDS: readonly (readonly [CoreCommandId, FocusDirection])[] = [
  ['pane.focusLeft', 'left'],
  ['pane.focusRight', 'right'],
  ['pane.focusUp', 'up'],
  ['pane.focusDown', 'down'],
]

function workspaceWithoutPanes(ctx: CommandContext, paneId?: string): string | null {
  const workspaceId = ctx.activeWorkspaceId
  if (!workspaceId || paneId || ctx.activePaneId) return null
  return useLayoutStore.getState().byWorkspace[workspaceId] ? null : workspaceId
}

function openFirstTerminal(ctx: CommandContext, workspaceId: string): void {
  useLayoutStore.getState().ensure(workspaceId)
  if (ctx.origin !== 'remote') focusActivePaneWhenReady(workspaceId)
}

const WORKSPACE_DIR = /^(\/|~(\/|$))/
const PANE_LOCKED = 'pane-locked: the human locked this pane; only they can unlock it'

export function registerBuiltinCommands(): void {
  registerBrowserCommands()
  commands.setContextProvider((): CommandContext => {
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
    const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
    return { activeWorkspaceId: workspaceId, activePaneId: layout?.activePaneId ?? null }
  })

  registerCore<{ paneId?: string; direction: Direction }>({
    id: 'pane.split',
    category: 'pane',
    hidden: true,
    run: ({ paneId, direction }, ctx) => {
      const empty = workspaceWithoutPanes(ctx, paneId)
      if (empty) {
        openFirstTerminal(ctx, empty)
        return
      }
      const target = paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().split(ctx.activeWorkspaceId, target, direction)
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(ctx.activeWorkspaceId)
      }
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'tab.new',
    category: 'pane',
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId && !args?.paneId) {
        const created = startNewWorkspace()
        if (created) openFirstTerminal(ctx, created)
        return
      }
      const empty = workspaceWithoutPanes(ctx, args?.paneId)
      if (empty) {
        openFirstTerminal(ctx, empty)
        return
      }
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'terminal')
        if (ctx.origin !== 'remote') focusActivePaneWhenReady(ctx.activeWorkspaceId)
      }
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'tab.newBrowser',
    category: 'pane',
    capabilities: ['browse'],
    run: (args, ctx) => {
      const empty = workspaceWithoutPanes(ctx, args?.paneId)
      if (empty) {
        const profile = browserProfileIn(empty, openerOf(ctx))
        useLayoutStore.getState().openBrowser(empty, 'about:blank', profile)
        return
      }
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        const profile = browserProfileIn(ctx.activeWorkspaceId, openerOf(ctx))
        useLayoutStore.getState().newTab(ctx.activeWorkspaceId, target, 'browser', profile)
      }
    },
  })

  registerCore({
    id: 'pane.splitRight',
    category: 'pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'horizontal' }),
  })

  registerCore({
    id: 'pane.splitDown',
    category: 'pane',
    run: (_args, ctx) => delegate(ctx, 'pane.split', { direction: 'vertical' }),
  })

  registerCore<{ paneId?: string }>({
    id: 'pane.close',
    category: 'pane',
    capabilities: ['kill-pane'],
    argsSchema: { type: 'object', properties: { paneId: { type: 'string' } } },
    run: async (args, ctx) => {
      if (args?.paneId !== undefined && typeof args.paneId !== 'string') {
        throw new Error('paneId must be a string')
      }
      if (args?.paneId === undefined && !ctx.target) {
        const ui = useUIStore.getState()
        if (ui.settingsActive) {
          ui.closeSettings()
          return
        }
        if (ui.dashboardActive) {
          ui.showWorkspaces()
          return
        }
      }
      if (!ctx.activeWorkspaceId) return
      const target = args?.paneId ?? ctx.activePaneId
      const layout = useLayoutStore.getState()
      if (args?.paneId !== undefined) {
        const tree = layout.byWorkspace[ctx.activeWorkspaceId]
        if (!tree || !findPane(tree.root, args.paneId)) {
          throw new Error(`unknown-pane: ${args.paneId}`)
        }
      }
      if (!target) {
        const empty = !args?.paneId && !layout.byWorkspace[ctx.activeWorkspaceId]
        if (empty && !ctx.target) await requestCloseWorkspace(ctx.activeWorkspaceId)
        return
      }
      if (!ctx.target) {
        await requestClosePane(ctx.activeWorkspaceId, target)
        return
      }
      if (layout.isLocked(ctx.activeWorkspaceId, target)) throw new Error(PANE_LOCKED)
      await closePaneForAgent(ctx.activeWorkspaceId, target)
    },
  })

  registerCore<{ paneId?: string } | undefined>({
    id: 'pane.toggleLock',
    category: 'pane',
    local: true,
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (!ctx.activeWorkspaceId || !target) return
      const layout = useLayoutStore.getState()
      layout.setLocked(
        ctx.activeWorkspaceId,
        target,
        !layout.isLocked(ctx.activeWorkspaceId, target),
      )
    },
  })

  registerCore<{ paneId: string }>({
    id: 'pane.focus',
    category: 'pane',
    hidden: true,
    run: ({ paneId }, ctx) => {
      if (ctx.activeWorkspaceId && paneId) {
        useLayoutStore.getState().focusPane(ctx.activeWorkspaceId, paneId)
      }
    },
  })

  for (const [id, direction] of PANE_FOCUS_COMMANDS) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        if (ctx.activeWorkspaceId && ctx.activePaneId) {
          focusPaneInDirection(ctx.activeWorkspaceId, ctx.activePaneId, direction)
        }
      },
    })
  }

  for (const [id, step] of [
    ['tab.next', 1],
    ['tab.previous', -1],
  ] as const) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        if (ctx.activeWorkspaceId && ctx.activePaneId) {
          focusAdjacentTab(ctx.activeWorkspaceId, ctx.activePaneId, step)
        }
      },
    })
  }

  for (const [id, step] of [
    ['tab.moveLeft', -1],
    ['tab.moveRight', 1],
  ] as const) {
    registerCore({
      id,
      category: 'pane',
      run: (_args, ctx) => {
        const workspaceId = ctx.activeWorkspaceId
        const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
        if (!workspaceId || !layout || !ctx.activePaneId) return
        const neighbor = tabNeighbor(layout.root, ctx.activePaneId, step)
        const source = tabIdOf(layout.root, ctx.activePaneId)
        if (!neighbor || !source) return
        useLayoutStore.getState().moveTab(workspaceId, source, neighbor, step === 1)
      },
    })
  }

  registerCore<{ paneId?: string; zoom?: boolean } | undefined>({
    id: 'pane.zoom',
    category: 'pane',
    run: (args, ctx) => {
      const target = args?.paneId ?? ctx.activePaneId
      if (ctx.activeWorkspaceId && target) {
        useLayoutStore.getState().zoomPane(ctx.activeWorkspaceId, target, args?.zoom)
      }
    },
  })

  registerCore<{ sourceId: string; targetId: string; zone: DropZone }>({
    id: 'pane.move',
    category: 'pane',
    hidden: true,
    run: ({ sourceId, targetId, zone }, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().movePane(ctx.activeWorkspaceId, sourceId, targetId, zone)
      }
    },
  })

  registerCore<{ sourceId: string; targetId: string; after: boolean }>({
    id: 'pane.moveTab',
    category: 'pane',
    hidden: true,
    run: ({ sourceId, targetId, after }, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore.getState().moveTab(ctx.activeWorkspaceId, sourceId, targetId, after)
      }
    },
  })

  registerCore<{ state: AttentionState; message?: string }>({
    id: 'attention.set',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: ({ state, message }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      if (isStaleAgentReport(ctx.activePaneId, state)) return
      useAgentTurnStore.getState().report(ctx.activePaneId, state)
      const seen = isPaneViewed(ctx.activePaneId)
      signalPane(ctx.activePaneId, { type: 'set', state, message, at: Date.now() })
      if (state === 'waiting' || state === 'done') {
        postAgentNotification(ctx.activePaneId, state, message, seen)
      }
    },
  })

  registerCore<undefined, { state?: AttentionState; message?: string }>({
    id: 'attention.peek',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      const attention = useAttentionStore.getState().byPane[ctx.activePaneId]
      if (!attention || attention.state === 'none') return {}
      return attention.message
        ? { state: attention.state, message: attention.message }
        : { state: attention.state }
    },
  })

  registerCore({
    id: 'attention.typed',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      useAttentionStore.getState().dispatch(ctx.activePaneId, { type: 'input', at: Date.now() })
    },
  })

  registerCore<AgentResume>({
    id: 'resume.set',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: (resume, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      useLayoutStore.getState().setResume(ctx.activeWorkspaceId, ctx.activePaneId, resume)
      useBlocksStore.getState().markAgent(ctx.activePaneId, resume.agent)
    },
  })

  registerCore<undefined, { resumed: boolean }>({
    id: 'agent.resume',
    category: 'pane',
    capabilities: ['shell'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) return { resumed: false }
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      if (pane?.kind !== 'terminal' || !pane.resume) return { resumed: false }
      if (pane.hibernated) return { resumed: wakePane(pane.id) }
      if (pane.resumeFolderMissing) return { resumed: false }
      return { resumed: insertCommand(pane.id, resumeCommand(pane.resume), true) }
    },
  })

  registerCore<undefined, { hibernated: boolean }>({
    id: 'pane.hibernated',
    category: 'pane',
    hidden: true,
    capabilities: ['read-board'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      const layout = useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]
      const pane = layout ? findPane(layout.root, ctx.activePaneId) : null
      return { hibernated: pane?.hibernated === true }
    },
  })

  registerCore<undefined, { woke: boolean }>({
    id: 'pane.wake',
    category: 'pane',
    hidden: true,
    capabilities: ['type-other-pane'],
    run: (_args, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      return { woke: wakePane(ctx.activePaneId) }
    },
  })

  registerCore<{ message: string }, { desktop: boolean }>({
    id: 'attention.notify',
    category: 'pane',
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

  registerCore<{ from?: unknown; text?: unknown }>({
    id: 'attention.message',
    category: 'pane',
    hidden: true,
    capabilities: ['notify'],
    run: ({ from, text }, ctx) => {
      if (!ctx.activePaneId) throw new Error('no target pane')
      announceBusMessage(ctx.activePaneId, from, text)
    },
  })

  registerCore<undefined, { paneId: string | null }>({
    id: 'attention.jumpToLatest',
    category: 'view',
    target: 'none',
    run: () => ({ paneId: jumpToLatestUnread() }),
  })

  const blockStep = (id: CoreCommandId, dir: 'prev' | 'next'): void =>
    registerCore<undefined, { blockId: string | null }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: (_args, ctx) => ({
        blockId: ctx.activePaneId ? stepBlock(ctx.activePaneId, dir) : null,
      }),
    })
  blockStep('block.selectPrev', 'prev')
  blockStep('block.selectNext', 'next')

  const scroll = (id: CoreCommandId, move: (term: TerminalHandle) => void): void =>
    registerCore<undefined, { scrolled: boolean }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: (_args, ctx) => {
        const term = ctx.activePaneId ? terminalFor(ctx.activePaneId) : undefined
        if (term) move(term)
        return { scrolled: term !== undefined }
      },
    })
  scroll('terminal.scrollToTop', (term) => term.scrollToTop())
  scroll('terminal.scrollToBottom', (term) => term.scrollToBottom())
  scroll('terminal.scrollPageUp', (term) => term.scrollPages(-1))
  scroll('terminal.scrollPageDown', (term) => term.scrollPages(1))
  scroll('terminal.scrollLineUp', (term) => term.scrollLines(-1))
  scroll('terminal.scrollLineDown', (term) => term.scrollLines(1))

  const blockCopy = (id: CoreCommandId, part: BlockPart): void =>
    registerCore<{ blockId?: string } | undefined, { copied: boolean }>({
      id,
      category: 'terminal',
      capabilities: ['drive-self'],
      run: async (args, ctx) => ({
        copied: ctx.activePaneId ? await copyBlock(ctx.activePaneId, part, args?.blockId) : false,
      }),
    })
  blockCopy('block.copyCommand', 'command')
  blockCopy('block.copyOutput', 'output')
  blockCopy('block.copyBoth', 'both')

  registerCore<{ blockId?: string } | undefined, { rerun: boolean }>({
    id: 'block.rerun',
    category: 'terminal',
    capabilities: ['shell'],
    run: (args, ctx) => ({
      rerun: ctx.activePaneId ? rerunBlock(ctx.activePaneId, args?.blockId) : false,
    }),
  })

  registerCore({
    id: 'history.search',
    category: 'terminal',
    target: 'none',
    run: () => useHistorySearchStore.getState().setOpen(true),
  })

  registerCore({
    id: 'workflows.search',
    category: 'workflows',
    target: 'none',
    run: (_args, ctx) => openWorkflowPicker(ctx.activeWorkspaceId, ctx.activePaneId),
  })

  registerCore<void, { inputMode: InputMode }>({
    id: 'terminal.toggleInputEditor',
    category: 'terminal',
    target: 'none',
    capabilities: ['settings-write'],
    run: () => {
      const settings = useSettingsStore.getState()
      const inputMode = settings.behavior.inputMode === 'editor' ? 'terminal' : 'editor'
      settings.setBehavior({ inputMode })
      return { inputMode }
    },
  })

  registerCore<void, { cleared: boolean }>({
    id: 'terminal.clear',
    category: 'terminal',
    capabilities: ['shell'],
    run: async (_args, ctx) => {
      const paneId = ctx.activePaneId
      const term = paneId ? terminalFor(paneId) : undefined
      if (!paneId || !term) return { cleared: false }
      const atPrompt = !useBlocksStore.getState().running[paneId]
      return { cleared: await clearKeepingScrollback(term, atPrompt) }
    },
  })

  registerCore<{ command: string }, { inserted: boolean }>({
    id: 'history.insert',
    hidden: true,
    capabilities: ['shell'],
    run: ({ command }, ctx) => ({
      inserted: ctx.activePaneId ? insertCommand(ctx.activePaneId, command) : false,
    }),
  })

  registerCore<{ text?: string } | undefined>({
    id: 'workspace.describe',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      useWorkspacesStore.getState().describe(ctx.activeWorkspaceId, args?.text ?? '')
    },
  })

  registerCore<{ name?: string } | undefined>({
    id: 'workspace.rename',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      useWorkspacesStore.getState().rename(ctx.activeWorkspaceId, args?.name ?? '')
    },
  })

  registerCore<{ title?: string } | undefined>({
    id: 'pane.rename',
    category: 'pane',
    hidden: true,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      useLayoutStore.getState().rename(ctx.activeWorkspaceId, ctx.activePaneId, args?.title ?? '')
    },
  })

  registerCore<{ name: string }, { groupId: string | null }>({
    id: 'workspace.group',
    category: 'workspace',
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

  registerCore({
    id: 'workspace.newGroup',
    category: 'workspace',
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) useWorkspacesStore.getState().createGroup(ctx.activeWorkspaceId)
    },
  })

  registerCore({
    id: 'workspace.ungroup',
    category: 'workspace',
    capabilities: ['drive-self'],
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      useWorkspacesStore.getState().leaveGroup(ctx.activeWorkspaceId)
    },
  })

  registerCore({
    id: 'workspace.toggleGroup',
    category: 'workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const groupId = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)?.groupId
      const group = store.groups.find((g) => g.id === groupId)
      if (group) store.setGroupCollapsed(group.id, !group.collapsed)
    },
  })

  registerCore({
    id: 'workspace.deleteGroup',
    category: 'workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const groupId = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)?.groupId
      if (groupId) store.deleteGroup(groupId)
    },
  })

  registerCore({
    id: 'workspace.togglePin',
    category: 'workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const current = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)
      if (current) store.setPinned(current.id, !current.pinned)
    },
  })

  registerCore({
    id: 'workspace.markRead',
    category: 'workspace',
    run: (_args, ctx) => {
      if (ctx.activeWorkspaceId) markWorkspaceRead(ctx.activeWorkspaceId)
    },
  })

  registerCore({
    id: 'workspace.useFocusedFolder',
    category: 'workspace',
    local: true,
    run: async (_args, ctx) => {
      if (ctx.activeWorkspaceId) await anchorToFocusedPane(ctx.activeWorkspaceId)
    },
  })

  registerCore<{ dir: string }>({
    id: 'workspace.setFolder',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    run: async (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      if (typeof args?.dir !== 'string' || !args.dir.startsWith('/')) {
        throw new Error('missing folder')
      }
      if (!canMoveWorkspace(ctx.activeWorkspaceId)) {
        throw new Error('fixed-folder: a sandboxed or scratch workspace keeps its folder')
      }
      if (!(await moveWorkspaceTo(ctx.activeWorkspaceId, args.dir))) {
        throw new Error('not-a-folder: the folder must exist under your home folder')
      }
    },
  })

  registerCore({
    id: 'workspace.closeOthers',
    category: 'workspace',
    capabilities: ['kill-pane'],
    run: async (_args, ctx) => {
      if (ctx.activeWorkspaceId) await requestCloseOthers(ctx.activeWorkspaceId)
    },
  })

  registerCore<{ argument?: string } | undefined, { merged: boolean }>({
    id: 'workspace.mergeInto',
    category: 'workspace',
    local: true,
    choices: async () => {
      const source = useWorkspacesStore.getState().activeWorkspaceId
      if (!source) return []
      const d = currentDict()
      return (await loadMergeTargets(source)).map((t) => {
        const reason = mergeRefusalText(d, t.refusal)
        return { value: t.id, label: t.name, ...(reason ? { disabledReason: reason } : {}) }
      })
    },
    emptyChoices: () => currentDict().merge.noTargets,
    run: async (args, ctx) => {
      const target = args?.argument
      if (!ctx.activeWorkspaceId || !target) return { merged: false }
      return { merged: await requestMergeWorkspace(ctx.activeWorkspaceId, target) }
    },
  })

  registerCore<{ index: number }, { switched: boolean }>({
    id: 'workspace.goto',
    category: 'workspace',
    hidden: true,
    target: 'none',
    run: ({ index }) => ({ switched: goToWorkspace(index) }),
  })

  registerCore<undefined, { switched: boolean }>({
    id: 'workspace.next',
    category: 'workspace',
    target: 'none',
    run: () => ({ switched: stepWorkspace(1) }),
  })

  registerCore<undefined, { switched: boolean }>({
    id: 'workspace.previous',
    category: 'workspace',
    target: 'none',
    run: () => ({ switched: stepWorkspace(-1) }),
  })

  registerCore<{ dir?: unknown; name?: unknown } | undefined, { workspaceId: string | null }>({
    id: 'workspace.new',
    category: 'workspace',
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
      useUIStore.getState().showWorkspaces()
      return { workspaceId: startNewWorkspace({ dir, name }) }
    },
  })

  registerCore<{ sandboxed?: unknown } | undefined, { workspaceId: string | null }>({
    id: 'workspace.newScratch',
    category: 'workspace',
    target: 'none',
    argsSchema: {
      type: 'object',
      properties: { sandboxed: { type: 'boolean' } },
    },
    run: async (args) => {
      const sandboxed = args?.sandboxed
      if (sandboxed !== undefined && typeof sandboxed !== 'boolean') {
        throw new Error('sandboxed must be a boolean')
      }
      useUIStore.getState().showWorkspaces()
      return { workspaceId: await startScratchWorkspace({ sandboxed }) }
    },
  })

  registerCore<{ path?: unknown } | undefined, CmuxImportReport>({
    id: 'workspace.importCmux',
    category: 'workspace',
    target: 'none',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
    },
    run: (args, ctx) => {
      const path = args?.path
      if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
        throw new Error('path must be an absolute path')
      }
      return runCmuxImport({
        ...(path === undefined ? {} : { path }),
        callerWorkspaceId: ctx.activeWorkspaceId,
        remote: ctx.origin === 'remote',
      })
    },
  })

  registerCore({
    id: 'palette.toggle',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().togglePalette(),
  })

  registerCore({
    id: GO_TO_FILE_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', FILES_PREFIX),
  })

  registerCore({
    id: GO_TO_WORKSPACE_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', WORKSPACES_PREFIX),
  })

  registerCore({
    id: GO_TO_WORKSPACE_SYMBOL_COMMAND,
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('search', SYMBOLS_PREFIX),
  })

  registerCore({
    id: 'view.toggleRail',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().toggleRail(),
  })

  registerCore({
    id: 'view.searchFiles',
    category: 'view',
    target: 'none',
    run: () => {
      const ui = useUIStore.getState()
      if (!ui.filesOpen) {
        ui.searchFiles()
        return
      }
      const focused = document.activeElement
      if (focused instanceof Element && focused.closest('#files-panel')) {
        ui.toggleFiles()
        const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
        if (workspaceId) focusActivePaneWhenReady(workspaceId)
        return
      }
      ui.searchFiles()
    },
  })

  const zoomBy = (direction: 1 | -1): void => {
    const settings = useSettingsStore.getState()
    settings.setZoom(stepZoom(settings.appearance.zoom, direction))
  }

  registerCore({
    id: 'view.zoomIn',
    category: 'view',
    target: 'none',
    run: () => zoomBy(1),
  })

  registerCore({
    id: 'view.zoomOut',
    category: 'view',
    target: 'none',
    run: () => zoomBy(-1),
  })

  registerCore({
    id: 'view.zoomReset',
    category: 'view',
    target: 'none',
    run: resetZoom,
  })

  registerCore({
    id: 'app.openSettings',
    category: 'app',
    target: 'none',
    run: () => useUIStore.getState().openSettings(),
  })

  registerCore({
    id: 'app.browseExtensions',
    category: 'app',
    target: 'none',
    run: () => useUIStore.getState().openSettings('browseExtensions'),
  })

  registerCore({
    id: 'dashboard.toggle',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().toggleDashboard(),
  })

  registerCore({
    id: 'assist.settings',
    category: 'assistant',
    target: 'none',
    run: () => useUIStore.getState().openSettings('assistant'),
  })

  registerCore({
    id: 'app.checkForUpdates',
    category: 'app',
    local: true,
    target: 'none',
    run: () => {
      useUIStore.getState().openSettings('about')
      void useUpdateStore.getState().checkForUpdates()
    },
  })

  registerCore({
    id: 'app.quit',
    category: 'app',
    target: 'none',
    capabilities: ['destructive'],
    run: () => window.ostia.window.quit(),
  })

  registerCore({
    id: 'developer.toggleDevTools',
    category: 'developer',
    target: 'none',
    capabilities: ['destructive'],
    run: () => window.ostia.diagnostics.toggleDevTools(),
  })

  registerCore<undefined, { opened: boolean }>({
    id: 'developer.openLogFolder',
    category: 'developer',
    target: 'none',
    capabilities: ['drive-self'],
    run: async () => ({ opened: await window.ostia.diagnostics.openLogFolder() }),
  })

  registerCore<{ path: string }>({
    id: 'editor.open',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: ({ path }, ctx) => {
      if (ctx.activeWorkspaceId && path)
        useLayoutStore.getState().openFile(ctx.activeWorkspaceId, path)
    },
  })

  registerCore<{ files?: unknown }>({
    id: OPEN_FILES_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: (args, ctx) => {
      const files = parseFileTargets(args?.files)
      if (!files) throw new Error('expected files: [{ path, line?, column? }]')
      if (ctx.activeWorkspaceId) {
        openRequestedFiles(ctx.activeWorkspaceId, files, ctx.activePaneId ?? undefined)
      }
    },
  })

  registerCore<{ url?: string } | undefined>({
    id: 'browser.new',
    hidden: true,
    capabilities: ['browse'],
    target: 'active',
    run: (args, ctx) => {
      if (ctx.activeWorkspaceId) {
        useLayoutStore
          .getState()
          .openBrowser(
            ctx.activeWorkspaceId,
            args?.url || 'about:blank',
            browserProfileIn(ctx.activeWorkspaceId, openerOf(ctx)),
          )
      }
    },
  })

  registerCore({
    id: 'browser.open',
    category: 'app',
    capabilities: ['browse'],
    run: (_args, ctx) => delegate(ctx, 'browser.new'),
  })

  registerCore<{ allWorkspaces?: boolean } | undefined, PaneListEntry[]>({
    id: 'pane.list',
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
          const splitTab = splitTabOfPane(layout.root, pane.id)
          result.push({
            paneId: pane.id,
            workspaceId,
            kind: pane.kind,
            title: pane.title,
            cwd: pane.cwd,
            ...(pane.kind === 'editor' && pane.filePath ? { filePath: pane.filePath } : {}),
            ...(pane.kind === 'terminal' ? paneAgentReport(pane.id, pane.resume) : {}),
            ...(splitTab ? { splitTabId: splitTab.id } : {}),
            ...(splitTab?.name ? { splitTabName: splitTab.name } : {}),
            ...(pane.hibernated ? { hibernated: true } : {}),
          })
        }
      }
      return result
    },
  })

  registerCore<Record<string, never> | undefined, WorkspaceListEntry[]>({
    id: 'workspace.list',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () =>
      useWorkspacesStore.getState().workspaces.map((s) => {
        const activePaneId = useLayoutStore.getState().byWorkspace[s.id]?.activePaneId
        return {
          workspaceId: s.id,
          name: s.name,
          ...(s.customName ? { customName: s.customName } : {}),
          kind: s.kind,
          workDir: s.workDir,
          state: s.state,
          ...(activePaneId ? { activePaneId } : {}),
          ...(s.groupId ? { groupId: s.groupId } : {}),
        }
      }),
  })

  registerCore<Record<string, never> | undefined, WorkspaceGroupEntry[]>({
    id: 'workspace.groups',
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

  registerCore<undefined, { saved: boolean }>({
    id: 'workspace.save',
    category: 'app',
    capabilities: ['settings-write'],
    target: 'none',
    run: () => {
      const enabled = useSettingsStore.getState().behavior.restoreWorkspace
      saveSnapshotNow()
      return { saved: enabled }
    },
  })

  registerCore<{ key?: string } | undefined, unknown>({
    id: 'settings.get',
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

  registerCore<
    { key: string; value: unknown; dryRun?: boolean },
    { previous: unknown; value: unknown; applied: boolean }
  >({
    id: 'settings.set',
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
      if (key === KEYMAP_KEY) {
        const previous = useSettingsStore.getState().keymap
        const next = keymapSettingValue(value)
        if (!dryRun) useSettingsStore.getState().setKeymap(next)
        return { previous, value: next, applied: !dryRun }
      }
      if (key === TERMINAL_KEYMAP_KEY) {
        const previous = useSettingsStore.getState().terminalKeymap
        const next = terminalKeymapSettingValue(value)
        if (!dryRun) useSettingsStore.getState().setTerminalKeymap(next)
        return { previous, value: next, applied: !dryRun }
      }
      const settings = useSettingsStore.getState()
      const change = dryRun ? settings.previewSetting(key, value) : settings.setByPath(key, value)
      return { ...settingResult(change), applied: !dryRun }
    },
  })

  registerCore<{ key: string }, { previous: unknown; value: unknown }>({
    id: 'settings.unset',
    hidden: true,
    capabilities: ['settings-write'],
    target: 'none',
    run: ({ key }) => {
      const program = launchesProgram(key, undefined)
      if (program) throw new Error(`${program} can only be changed by you in Settings`)
      if (key === KEYMAP_KEY) {
        const previous = useSettingsStore.getState().keymap
        useSettingsStore.getState().setKeymap(null)
        return { previous, value: null }
      }
      if (key === TERMINAL_KEYMAP_KEY) {
        const previous = useSettingsStore.getState().terminalKeymap
        useSettingsStore.getState().setTerminalKeymap(null)
        return { previous, value: null }
      }
      return settingResult(useSettingsStore.getState().unsetByPath(key))
    },
  })

  registerCore<{ key?: string } | undefined, unknown>({
    id: 'settings.schema',
    hidden: true,
    capabilities: ['settings-read'],
    target: 'none',
    run: (args) => settingsSchemaAt(args?.key),
  })
}

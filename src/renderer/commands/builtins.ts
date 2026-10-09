import { hibernateWorkspaces, resumeWorkspaces, wakePane } from '@/lib/agents/hibernationScheduler'
import { type PaneAgentReport, isStaleAgentReport, paneAgentReport } from '@/lib/agents/paneAgent'
import { resetZoom } from '@/lib/app/wheelZoom'
import { postAgentNotification } from '@/lib/attention/agentNotification'
import { announceBusMessage } from '@/lib/attention/busNotice'
import {
  focusAdjacentTab,
  focusPaneInDirection,
  goToWorkspace,
  isPaneViewed,
  jumpToLatestUnread,
  markWorkspaceRead,
  signalPane,
  stepWorkspace,
} from '@/lib/attention/workspaceActivity'
import { browserProfileIn, openerOf } from '@/lib/browser/browserProfile'
import { openArtifact, openPad } from '@/lib/files/artifacts'
import {
  markOpenedQuietly,
  openFilesQuietly,
  openPlaced,
  openRequestedFiles,
} from '@/lib/files/openFile'
import { waitOnPanes } from '@/lib/files/openWaits'
import { revealFolder } from '@/lib/files/revealFolder'
import { setKeybindingSetting } from '@/lib/keys/chords'
import {
  FILES_PREFIX,
  GO_TO_FILE_COMMAND,
  GO_TO_WORKSPACE_COMMAND,
  GO_TO_WORKSPACE_SYMBOL_COMMAND,
  SYMBOLS_PREFIX,
  WORKSPACES_PREFIX,
} from '@/lib/palette/paletteModes'
import { openWorkflowPicker } from '@/lib/palette/workflows'
import { callerHasFocus, openKeepingFocus, opensQuietly } from '@/lib/panes/callerFocus'
import { groupMates } from '@/lib/sidebar/groupPeers'
import {
  type BlockPart,
  copyBlock,
  insertCommand,
  rerunBlock,
  stepBlock,
} from '@/lib/terminal/blockActions'
import { clearKeepingScrollback } from '@/lib/terminal/clearTerminal'
import { focusActivePaneWhenReady } from '@/lib/terminal/focusNewTerminal'
import { terminalFor } from '@/lib/terminal/terminalHandles'
import {
  closePaneForAgent,
  requestCloseOthers,
  requestClosePane,
  requestCloseWorkspace,
} from '@/lib/workspaces/closeConfirm'
import { runCmuxImport } from '@/lib/workspaces/cmuxImport'
import { mergeRefusalText } from '@/lib/workspaces/mergeRefusalText'
import { startNewWorkspace, startScratchWorkspace } from '@/lib/workspaces/newWorkspace'
import { tabMoveRefusalText } from '@/lib/workspaces/tabMoveRefusalText'
import {
  activeTabId,
  moveTabToWorkspace,
  tabMoveRefusalFor,
  tabMoveTargets,
} from '@/lib/workspaces/tabWorkspaceMove'
import { loadMergeTargets, requestMergeWorkspace } from '@/lib/workspaces/workspaceMerge'
import {
  anchorToFocusedPane,
  canMoveWorkspace,
  moveWorkspaceTo,
} from '@/lib/workspaces/workspaceProjects'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useSandboxStore } from '@/stores/app/sandboxStore'
import {
  type InputMode,
  type SettingChange,
  getByPath,
  useSettingsStore,
} from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useUpdateStore } from '@/stores/app/updateStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useAgentTurnStore } from '@/stores/terminal/agentTurnStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useHistorySearchStore } from '@/stores/terminal/historySearchStore'
import { useHibernateSkippedStore } from '@/stores/workspaces/hibernateSkippedStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { saveSnapshotNow } from '@/stores/workspaces/persistence'
import type { WorkspaceKind, WorkspaceState } from '@/stores/workspaces/workspacesStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { type AgentResume, resumeCommand } from '@shared/agents/agentResume'
import { wantsDesktopBanner } from '@shared/app/notificationSettings'
import { stepZoom } from '@shared/app/zoom'
import { PAD_COMMAND } from '@shared/artifacts/artifacts'
import {
  OPEN_DIFF_COMMAND,
  OPEN_FILES_COMMAND,
  type OpenedPane,
  REVEAL_FOLDER_COMMAND,
  parseFileTargets,
  parsePlacement,
} from '@shared/files/openFiles'
import { PROGRAM_SETTINGS } from '@shared/permissions/programSettings'
import type { AttentionState } from '@shared/types'
import type { CmuxImportReport } from '@shared/workspaces/cmuxSession'
import { type WorkspaceGroupColor, normalizeGroupName } from '@shared/workspaces/workspaceGroups'
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
import { isMac } from '../platform'
import { keymapSettingValue, terminalKeymapSettingValue } from '../settings/keymapSetting'
import { settingsSchemaAt } from '../settings/settingsSchema'
import { registerBrowserCommands } from './browserCommands'
import { type CoreCommandId, registerCore } from './core'
import { registerGitCommands } from './gitCommands'
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

const HUMAN_ONLY_ROOTS: readonly string[] = [
  'privacy',
  'terminalKeys',
  'capabilities',
  'workspaceGroups',
]

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

async function hibernateAgents(workspaceIds: readonly string[]): Promise<string[]> {
  const report = await hibernateWorkspaces(workspaceIds)
  useHibernateSkippedStore.getState().show(report)
  return report.hibernated
}

function groupWorkspaceIds(workspaceId: string | null): string[] {
  if (!workspaceId) return []
  return groupMates(useWorkspacesStore.getState().workspaces, workspaceId).map((w) => w.id)
}

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
  registerGitCommands()
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
      const target =
        args?.paneId ??
        ctx.activePaneId ??
        (ctx.activeWorkspaceId
          ? useLayoutStore.getState().byWorkspace[ctx.activeWorkspaceId]?.activePaneId
          : null)
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
      if (!ctx.activeWorkspaceId) {
        if (args?.paneId !== undefined) throw new Error(`unknown-pane: ${args.paneId}`)
        return
      }
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

  registerCore<{ workspaceId: string }, { moved: string[] }>({
    id: 'pane.moveToWorkspace',
    category: 'pane',
    hidden: true,
    capabilities: ['all-workspaces', 'type-other-pane'],
    argsSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
    run: async (args, ctx) => {
      const source = ctx.activeWorkspaceId
      const paneId = ctx.activePaneId
      if (!source || !paneId) throw new Error('no target pane')
      if (typeof args?.workspaceId !== 'string') throw new Error('workspaceId must be a string')
      const refusal = tabMoveRefusalFor(source, paneId, args.workspaceId)
      if (refusal) throw new Error(`${refusal}: ${currentDict().tabMove[refusal]}`)
      if (!(await moveTabToWorkspace(source, paneId, args.workspaceId))) {
        throw new Error('move-failed: the pane did not move')
      }
      return { moved: [paneId] }
    },
  })

  registerCore<{ argument?: string } | undefined, { moved: boolean }>({
    id: 'tab.moveToWorkspace',
    category: 'pane',
    local: true,
    choices: async () => {
      const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
      const tabId = workspaceId ? activeTabId(workspaceId) : null
      if (!workspaceId || !tabId) return []
      const d = currentDict()
      return tabMoveTargets(workspaceId, tabId).map((t) => {
        const reason = tabMoveRefusalText(d, t.refusal)
        return { value: t.id, label: t.name, ...(reason ? { disabledReason: reason } : {}) }
      })
    },
    emptyChoices: () => currentDict().tabMove.noTargets,
    run: async (args, ctx) => {
      const target = args?.argument
      const tabId = ctx.activeWorkspaceId ? activeTabId(ctx.activeWorkspaceId) : null
      if (!ctx.activeWorkspaceId || !tabId || !target) return { moved: false }
      return { moved: await moveTabToWorkspace(ctx.activeWorkspaceId, tabId, target) }
    },
  })

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

  registerCore<undefined, { hibernated: string[] }>({
    id: 'workspace.hibernateAgents',
    category: 'workspace',
    local: true,
    run: async (_args, ctx) => ({
      hibernated: await hibernateAgents(ctx.activeWorkspaceId ? [ctx.activeWorkspaceId] : []),
    }),
  })

  registerCore<undefined, { resumed: string[] }>({
    id: 'workspace.resumeAgents',
    category: 'workspace',
    local: true,
    run: (_args, ctx) => ({
      resumed: resumeWorkspaces(ctx.activeWorkspaceId ? [ctx.activeWorkspaceId] : []),
    }),
  })

  registerCore<undefined, { hibernated: string[] }>({
    id: 'workspace.hibernateGroupAgents',
    category: 'workspace',
    local: true,
    run: async (_args, ctx) => ({
      hibernated: await hibernateAgents(groupWorkspaceIds(ctx.activeWorkspaceId)),
    }),
  })

  registerCore<undefined, { resumed: string[] }>({
    id: 'workspace.resumeGroupAgents',
    category: 'workspace',
    local: true,
    run: (_args, ctx) => ({ resumed: resumeWorkspaces(groupWorkspaceIds(ctx.activeWorkspaceId)) }),
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

  registerCore<{ argument?: string } | undefined, { opened: boolean }>({
    id: 'artifacts.open',
    local: true,
    choices: async () => {
      const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
      if (!workspaceId) return []
      await useArtifactsStore.getState().refresh(workspaceId)
      const entries = useArtifactsStore.getState().byWorkspace[workspaceId]?.entries ?? []
      return entries.map((entry) => ({ value: entry.path, label: entry.name }))
    },
    emptyChoices: () => currentDict().artifacts.none,
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      const entries = workspaceId
        ? (useArtifactsStore.getState().byWorkspace[workspaceId]?.entries ?? [])
        : []
      const entry = entries.find((e) => e.path === args?.argument)
      if (!workspaceId || !entry) return { opened: false }
      openArtifact(workspaceId, entry)
      return { opened: true }
    },
  })

  registerCore<undefined, { opened: boolean }>({
    id: PAD_COMMAND,
    category: 'workspace',
    local: true,
    run: async (_args, ctx) => ({
      opened: ctx.activeWorkspaceId ? await openPad(ctx.activeWorkspaceId) : false,
    }),
  })

  registerCore<undefined, { revealed: boolean }>({
    id: 'artifacts.reveal',
    local: true,
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId) return { revealed: false }
      window.ostia.artifacts.reveal(ctx.activeWorkspaceId)
      return { revealed: true }
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

  registerCore<
    { dir?: unknown; name?: unknown; focus?: unknown; group?: unknown } | undefined,
    { workspaceId: string | null }
  >({
    id: 'workspace.new',
    category: 'workspace',
    target: 'none',
    argsSchema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        name: { type: 'string' },
        focus: { type: 'boolean' },
        group: { type: 'string' },
      },
    },
    run: (args) => {
      const dir = args?.dir
      const name = args?.name
      const focus = args?.focus
      const group = args?.group
      if (dir !== undefined && (typeof dir !== 'string' || !WORKSPACE_DIR.test(dir))) {
        throw new Error('dir must be an absolute path or start with ~')
      }
      if (name !== undefined && typeof name !== 'string') throw new Error('name must be a string')
      if (focus !== undefined && typeof focus !== 'boolean') {
        throw new Error('focus must be a boolean')
      }
      if (group !== undefined && (typeof group !== 'string' || !normalizeGroupName(group))) {
        throw new Error('group must be a group name')
      }
      if (focus !== false) useUIStore.getState().showWorkspaces()
      const workspaceId = startNewWorkspace({ dir, name, focus: focus !== false })
      if (workspaceId && group) useWorkspacesStore.getState().moveToGroupNamed(workspaceId, group)
      return { workspaceId }
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
    id: 'palette.searchEverywhere',
    category: 'view',
    target: 'none',
    run: () => useUIStore.getState().openPalette('everywhere'),
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

  registerCore<
    { files?: unknown; background?: unknown; placement?: unknown; wait?: unknown },
    { opened: OpenedPane[] }
  >({
    id: OPEN_FILES_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: (args, ctx) => {
      const files = parseFileTargets(args?.files)
      if (!files) throw new Error('expected files: [{ path, line?, column? }]')
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) return { opened: [] }
      const paneId = ctx.activePaneId ?? undefined
      const quiet = opensQuietly(ctx, args?.background)
      const wait = args?.wait === true
      const placement = wait ? 'tab' : parsePlacement(args?.placement)
      if (!placement) {
        if (quiet) openFilesQuietly(workspaceId, files, paneId)
        else openRequestedFiles(workspaceId, files, paneId)
        return { opened: [] }
      }
      const opened = openPlaced(workspaceId, files, paneId, { placement, quiet, fresh: wait })
      if (wait) waitOnPanes(workspaceId, paneId, opened)
      return { opened }
    },
  })

  registerCore<
    {
      title?: unknown
      original?: unknown
      modified?: unknown
      path?: unknown
      background?: unknown
    },
    { opened: OpenedPane[] }
  >({
    id: OPEN_DIFF_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (
        typeof args?.title !== 'string' ||
        typeof args.original !== 'string' ||
        typeof args.modified !== 'string' ||
        typeof args.path !== 'string'
      ) {
        throw new Error('expected { title, original, modified, path }')
      }
      if (!workspaceId) return { opened: [] }
      const content = {
        title: args.title,
        original: args.original,
        modified: args.modified,
        path: args.path,
      }
      const open = (): string | null => {
        const before = useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
        const paneId = useLayoutStore.getState().openDiff(workspaceId, content)
        if (quiet && before && paneId) useLayoutStore.getState().focusPane(workspaceId, before)
        return paneId
      }
      const quiet = opensQuietly(ctx, args.background)
      const paneId = quiet ? openKeepingFocus(open) : open()
      if (!paneId) return { opened: [] }
      if (quiet) markOpenedQuietly(paneId, content.title)
      return { opened: [{ path: content.path, paneId }] }
    },
  })

  registerCore<{ path?: unknown }, { revealed: boolean }>({
    id: REVEAL_FOLDER_COMMAND,
    hidden: true,
    capabilities: ['drive-self'],
    target: 'active',
    run: async (args, ctx) => {
      if (typeof args?.path !== 'string' || !args.path.startsWith('/')) {
        throw new Error('expected path: an absolute folder path')
      }
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) return { revealed: false }
      if (ctx.origin === 'remote' && useSandboxStore.getState().enabled[workspaceId] === true) {
        throw new Error('outside-sandbox: a sandboxed workspace cannot show folders')
      }
      if ((await window.ostia.fs.stat(args.path)) !== 'dir') {
        throw new Error('not-a-directory: no such folder inside the file roots')
      }
      revealFolder(workspaceId, args.path)
      return { revealed: true }
    },
  })

  registerCore<{ url?: string; background?: unknown } | undefined>({
    id: 'browser.new',
    hidden: true,
    capabilities: ['browse'],
    target: 'active',
    run: (args, ctx) => {
      const workspaceId = ctx.activeWorkspaceId
      if (!workspaceId) return
      const url = args?.url || 'about:blank'
      const profile = browserProfileIn(workspaceId, openerOf(ctx))
      const show = (): void => useLayoutStore.getState().openBrowser(workspaceId, url, profile)
      if (args?.background !== true) {
        if (callerHasFocus(ctx)) show()
        else openKeepingFocus(show)
        return
      }
      const opened = openKeepingFocus(() =>
        useLayoutStore
          .getState()
          .openBrowserTab(workspaceId, url, profile, { beside: ctx.activePaneId ?? undefined }),
      )
      if (opened) markOpenedQuietly(opened, url)
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

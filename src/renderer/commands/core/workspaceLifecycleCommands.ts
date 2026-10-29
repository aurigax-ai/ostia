import { PAD_COMMAND } from '@shared/artifacts/artifacts'
import type { CmuxImportReport } from '@shared/workspaces/cmuxSession'
import { normalizeGroupName } from '@shared/workspaces/workspaceGroups'
import { registerCore } from '@/commands/coreCommand'
import { hibernateWorkspaces, resumeWorkspaces } from '@/lib/agents/hibernationScheduler'
import { currentDict } from '@/lib/app/useDict'
import { markWorkspaceRead } from '@/lib/attention/workspaceActivity'
import { openArtifact, openPad } from '@/lib/files/artifacts'
import { callerHasFocus } from '@/lib/panes/callerFocus'
import { useRemoteStore } from '@/lib/remote/remoteStore'
import { groupMates } from '@/lib/sidebar/groupPeers'
import {
  closeBlockers,
  requestCloseOthers,
  requestCloseWorkspace,
} from '@/lib/workspaces/closeConfirm'
import { runCmuxImport } from '@/lib/workspaces/cmuxImport'
import { mergeRefusalText } from '@/lib/workspaces/mergeRefusalText'
import { startNewWorkspace, startScratchWorkspace } from '@/lib/workspaces/newWorkspace'
import { goToWorkspace, stepWorkspace } from '@/lib/workspaces/selectWorkspace'
import { loadMergeTargets, requestMergeWorkspace } from '@/lib/workspaces/workspaceMerge'
import {
  anchorToFocusedPane,
  canMoveWorkspace,
  moveWorkspaceTo,
} from '@/lib/workspaces/workspaceProjects'
import { useUIStore } from '@/stores/app/uiStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useHibernateSkippedStore } from '@/stores/workspaces/hibernateSkippedStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

async function hibernateAgents(workspaceIds: readonly string[]): Promise<string[]> {
  const report = await hibernateWorkspaces(workspaceIds)
  useHibernateSkippedStore.getState().show(report)
  return report.hibernated
}

function groupWorkspaceIds(workspaceId: string | null): string[] {
  if (!workspaceId) return []
  return groupMates(useWorkspacesStore.getState().workspaces, workspaceId).map((w) => w.id)
}

const WORKSPACE_DIR = /^(\/|~(\/|$))/

function registerHibernateCommands(): void {
  registerCore<undefined, { hibernated: string[] }>({
    id: 'workspace.hibernateAgents',
    category: 'workspace',
    local: true,
    capabilities: ['kill-pane'],
    run: async (_args, ctx) => ({
      hibernated: await hibernateAgents(ctx.activeWorkspaceId ? [ctx.activeWorkspaceId] : []),
    }),
  })

  registerCore<undefined, { resumed: string[] }>({
    id: 'workspace.resumeAgents',
    category: 'workspace',
    local: true,
    capabilities: ['type-other-pane'],
    run: (_args, ctx) => ({
      resumed: resumeWorkspaces(ctx.activeWorkspaceId ? [ctx.activeWorkspaceId] : []),
    }),
  })

  registerCore<undefined, { hibernated: string[] }>({
    id: 'workspace.hibernateGroupAgents',
    category: 'workspace',
    local: true,
    capabilities: ['kill-pane'],
    run: async (_args, ctx) => ({
      hibernated: await hibernateAgents(groupWorkspaceIds(ctx.activeWorkspaceId)),
    }),
  })

  registerCore<undefined, { resumed: string[] }>({
    id: 'workspace.resumeGroupAgents',
    category: 'workspace',
    local: true,
    capabilities: ['type-other-pane'],
    run: (_args, ctx) => ({ resumed: resumeWorkspaces(groupWorkspaceIds(ctx.activeWorkspaceId)) }),
  })
}

function registerRemoteCommands(): void {
  registerCore({
    id: 'workspace.remoteJobs',
    category: 'workspace',
    local: true,
    run: (_args, ctx) => useRemoteStore.getState().openJobs(ctx.activeWorkspaceId),
  })
}

function registerPinFolderAndCloseCommands(): void {
  registerCore({
    id: 'workspace.togglePin',
    category: 'workspace',
    run: (_args, ctx) => {
      const store = useWorkspacesStore.getState()
      const current = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)
      if (current) store.setPinned(current.id, !current.pinned)
    },
  })

  for (const [id, pinned] of [
    ['workspace.pin', true],
    ['workspace.unpin', false],
  ] as const) {
    registerCore({
      id,
      category: 'workspace',
      hidden: true,
      capabilities: ['drive-self'],
      run: (_args, ctx) => {
        const store = useWorkspacesStore.getState()
        const current = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)
        if (!current) throw new Error('no target workspace')
        if (Boolean(current.pinned) !== pinned) store.setPinned(current.id, pinned)
      },
    })
  }

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
    id: 'workspace.close',
    category: 'workspace',
    capabilities: ['kill-pane'],
    run: async (_args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      if (!ctx.target) {
        await requestCloseWorkspace(ctx.activeWorkspaceId)
        return
      }
      const workspace = useWorkspacesStore
        .getState()
        .workspaces.find((w) => w.id === ctx.activeWorkspaceId)
      if (!workspace) throw new Error(`unknown-workspace: ${ctx.activeWorkspaceId}`)
      if (workspace.kind === 'manager') throw new Error('manager: the manager workspace stays open')
      if (useLayoutStore.getState().isLocked(workspace.id)) {
        throw new Error('pane-locked: the human locked a pane in this workspace')
      }
      const blockers = await closeBlockers(workspace)
      if (blockers) {
        const still = [
          ...(blockers.agents ?? []).map((a) => `agent ${a || '?'}`),
          ...blockers.commands.map((c) => `command ${c || '?'}`),
          ...blockers.files.map((f) => `unsaved ${f}`),
          ...(blockers.scratchFiles ? [`${blockers.scratchFiles} scratch files`] : []),
        ]
        throw new Error(
          `busy: workspace ${workspace.id} still has ${still.join(', ')}; stop or close those first, or let the human close it`,
        )
      }
      useWorkspacesStore.getState().closeWorkspace(workspace.id)
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
}

function registerMergeAndArtifactCommands(): void {
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
}

function registerSwitchAndCreateCommands(): void {
  registerCore<{ index: number }, { switched: boolean }>({
    id: 'workspace.goto',
    category: 'workspace',
    hidden: true,
    target: 'none',
    run: ({ index }, ctx) => ({ switched: goToWorkspace(index, ctx.origin !== 'remote') }),
  })

  registerCore<undefined, { switched: boolean }>({
    id: 'workspace.next',
    category: 'workspace',
    target: 'none',
    run: (_args, ctx) => ({ switched: stepWorkspace(1, ctx.origin !== 'remote') }),
  })

  registerCore<undefined, { switched: boolean }>({
    id: 'workspace.previous',
    category: 'workspace',
    target: 'none',
    run: (_args, ctx) => ({ switched: stepWorkspace(-1, ctx.origin !== 'remote') }),
  })

  registerCore<
    | { dir?: unknown; name?: unknown; focus?: unknown; group?: unknown; ungrouped?: unknown }
    | undefined,
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
        ungrouped: { type: 'boolean' },
      },
    },
    run: (args, ctx) => {
      const dir = args?.dir
      const name = args?.name
      const focus = args?.focus
      const group = args?.group
      const ungrouped = args?.ungrouped
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
      if (ungrouped !== undefined && typeof ungrouped !== 'boolean') {
        throw new Error('ungrouped must be a boolean')
      }
      const takesKeyboard = focus !== false && (ctx.activePaneId === null || callerHasFocus(ctx))
      if (takesKeyboard) useUIStore.getState().showWorkspaces()
      const workspaceId = startNewWorkspace({ dir, name, focus: takesKeyboard, ungrouped })
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
}

export function registerWorkspaceLifecycleCommands(): void {
  registerHibernateCommands()
  registerRemoteCommands()
  registerPinFolderAndCloseCommands()
  registerMergeAndArtifactCommands()
  registerSwitchAndCreateCommands()
}

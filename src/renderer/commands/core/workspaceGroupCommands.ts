import {
  isWorkspaceGroupColor,
  normalizeGroupName,
  WORKSPACE_GROUP_COLORS,
} from '@shared/workspaces/workspaceGroups'
import { registerCore } from '@/commands/coreCommand'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { usePaneRenameStore } from '@/stores/workspaces/paneRenameStore'
import { type RailEdit, revealRailEdit } from '@/stores/workspaces/railEditStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

function namedGroup(raw: unknown) {
  const name = normalizeGroupName(raw)
  const found = useWorkspacesStore.getState().groups.filter((g) => g.name === name)
  if (found.length === 0) throw new Error(`no group named '${String(raw)}'`)
  if (found.length > 1) throw new Error(`ambiguous: ${found.length} groups are named '${name}'`)
  return found[0]
}

function railShown(): boolean {
  return !useWindowsStore.getState().detached
}

function editInRail(edit: RailEdit): void {
  if (!railShown()) throw new Error('this window has no workspace sidebar')
  revealRailEdit(edit)
}

function registerRenameCommands(): void {
  registerCore({
    id: 'workspace.describe',
    category: 'workspace',
    listed: railShown,
    local: true,
    run: (_args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      editInRail({ kind: 'workspace', id: ctx.activeWorkspaceId, field: 'description' })
    },
  })

  registerCore<{ name?: string } | undefined>({
    id: 'workspace.rename',
    category: 'workspace',
    listed: railShown,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId) throw new Error('no target workspace')
      if (typeof args?.name !== 'string' && ctx.origin !== 'remote') {
        editInRail({ kind: 'workspace', id: ctx.activeWorkspaceId, field: 'name' })
        return
      }
      useWorkspacesStore.getState().rename(ctx.activeWorkspaceId, args?.name ?? '')
    },
  })

  registerCore<{ name?: string } | undefined>({
    id: 'workspace.renameGroup',
    category: 'workspace',
    listed: railShown,
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      const store = useWorkspacesStore.getState()
      const groupId = store.workspaces.find((w) => w.id === ctx.activeWorkspaceId)?.groupId
      const group = store.groups.find((g) => g.id === groupId)
      if (!group) throw new Error('workspace is not in a group')
      if (typeof args?.name !== 'string') {
        if (ctx.origin === 'remote') throw new Error('missing name')
        editInRail({ kind: 'group', id: group.id })
        return
      }
      store.renameGroup(group.id, args.name)
    },
  })

  registerCore<{ title?: string } | undefined>({
    id: 'pane.rename',
    category: 'pane',
    capabilities: ['drive-self'],
    run: (args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) throw new Error('no target pane')
      if (typeof args?.title !== 'string') {
        usePaneRenameStore.getState().begin(ctx.activePaneId)
        return
      }
      useLayoutStore.getState().rename(ctx.activeWorkspaceId, ctx.activePaneId, args.title)
    },
  })
}

function registerGroupCommands(): void {
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

  registerCore<{ group: string; color: string | null }>({
    id: 'workspace.groupColor',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'none',
    run: (args) => {
      const color = args?.color ?? null
      if (color !== null && !isWorkspaceGroupColor(color)) {
        throw new Error(`unknown color '${color}' (one of ${WORKSPACE_GROUP_COLORS.join(', ')})`)
      }
      const name = normalizeGroupName(args?.group)
      const store = useWorkspacesStore.getState()
      const group = store.groups.find((g) => g.name === name)
      if (!group) throw new Error(`no group named '${args?.group}'`)
      store.setGroupColor(group.id, color)
    },
  })

  registerCore<{ group: string; name: string }>({
    id: 'workspace.groupRename',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'none',
    run: (args) => {
      const name = normalizeGroupName(args?.name)
      if (!name) throw new Error('missing group name')
      const store = useWorkspacesStore.getState()
      const group = namedGroup(args?.group)
      if (group.name !== name && store.groups.some((g) => g.name === name)) {
        throw new Error(`a group named '${name}' already exists`)
      }
      store.renameGroup(group.id, name)
    },
  })

  registerCore<{ group: string }>({
    id: 'workspace.groupDelete',
    category: 'workspace',
    hidden: true,
    capabilities: ['drive-self'],
    target: 'none',
    run: (args) => {
      useWorkspacesStore.getState().deleteGroup(namedGroup(args?.group).id)
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
}

export function registerWorkspaceGroupCommands(): void {
  registerRenameCommands()
  registerGroupCommands()
}

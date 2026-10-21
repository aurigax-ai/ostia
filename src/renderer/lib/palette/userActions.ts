import { DEFAULT_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { type CommandContext, commands, wordedBy } from '@/commands/registry'
import { currentDict, fmt } from '@/lib/app/useDict'
import { findPane } from '@/lib/layout/tree'
import { actionFingerprint, fillArgs, type UserAction } from '@/lib/settings/actions'
import { useActionConfirmStore } from '@/stores/agents/actionConfirmStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

const ACTION_COMMAND_PREFIX = 'action.'

export type CommandAction = Pick<UserAction, 'id' | 'title' | 'command' | 'args'> & {
  origin?: string
}

export function needsTrust(action: Pick<UserAction, 'command'>): boolean {
  const desc = commands.describe().find((c) => c.id === action.command)
  if (!desc) return false
  return desc.capabilities.some((cap) => !DEFAULT_CAPABILITIES.includes(cap))
}

function paneContext(paneId: string | null): { cwd?: string; file?: string } {
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  const layout = workspaceId ? useLayoutStore.getState().byWorkspace[workspaceId] : undefined
  const pane = layout && paneId ? findPane(layout.root, paneId) : null
  return { cwd: pane?.cwd, file: pane?.kind === 'editor' ? pane.filePath : undefined }
}

export function runUserAction(
  action: UserAction,
  paneId: string | null,
  ctx?: CommandContext,
): Promise<void> {
  return runCommandAction(action, paneId, fillArgs(action.args, paneContext(paneId)), ctx)
}

export async function runCommandAction(
  action: CommandAction,
  paneId: string | null,
  args: Record<string, unknown> | undefined,
  ctx?: CommandContext,
): Promise<void> {
  if (!commands.has(action.command)) {
    notifyFailure(
      action,
      paneId,
      fmt(currentDict().actions.unknownCommand, { command: action.command }),
    )
    return
  }
  const refused = ctx ? commands.refusalFor(ctx, action.command) : null
  if (refused) {
    notifyFailure(action, paneId, refused)
    return
  }
  if (needsTrust(action)) {
    const fingerprint = actionFingerprint(action)
    if (!useSettingsStore.getState().trustedActions.includes(fingerprint)) {
      const answer = await useActionConfirmStore.getState().ask(action, args)
      if (answer === 'cancel') return
      if (answer === 'trust') useSettingsStore.getState().trustAction(fingerprint)
    }
  }
  const workspaceId = useWorkspacesStore.getState().activeWorkspaceId
  if (workspaceId && paneId) useLayoutStore.getState().focusPane(workspaceId, paneId)
  const res = ctx
    ? await commands.execWith(ctx, action.command, args)
    : await commands.exec(action.command, args)
  if (!res.ok) notifyFailure(action, paneId, res.error.message)
  else if (paneId) requestAnimationFrame(() => focusSurface(paneId))
}

function notifyFailure(action: CommandAction, paneId: string | null, message: string): void {
  if (!paneId) {
    console.error(`[actions] ${action.id}: ${message}`)
    return
  }
  window.ostia.notifications.post({
    paneId,
    kind: 'error',
    title: fmt(currentDict().actions.failed, { title: action.title }),
    body: message,
    desktop: false,
  })
}

export function startUserActions(): () => void {
  let registered: string[] = []
  let last: UserAction[] | null = null
  const sync = (actions: UserAction[]): void => {
    if (actions === last) return
    last = actions
    for (const id of registered) commands.unregister(id)
    registered = []
    for (const action of actions) {
      const id = `${ACTION_COMMAND_PREFIX}${action.id}`
      if (commands.has(id)) continue
      commands.register({
        id,
        ...wordedBy((d) => ({ title: action.title, category: d.actions.category })),
        target: 'active',
        run: (_args, ctx) => runUserAction(action, ctx.activePaneId, ctx),
      })
      registered.push(id)
    }
  }
  sync(useSettingsStore.getState().actions)
  return useSettingsStore.subscribe((s) => sync(s.actions))
}

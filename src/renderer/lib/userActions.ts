import { DEFAULT_CAPABILITIES } from '@shared/capabilities'
import { commands } from '../commands/registry'
import { currentDict, fmt } from '../i18n/useDict'
import { findPane } from '../layout/tree'
import { type UserAction, actionFingerprint, fillArgs } from '../settings/actions'
import { useActionConfirmStore } from '../stores/actionConfirmStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export const ACTION_COMMAND_PREFIX = 'action.'

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

export function runUserAction(action: UserAction, paneId: string | null): Promise<void> {
  return runCommandAction(action, paneId, fillArgs(action.args, paneContext(paneId)))
}

export async function runCommandAction(
  action: CommandAction,
  paneId: string | null,
  args: Record<string, unknown> | undefined,
): Promise<void> {
  if (!commands.has(action.command)) {
    notifyFailure(
      action,
      paneId,
      fmt(currentDict().actions.unknownCommand, { command: action.command }),
    )
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
  const res = await commands.exec(action.command, args)
  if (!res.ok) notifyFailure(action, paneId, res.error.message)
  else if (paneId) requestAnimationFrame(() => focusSurface(paneId))
}

function notifyFailure(action: CommandAction, paneId: string | null, message: string): void {
  if (!paneId) {
    console.error(`[actions] ${action.id}: ${message}`)
    return
  }
  window.pine.notifications.post({
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
        title: action.title,
        category: currentDict().actions.category,
        target: 'active',
        run: (_args, ctx) => runUserAction(action, ctx.activePaneId),
      })
      registered.push(id)
    }
  }
  sync(useSettingsStore.getState().actions)
  return useSettingsStore.subscribe((s) => sync(s.actions))
}

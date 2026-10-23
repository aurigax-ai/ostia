import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { useUIStore } from '@/stores/app/uiStore'
import { useWindowsStore } from '@/stores/workspaces/windowsStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { globalWorkspaceOrder } from './windowWorkspaces'

export function selectWorkspace(workspaceId: string): void {
  const shown =
    useWorkspacesStore.getState().activeWorkspaceId === workspaceId &&
    !useUIStore.getState().settingsActive
  useUIStore.getState().showWorkspaces()
  useWorkspacesStore.getState().setActive(workspaceId)
  if (!shown) focusActivePaneWhenReady(workspaceId)
}

export function goToWorkspace(index: number, takesKeyboard: boolean): boolean {
  const { windowId, list } = useWindowsStore.getState()
  const local = useWorkspacesStore.getState().workspaces.map((w) => w.id)
  const target = globalWorkspaceOrder(list, windowId, local)[index]
  if (!target) return false
  if (target.windowId !== windowId && target.windowId !== null) {
    window.ostia.windows.focusWorkspace(target.id, false, takesKeyboard)
    return true
  }
  if (takesKeyboard) selectWorkspace(target.id)
  else {
    useUIStore.getState().showWorkspaces()
    useWorkspacesStore.getState().setActive(target.id)
  }
  return true
}

export function stepWorkspace(step: 1 | -1, takesKeyboard: boolean): boolean {
  const { windowId, list } = useWindowsStore.getState()
  const workspaces = useWorkspacesStore.getState()
  const order = globalWorkspaceOrder(
    list,
    windowId,
    workspaces.workspaces.map((w) => w.id),
  )
  if (order.length === 0) return false
  const current = order.findIndex((w) => w.id === workspaces.activeWorkspaceId)
  const next = current === -1 ? 0 : (current + step + order.length) % order.length
  return next === current ? false : goToWorkspace(next, takesKeyboard)
}

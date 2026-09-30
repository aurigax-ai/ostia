import type { ExtensionSidebarItem } from '@shared/extensions'
import { useLayoutStore } from '../stores/layoutStore'
import type { SidebarSettings } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

type ItemToggles = Pick<SidebarSettings, 'showPorts' | 'showSSH'>

const PORTS_EXTENSION = 'ports'

function toggleFor(item: ExtensionSidebarItem): keyof ItemToggles | null {
  if (item.extId !== PORTS_EXTENSION) return null
  if (item.key === 'ssh') return 'showSSH'
  if (item.key.startsWith('port:')) return 'showPorts'
  return null
}

export function visibleSidebarItems(
  items: ExtensionSidebarItem[],
  workspaceId: string | undefined,
  toggles: ItemToggles,
): ExtensionSidebarItem[] {
  return items.filter((item) => {
    if (item.workspaceId !== workspaceId) return false
    const toggle = toggleFor(item)
    return toggle ? toggles[toggle] : true
  })
}

export function openSidebarUrl(workspaceId: string | undefined, url: string): void {
  const target = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  if (!target) return
  useUIStore.getState().leaveSettings()
  useWorkspacesStore.getState().setActive(target)
  useLayoutStore.getState().openBrowser(target, url)
}

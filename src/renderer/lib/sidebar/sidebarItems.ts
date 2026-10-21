import type { ExtensionSidebarItem } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PORTS_SOURCE } from '@aurigax-ai/ostia-extension-sdk/manifest/coreNames'
import type { BrowserOpener } from '@shared/browser/browserProfile'
import { openBrowserAs } from '@/lib/browser/browserProfile'
import type { SidebarSettings } from '@/stores/app/settingsModel'
import { useUIStore } from '@/stores/app/uiStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'

type ItemToggles = Pick<SidebarSettings, 'showSSH'>

function toggleFor(item: ExtensionSidebarItem): keyof ItemToggles | null {
  if (item.extId !== PORTS_SOURCE) return null
  return item.key === 'ssh' ? 'showSSH' : null
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

export interface SidebarLines {
  location: ExtensionSidebarItem[]
  live: ExtensionSidebarItem[]
}

export function sidebarLines(items: readonly ExtensionSidebarItem[]): SidebarLines {
  return {
    location: items.filter((item) => item.kind === 'location'),
    live: items.filter((item) => item.kind !== 'location'),
  }
}

export function openSidebarUrl(
  workspaceId: string | undefined,
  url: string,
  opener: BrowserOpener,
): void {
  const target = workspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
  if (!target) return
  useUIStore.getState().showWorkspaces()
  useWorkspacesStore.getState().setActive(target)
  openBrowserAs(target, url, opener)
}

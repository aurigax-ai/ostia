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

const REMOTE_EXT = 'ssh'
const REMOTE_KEY = 'remote'

export interface RowItems {
  offline: string | null
  chips: ExtensionSidebarItem[]
}

export function rowItems(items: readonly ExtensionSidebarItem[]): RowItems {
  const remote = items.find((i) => i.extId === REMOTE_EXT && i.key === REMOTE_KEY)
  const rest = items.filter((i) => i !== remote)
  return {
    offline: remote && remote.tone !== 'ok' ? remote.text : null,
    chips: [
      ...rest.filter((i) => i.kind === 'location'),
      ...rest.filter((i) => i.kind !== 'location'),
    ],
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

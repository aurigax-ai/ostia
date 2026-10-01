import { type BrowserOpener, type BrowserProfile, browserProfileFor } from '@shared/browserProfile'
import type { CommandContext } from '../commands/registry'
import { useLayoutStore } from '../stores/layoutStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useWorkspacesStore } from '../stores/workspacesStore'

export function openerOf(ctx: Pick<CommandContext, 'origin'>): BrowserOpener {
  return ctx.origin === 'remote' ? 'agent' : 'human'
}

export function browserProfileIn(workspaceId: string, opener: BrowserOpener): BrowserProfile {
  const workspace = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId)
  return browserProfileFor({
    opener,
    scratch: workspace?.kind === 'scratch',
    sandboxed: useSandboxStore.getState().enabled[workspaceId] === true,
  })
}

export function openBrowserAs(workspaceId: string, url: string, opener: BrowserOpener): void {
  useLayoutStore.getState().openBrowser(workspaceId, url, browserProfileIn(workspaceId, opener))
}

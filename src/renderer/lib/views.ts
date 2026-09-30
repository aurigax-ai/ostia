import { OPEN_VIEW_COMMAND, type ViewInfo } from '@shared/views'
import { commands } from '../commands/registry'
import { currentDict, fmt } from '../i18n/useDict'
import { useLayoutStore } from '../stores/layoutStore'
import { useUIStore } from '../stores/uiStore'
import { enabledViews, useViewsStore } from '../stores/viewsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { openSidebarUrl } from './sidebarItems'
import { runCommandAction } from './userActions'
import type { ViewActionTarget } from './viewExpand'

const OPEN_VIEW_PREFIX = `${OPEN_VIEW_COMMAND}.`

export function openView(name: string, workspaceId: string | null): string | null {
  const view = enabledViews(useViewsStore.getState().views, 'panel').find((v) => v.name === name)
  if (!view || !workspaceId) return null
  useUIStore.getState().leaveSettings()
  return useLayoutStore.getState().openView(workspaceId, view.name, view.title)
}

export function runViewAction(
  view: Pick<ViewInfo, 'name'>,
  label: string,
  action: ViewActionTarget,
  paneId: string | null,
  workspaceId: string | undefined,
): void {
  if (action.kind === 'url') {
    if (action.url) openSidebarUrl(workspaceId, action.url)
    return
  }
  void runCommandAction(
    {
      id: `view:${view.name}`,
      title: label,
      command: action.command,
      ...(action.template ? { args: action.template } : {}),
      origin: `${view.name}.json`,
    },
    paneId,
    action.args,
  )
}

let registered: string[] = []

function syncCommands(views: readonly ViewInfo[]): void {
  for (const id of registered) commands.unregister(id)
  registered = []
  for (const view of enabledViews(views, 'panel')) {
    const id = `${OPEN_VIEW_PREFIX}${view.name}`
    if (commands.has(id)) continue
    commands.register({
      id,
      title: fmt(currentDict().views.open, { title: view.title }),
      category: currentDict().views.category,
      target: 'active',
      run: (_args, ctx) => {
        openView(view.name, ctx.activeWorkspaceId)
      },
    })
    registered.push(id)
  }
}

export function registerViewCommands(): void {
  commands.register<{ name?: unknown } | undefined, { paneId: string }>({
    id: OPEN_VIEW_COMMAND,
    title: 'Open View',
    category: 'Views',
    hidden: true,
    target: 'active',
    argsSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    run: (args, ctx) => {
      const name = args?.name
      if (typeof name !== 'string') throw new Error('name must be a string')
      const workspaceId = ctx.activeWorkspaceId ?? useWorkspacesStore.getState().activeWorkspaceId
      const paneId = openView(name, workspaceId)
      if (!paneId) throw new Error(`no enabled panel view named '${name}' in an open workspace`)
      return { paneId }
    },
  })
}

export function startViews(): () => void {
  const api = window.pine?.views
  if (!api) return () => {}
  const store = useViewsStore.getState()
  const off = api.onChanged((listing) => store.apply(listing))
  void store.load().catch((err) => console.error('[views] load failed', err))
  let last = useViewsStore.getState().views
  syncCommands(last)
  const unsubscribe = useViewsStore.subscribe((s) => {
    if (s.views === last) return
    last = s.views
    syncCommands(last)
  })
  return () => {
    off()
    unsubscribe()
  }
}

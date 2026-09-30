import type {
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
  ExtensionOpenTerminalRequest,
} from '@shared/extensions'
import { runWhenIdle } from '../lib/blockActions'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { commands } from './registry'

const registered = new Set<string>()

export function extensionCommandId(extId: string, command: string): string {
  return `${extId}.${command}`
}

export function syncExtensionCommands(list: ExtensionInfo[]): void {
  const wanted = new Map<
    string,
    { ext: ExtensionInfo; command: ExtensionInfo['commands'][number] }
  >()
  for (const ext of list) {
    if (!ext.enabled) continue
    for (const command of ext.commands) {
      if (command.palette) wanted.set(extensionCommandId(ext.id, command.id), { ext, command })
    }
  }
  for (const id of [...registered]) {
    if (!wanted.has(id)) {
      commands.unregister(id)
      registered.delete(id)
    }
  }
  for (const [id, { ext, command }] of wanted) {
    if (registered.has(id)) continue
    if (commands.has(id)) {
      console.warn(`[extensions] ${ext.id}: command id '${id}' is taken; skipped`)
      continue
    }
    commands.register<{ argument?: string } | undefined, unknown>({
      id,
      title: command.title,
      category: command.category ?? ext.name,
      capabilities: command.capabilities,
      target: 'active',
      ...(command.argument
        ? {
            argument: command.argument,
            argsSchema: { type: 'object', properties: { argument: { type: 'string' } } },
          }
        : {}),
      run: async (args, ctx) => {
        const res = await window.pine.extensions.invoke(
          ext.id,
          command.id,
          { workspaceId: ctx.activeWorkspaceId, paneId: ctx.activePaneId },
          command.argument && typeof args?.argument === 'string' ? args.argument : undefined,
        )
        if (!res.ok) throw new Error(res.message ? `${res.error}: ${res.message}` : res.error)
        return res.data
      },
    })
    registered.add(id)
  }
}

function targetWorkspace(requested?: string): string | null {
  const workspaces = useWorkspacesStore.getState()
  return requested && workspaces.workspaces.some((s) => s.id === requested)
    ? requested
    : workspaces.activeWorkspaceId
}

export function openExtensionPanel(req: ExtensionOpenPanelRequest): string | null {
  const extensions = useExtensionsStore.getState()
  const info = extensions.list.find((e) => e.id === req.extId)
  const workspaceId = targetWorkspace(req.workspaceId)
  if (!info?.panel || !info.enabled || !workspaceId) return null
  const paneId = useLayoutStore
    .getState()
    .openExtensionPanel(workspaceId, info.id, info.panel.title)
  if (paneId && req.path) extensions.navigatePanel(paneId, req.path)
  return paneId
}

export function openExtensionDiff(req: ExtensionOpenDiffRequest): string | null {
  const { extId: _extId, workspaceId: requested, ...content } = req
  const workspaceId = targetWorkspace(requested)
  return workspaceId ? useLayoutStore.getState().openDiff(workspaceId, content) : null
}

export function openExtensionTerminal(req: ExtensionOpenTerminalRequest): string | null {
  const workspaces = useWorkspacesStore.getState()
  const workspaceId = req.workspaceId ?? workspaces.activeWorkspaceId
  if (!workspaceId || !workspaces.workspaces.some((w) => w.id === workspaceId)) return null
  const paneId = useLayoutStore.getState().openTerminal(workspaceId, {
    afterPaneId: req.afterPaneId,
    cwd: req.cwd,
    title: req.title,
  })
  if (!paneId) return null
  if (workspaces.activeWorkspaceId !== workspaceId) workspaces.setActive(workspaceId)
  runWhenIdle(paneId, req.command)
  return paneId
}

export function wireExtensionBridge(): void {
  const api = window.pine?.extensions
  if (!api) return
  const store = useExtensionsStore.getState()
  api.onChanged((list) => {
    store.setList(list)
    syncExtensionCommands(list)
  })
  api.onSidebar((items) => store.setSidebar(items))
  api.onPaneChips((chips) => store.setChips(chips))
  api.onSettingsStored(({ extId, stored }) =>
    useSettingsStore.getState().setExtensionSettings(extId, stored),
  )
  api.onOpenPanel(openExtensionPanel)
  api.onOpenDiff(openExtensionDiff)
  api.onOpenTerminal(openExtensionTerminal)
  void store
    .load()
    .then(() => syncExtensionCommands(useExtensionsStore.getState().list))
    .catch((err) => console.error('[extensions] load failed', err))
}

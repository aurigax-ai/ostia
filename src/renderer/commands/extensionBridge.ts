import type {
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
  ExtensionOpenTerminalRequest,
} from '@shared/extensions'
import { flushSync } from 'react-dom'
import { runWhenIdle } from '../lib/blockActions'
import { pinTitle } from '../lib/pinnedTitles'
import { revealPane } from '../lib/workspaceActivity'
import { useAgentOfferStore } from '../stores/agentOfferStore'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSandboxStore } from '../stores/sandboxStore'
import { useSettingsStore } from '../stores/settingsStore'
import { focusSurface } from '../stores/surfaceSlotsStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { commands } from './registry'

const registered = new Map<string, string>()

export function extensionCommandId(extId: string, command: string): string {
  return `${extId}.${command}`
}

function commandWording(ext: ExtensionInfo, command: ExtensionInfo['commands'][number]): string {
  return JSON.stringify([command.title, command.category ?? ext.name, command.argument])
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
  for (const [id, wording] of [...registered]) {
    const next = wanted.get(id)
    if (!next || commandWording(next.ext, next.command) !== wording) {
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
    registered.set(id, commandWording(ext, command))
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

function focusedPaneId(): string | undefined {
  return document.activeElement?.closest<HTMLElement>('.surface-host')?.dataset.paneId
}

function openKeepingFocus(open: () => string | null): string | null {
  const focused = focusedPaneId()
  const paneId = flushSync(open)
  if (focused && focusedPaneId() !== focused) focusSurface(focused)
  return paneId
}

export function openExtensionTerminal(req: ExtensionOpenTerminalRequest): string | null {
  const workspaces = useWorkspacesStore.getState()
  const workspaceId = req.workspaceId ?? workspaces.activeWorkspaceId
  if (!workspaceId || !workspaces.workspaces.some((w) => w.id === workspaceId)) return null
  const open = (): string | null =>
    useLayoutStore.getState().openTerminal(workspaceId, {
      afterPaneId: req.afterPaneId,
      cwd: req.cwd,
      title: req.title,
      backgroundTab: req.backgroundTab,
    })
  const paneId = req.backgroundTab ? openKeepingFocus(open) : open()
  if (!paneId) return null
  if (req.pinTitle) pinTitle(paneId)
  if (req.hostToken) useSandboxStore.getState().setHostToken(paneId, req.hostToken)
  if (!req.backgroundTab && workspaces.activeWorkspaceId !== workspaceId) {
    workspaces.setActive(workspaceId)
  }
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
    void usePluginsStore.getState().loadLanguages()
  })
  api.onSidebar((items) => store.setSidebar(items))
  api.onPaneChips((chips) => store.setChips(chips))
  api.onWorkspaceChips((chips) => store.setWorkspaceChips(chips))
  api.onSettingsStored(({ extId, stored }) =>
    useSettingsStore.getState().setExtensionSettings(extId, stored),
  )
  api.onOpenPanel(openExtensionPanel)
  api.onOpenDiff(openExtensionDiff)
  api.onOpenTerminal(openExtensionTerminal)
  const offers = useAgentOfferStore.getState()
  api.onAgentOffer(offers.receive)
  api.onAgentOfferWithdrawn(offers.withdraw)
  api.onFocusPane((paneId) => void revealPane(paneId))
  void store
    .load()
    .then(() => syncExtensionCommands(useExtensionsStore.getState().list))
    .catch((err) => console.error('[extensions] load failed', err))
}

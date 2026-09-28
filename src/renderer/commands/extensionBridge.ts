import type {
  ExtensionInfo,
  ExtensionOpenDiffRequest,
  ExtensionOpenPanelRequest,
} from '@shared/extensions'
import { useExtensionsStore } from '../stores/extensionsStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useSessionsStore } from '../stores/sessionsStore'
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
    commands.register<undefined, unknown>({
      id,
      title: command.title,
      category: command.category ?? ext.name,
      capabilities: command.capabilities,
      target: 'active',
      run: async (_args, ctx) => {
        const res = await window.pine.extensions.invoke(ext.id, command.id, {
          sessionId: ctx.activeSessionId,
          paneId: ctx.activePaneId,
        })
        if (!res.ok) throw new Error(res.message ? `${res.error}: ${res.message}` : res.error)
        return res.data
      },
    })
    registered.add(id)
  }
}

function targetSession(requested?: string): string {
  const sessions = useSessionsStore.getState()
  return requested && sessions.sessions.some((s) => s.id === requested)
    ? requested
    : sessions.activeSessionId
}

export function openExtensionPanel(req: ExtensionOpenPanelRequest): void {
  const info = useExtensionsStore.getState().list.find((e) => e.id === req.extId)
  if (!info?.panel || !info.enabled) return
  useLayoutStore
    .getState()
    .openExtensionPanel(targetSession(req.sessionId), info.id, info.panel.title)
}

export function openExtensionDiff(req: ExtensionOpenDiffRequest): string | null {
  const { extId: _extId, sessionId, ...content } = req
  return useLayoutStore.getState().openDiff(targetSession(sessionId), content)
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
  api.onOpenPanel(openExtensionPanel)
  api.onOpenDiff(openExtensionDiff)
  void store
    .load()
    .then(() => syncExtensionCommands(useExtensionsStore.getState().list))
    .catch((err) => console.error('[extensions] load failed', err))
}

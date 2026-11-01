import type { ResumableAgent } from '@shared/agents/agentResume'
import { currentDict } from '@/lib/app/useDict'
import { signalPane, workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { type FolderTrustKind, useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

interface Wait {
  resolve: (go: boolean) => void
  stop: () => void
}

const waiting = new Map<string, Wait>()

function settle(paneId: string, go: boolean, tellMain = true): void {
  useFolderTrustStore.getState().release(paneId)
  const wait = waiting.get(paneId)
  waiting.delete(paneId)
  wait?.stop()
  wait?.resolve(go)
  const current = useAttentionStore.getState().byPane[paneId]
  if (current?.state === 'waiting' && current.message === currentDict().pane.folderTrustLabel) {
    useAttentionStore.getState().dispatch(paneId, { type: 'waitEnded', at: Date.now() })
  }
  if (tellMain) void window.ostia.agentSession.folderTrustDone(paneId).catch(() => undefined)
}

function holdFolder(paneId: string, folder: string, kind: FolderTrustKind): Promise<boolean> {
  settle(paneId, false, false)
  useFolderTrustStore.getState().hold(paneId, folder, kind)
  return new Promise<boolean>((resolve) => {
    const stop = useLayoutStore.subscribe(() => {
      if (!workspaceOfPane(paneId)) settle(paneId, false)
    })
    waiting.set(paneId, { resolve, stop })
  })
}

export function startFolderTrustAsks(): () => void {
  return window.ostia.agentSession.onFolderTrustAsk((paneId, folder, inside) => {
    if (!workspaceOfPane(paneId)) {
      void window.ostia.agentSession.folderTrustDone(paneId).catch(() => undefined)
      return
    }
    void holdFolder(paneId, folder, inside ? 'start' : 'outside')
    signalPane(paneId, {
      type: 'set',
      state: 'waiting',
      message: currentDict().pane.folderTrustLabel,
      at: Date.now(),
    })
  })
}

export async function claudeTrustGate(
  paneId: string,
  agent: ResumableAgent,
  onHold?: () => void,
): Promise<boolean> {
  if (agent !== 'claude') return true
  const verdict = await window.ostia.agentSession.folderTrust(paneId).catch(() => null)
  if (verdict?.state !== 'ask') return true
  if (!workspaceOfPane(paneId)) return false
  const gate = holdFolder(paneId, verdict.folder, 'resume')
  onHold?.()
  return gate
}

export async function trustForClaude(paneId: string): Promise<void> {
  const folder = useFolderTrustStore.getState().byPane[paneId]?.folder
  if (folder) await window.ostia.agentSession.trustFolder(paneId, folder).catch(() => false)
  settle(paneId, true)
}

export async function alwaysTrustWorkspaceFolders(): Promise<void> {
  useSettingsStore.getState().setTrustWorkspaceFolders(true)
  const held = Object.entries(useFolderTrustStore.getState().byPane)
  await Promise.all(held.filter(([, h]) => h.kind !== 'outside').map(([id]) => trustForClaude(id)))
}

export function resumeAnyway(paneId: string): void {
  settle(paneId, true)
}

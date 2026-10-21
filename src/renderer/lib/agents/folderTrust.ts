import type { ResumableAgent } from '@shared/agents/agentResume'
import { workspaceOfPane } from '@/lib/attention/workspaceActivity'
import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'

interface Wait {
  resolve: (go: boolean) => void
  stop: () => void
}

const waiting = new Map<string, Wait>()

function settle(paneId: string, go: boolean): void {
  useFolderTrustStore.getState().release(paneId)
  const wait = waiting.get(paneId)
  waiting.delete(paneId)
  wait?.stop()
  wait?.resolve(go)
}

export async function claudeTrustGate(
  paneId: string,
  agent: ResumableAgent,
  onHold?: () => void,
  sessionId?: string,
): Promise<boolean> {
  if (agent !== 'claude') return true
  const verdict = await window.ostia.agentSession.folderTrust(paneId, sessionId).catch(() => null)
  if (verdict?.state !== 'ask') return true
  if (!workspaceOfPane(paneId)) return false
  settle(paneId, false)
  useFolderTrustStore.getState().hold(paneId, verdict.folder)
  const gate = new Promise<boolean>((resolve) => {
    const stop = useLayoutStore.subscribe(() => {
      if (!workspaceOfPane(paneId)) settle(paneId, false)
    })
    waiting.set(paneId, { resolve, stop })
  })
  onHold?.()
  return gate
}

export async function trustForClaude(paneId: string): Promise<void> {
  const folder = useFolderTrustStore.getState().byPane[paneId]
  if (folder) await window.ostia.agentSession.trustFolder(paneId, folder).catch(() => false)
  settle(paneId, true)
}

export async function alwaysTrustWorkspaceFolders(): Promise<void> {
  useSettingsStore.getState().setTrustWorkspaceFolders(true)
  await Promise.all(Object.keys(useFolderTrustStore.getState().byPane).map(trustForClaude))
}

export function resumeAnyway(paneId: string): void {
  settle(paneId, true)
}

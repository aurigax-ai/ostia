import { useFolderTrustStore } from '@/stores/agents/folderTrustStore'
import { useSettingsStore } from '@/stores/app/settingsStore'
import type { ResumableAgent } from '@shared/agents/agentResume'

const waiting = new Map<string, (go: boolean) => void>()

function settle(paneId: string, go: boolean): void {
  useFolderTrustStore.getState().release(paneId)
  const resolve = waiting.get(paneId)
  waiting.delete(paneId)
  resolve?.(go)
}

export async function claudeTrustGate(paneId: string, agent: ResumableAgent): Promise<boolean> {
  if (agent !== 'claude') return true
  const verdict = await window.ostia.agentSession.folderTrust(paneId).catch(() => null)
  if (verdict?.state !== 'ask') return true
  waiting.get(paneId)?.(false)
  useFolderTrustStore.getState().hold(paneId, verdict.folder)
  return new Promise((resolve) => waiting.set(paneId, resolve))
}

export async function trustForClaude(paneId: string): Promise<void> {
  await window.ostia.agentSession.trustFolder(paneId).catch(() => false)
  settle(paneId, true)
}

export async function alwaysTrustWorkspaceFolders(): Promise<void> {
  useSettingsStore.getState().setTrustWorkspaceFolders(true)
  await Promise.all(Object.keys(useFolderTrustStore.getState().byPane).map(trustForClaude))
}

export function resumeAnyway(paneId: string): void {
  settle(paneId, true)
}

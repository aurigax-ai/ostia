import type { TerminalPlace } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { CommandContext } from '@/commands/registry'
import { currentDict } from '@/lib/app/useDict'
import { focusActivePaneWhenReady } from '@/lib/panes/paneFocus'
import { reportSshFailure } from '@/lib/workspaces/sshWorkspace'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { openRemoteTerminal } from './remoteApi'

async function failureOf(
  workspaceId: string,
  paneId: string | null,
  place: TerminalPlace,
): Promise<string | null> {
  const res = await openRemoteTerminal(workspaceId, paneId, place)
  return res.ok ? null : (res.message ?? res.error)
}

async function remoteAnswer(
  workspaceId: string,
  paneId: string | null,
  place: TerminalPlace,
): Promise<{ remote: boolean; failure: string | null }> {
  try {
    if (!(await window.ostia.workspace.isRemote(workspaceId))) {
      return { remote: false, failure: null }
    }
    return { remote: true, failure: await failureOf(workspaceId, paneId, place) }
  } catch (err) {
    return { remote: true, failure: err instanceof Error ? err.message : String(err) }
  }
}

export async function opensRemoteTerminal(
  ctx: CommandContext,
  paneId: string | null,
  place: TerminalPlace,
): Promise<boolean> {
  const workspaceId = ctx.activeWorkspaceId
  if (!workspaceId) return false
  const { remote, failure } = await remoteAnswer(workspaceId, paneId, place)
  if (!remote) return false
  if (failure !== null) {
    reportSshFailure(workspaceId, currentDict().scratch.remoteTerminalFailed, failure)
  } else if (
    ctx.origin !== 'remote' &&
    useWorkspacesStore.getState().activeWorkspaceId === workspaceId
  ) {
    focusActivePaneWhenReady(workspaceId)
  }
  return true
}

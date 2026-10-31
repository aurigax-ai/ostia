import type {
  ExtensionResult,
  TerminalPlace,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { RemoteChoice, RemoteJob, SetupStep, SetupStepId } from '@shared/remote/remoteSetup'

const SSH_EXTENSION = 'ssh'

function call(
  command: string,
  workspaceId: string | null,
  payload: object,
  paneId: string | null = null,
): Promise<ExtensionResult> {
  return window.ostia.extensions.invoke(
    SSH_EXTENSION,
    command,
    { workspaceId, paneId },
    JSON.stringify(payload),
  )
}

export async function runSetupStep(
  workspaceId: string | null,
  choice: RemoteChoice,
  step: SetupStepId,
  check = false,
): Promise<SetupStep> {
  const res = await call('remote-step', workspaceId, { ...choice, step, check })
  if (res.ok) return res.data as SetupStep
  return { id: step, state: 'failed', error: 'network', detail: res.message ?? res.error }
}

export async function openRemoteTab(
  workspaceId: string,
  choice: RemoteChoice,
): Promise<ExtensionResult> {
  return call('remote-open', workspaceId, choice)
}

export function openRemoteTerminal(
  workspaceId: string,
  paneId: string | null,
  place: TerminalPlace,
): Promise<ExtensionResult> {
  return call('remote-terminal', workspaceId, { place }, paneId)
}

export interface HostJobs {
  host: string
  jobs: RemoteJob[]
}

export async function listJobs(workspaceId: string): Promise<HostJobs | null> {
  const res = await call('remote-jobs', workspaceId, {})
  return res.ok ? (res.data as HostJobs) : null
}

export async function attachJob(workspaceId: string, pane: string): Promise<ExtensionResult> {
  return call('remote-attach', workspaceId, { pane })
}

export async function stopJob(workspaceId: string, pane: string): Promise<ExtensionResult> {
  return call('remote-stop', workspaceId, { pane })
}

import type { ExtensionInfo } from '@shared/extensions'
import { currentDict, fmt } from '../i18n/useDict'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { startNewWorkspace } from './newWorkspace'

export const SSH_EXTENSION = 'ssh'

export interface SshHosts {
  hosts: string[]
  truncated: boolean
}

export function sshEnabled(list: readonly ExtensionInfo[]): boolean {
  return list.some(
    (ext) =>
      ext.id === SSH_EXTENSION && ext.enabled && ext.commands.some((c) => c.id === 'connect'),
  )
}

function hostsOf(data: unknown): SshHosts {
  if (typeof data !== 'object' || data === null) return { hosts: [], truncated: false }
  const raw = data as { hosts?: unknown; truncated?: unknown }
  const hosts = Array.isArray(raw.hosts)
    ? raw.hosts
        .map((h) => (typeof h === 'object' && h !== null ? (h as { alias?: unknown }).alias : null))
        .filter((alias): alias is string => typeof alias === 'string' && alias !== '')
    : []
  return { hosts, truncated: raw.truncated === true }
}

export async function listSshHosts(): Promise<SshHosts | null> {
  const res = await window.pine.extensions.invoke(SSH_EXTENSION, 'ls', {
    workspaceId: null,
    paneId: null,
  })
  return res.ok ? hostsOf(res.data) : null
}

function reportFailure(workspaceId: string | null, host: string, message: string): void {
  const paneId = workspaceId
    ? useLayoutStore.getState().byWorkspace[workspaceId]?.activePaneId
    : undefined
  const title = fmt(currentDict().scratch.sshFailed, { host })
  if (!paneId) {
    console.error(`[ssh] ${title}: ${message}`)
    return
  }
  window.pine.notifications.post({ paneId, kind: 'error', title, body: message, desktop: false })
}

export async function openSshWorkspace(host: string): Promise<boolean> {
  const previous = useWorkspacesStore.getState().activeWorkspaceId
  const created = startNewWorkspace({ name: host })
  const workspaceId = created ?? previous
  const res = await window.pine.extensions.invoke(
    SSH_EXTENSION,
    'connect',
    { workspaceId, paneId: null },
    host,
  )
  if (res.ok) return true
  const workspaces = useWorkspacesStore.getState()
  if (created && !useLayoutStore.getState().byWorkspace[created]) {
    workspaces.closeWorkspace(created)
    if (previous && workspaces.workspaces.some((w) => w.id === previous)) {
      useWorkspacesStore.getState().setActive(previous)
    }
  }
  reportFailure(previous ?? created, host, res.message ?? res.error)
  return false
}

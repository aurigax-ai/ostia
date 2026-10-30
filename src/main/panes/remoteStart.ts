import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RemoteStartAnswer, RemoteStartInput } from '../../shared/remote/remoteHandoff'
import { REMOTE_REGISTRY_FILE } from '../../shared/remote/remoteNode'
import type { ExtensionHost } from '../extensions/extensionHost'

const SSH_EXTENSION = 'ssh'

export interface RemoteStarter {
  isRemote: (workspaceId: string) => boolean
  start: (input: RemoteStartInput) => Promise<RemoteStartAnswer>
}

const UNAVAILABLE: RemoteStartAnswer = {
  ok: false,
  error: 'extension-unavailable',
  message:
    'the ssh extension is not running: a remote workspace never runs locally; enable it and retry',
}

function remoteWorkspaces(file: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function sshRemoteStarter(
  extensionData: string,
  host: () => ExtensionHost | null,
): RemoteStarter {
  const file = join(extensionData, SSH_EXTENSION, REMOTE_REGISTRY_FILE)
  return {
    isRemote: (workspaceId) => Object.hasOwn(remoteWorkspaces(file), workspaceId),
    start: async (input) => {
      const extensions = host()
      if (!extensions?.processes.isRunning(SSH_EXTENSION)) return UNAVAILABLE
      const res = await extensions.invoke(
        SSH_EXTENSION,
        'remote-start',
        { argv: [JSON.stringify(input)] },
        extensions.userCaller(input.workspaceId),
      )
      if (!res.ok) return { ok: false, error: res.error, message: res.message ?? res.error }
      return { ok: true, ...(res.data as Omit<Extract<RemoteStartAnswer, { ok: true }>, 'ok'>) }
    },
  }
}

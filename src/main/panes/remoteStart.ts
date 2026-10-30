import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { RemoteStartAnswer, RemoteStartInput } from '../../shared/remote/remoteHandoff'
import { REMOTE_REGISTRY_FILE } from '../../shared/remote/remoteNode'
import { readRegularFile } from '../artifacts/previewFiles'
import type { ExtensionHost } from '../extensions/extensionHost'

const SSH_EXTENSION = 'ssh'
const REGISTRY_MAX_BYTES = 1024 * 1024

export interface RemoteStarter {
  isRemote: (workspaceId: string) => Promise<boolean>
  start: (input: RemoteStartInput) => Promise<RemoteStartAnswer>
}

const UNAVAILABLE: RemoteStartAnswer = {
  ok: false,
  error: 'extension-unavailable',
  message:
    'the ssh extension is not running: a remote workspace never runs locally; enable it and retry',
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function remoteWorkspaces(file: string): Promise<Record<string, unknown>> {
  if (!(await lstat(file).catch(() => null))) return {}
  const read = await readRegularFile(file, REGISTRY_MAX_BYTES)
  const parsed: unknown = read.ok ? parseJson(read.body.toString('utf8')) : null
  if (typeof parsed !== 'object' || parsed === null) {
    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      'extension-unavailable: the saved list of remote workspaces cannot be read, so no workspace is run locally by guess; open the remote workspace again',
    )
  }
  return parsed as Record<string, unknown>
}

export function sshRemoteStarter(
  extensionData: string,
  host: () => ExtensionHost | null,
): RemoteStarter {
  const file = join(extensionData, SSH_EXTENSION, REMOTE_REGISTRY_FILE)
  return {
    isRemote: async (workspaceId) => Object.hasOwn(await remoteWorkspaces(file), workspaceId),
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

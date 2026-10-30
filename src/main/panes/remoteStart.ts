import type { RemoteStartAnswer, RemoteStartInput } from '../../shared/remote/remoteHandoff'
import type { ExtensionHost } from '../extensions/extensionHost'

const SSH_EXTENSION = 'ssh'
const REMOTE_MARKER = 'remote'

export interface RemoteStarter {
  isRemote: (workspaceId: string) => boolean
  start: (input: RemoteStartInput) => Promise<RemoteStartAnswer>
}

const UNAVAILABLE: RemoteStartAnswer = {
  ok: false,
  error: 'extension-unavailable',
  message: 'the ssh extension is not running: open the remote workspace again',
}

export function sshRemoteStarter(host: () => ExtensionHost | null): RemoteStarter {
  return {
    isRemote: (workspaceId) =>
      host()
        ?.slots.sidebarItems()
        .some(
          (item) =>
            item.extId === SSH_EXTENSION &&
            item.key === REMOTE_MARKER &&
            item.workspaceId === workspaceId,
        ) ?? false,
    start: async (input) => {
      const extensions = host()
      if (!extensions) return UNAVAILABLE
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

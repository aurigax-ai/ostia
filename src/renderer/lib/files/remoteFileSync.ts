import {
  REMOTE_WRITE_ANY,
  REMOTE_WRITE_NEW,
  type RemoteFileError,
  type RemoteReadResult,
  type RemoteStatResult,
  type RemoteWriteResult,
} from '@shared/remoteFolders'

export const REMOTE_POLL_MS = 3000

export interface RemoteTextApi {
  stat: (path: string) => Promise<RemoteStatResult>
  read: (path: string) => Promise<RemoteReadResult>
  write: (path: string, content: string, baseVersion: string) => Promise<RemoteWriteResult>
}

export type RemoteSaveOutcome =
  | { kind: 'saved'; version: string }
  | { kind: 'conflict'; disk: string; version: string }
  | { kind: 'deleted' }
  | { kind: 'failed'; error: RemoteFileError }

export async function saveRemoteText(
  api: RemoteTextApi,
  path: string,
  text: string,
  base: string | null,
  force: boolean,
): Promise<RemoteSaveOutcome> {
  const written = await api.write(path, text, force ? REMOTE_WRITE_ANY : (base ?? REMOTE_WRITE_NEW))
  if (written.ok) return { kind: 'saved', version: written.version }
  if (written.error !== 'changed') return { kind: 'failed', error: written.error }
  const now = await api.read(path)
  if (now.ok) return { kind: 'conflict', disk: now.content, version: now.version }
  return now.error === 'not-found' ? { kind: 'deleted' } : { kind: 'failed', error: now.error }
}

export type RemoteCheckOutcome =
  | { kind: 'same' }
  | { kind: 'changed'; disk: string; version: string }
  | { kind: 'deleted' }
  | { kind: 'unknown' }

export async function checkRemoteText(
  api: RemoteTextApi,
  path: string,
  known: string | null,
): Promise<RemoteCheckOutcome> {
  const gone = (): RemoteCheckOutcome => (known === null ? { kind: 'same' } : { kind: 'deleted' })
  const stat = await api.stat(path)
  if (!stat.ok) return stat.error === 'not-found' ? gone() : { kind: 'unknown' }
  if (stat.kind !== 'file' || stat.version === undefined) return { kind: 'unknown' }
  if (stat.version === known) return { kind: 'same' }
  const now = await api.read(path)
  if (!now.ok) return now.error === 'not-found' ? gone() : { kind: 'unknown' }
  if (now.version === known) return { kind: 'same' }
  return { kind: 'changed', disk: now.content, version: now.version }
}

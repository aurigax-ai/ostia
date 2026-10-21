import type { Dict } from '@shared/app/dict'
import type { ServerSyncError } from '@shared/profileSync/serverSync'
import { serverErrorText } from './serverText'

export function syncServerErrorText(d: Dict, error: ServerSyncError | undefined): string {
  const t = d.syncServer
  switch (error) {
    case 'too-short':
      return t.errTooShort
    case 'mismatch':
      return t.errMismatch
    case 'wrong-password':
      return t.errWrongPassword
    case 'wrong-recovery-key':
      return t.errWrongRecoveryKey
    case 'exists':
      return t.errExists
    case 'no-wrap':
      return t.errNoWrap
    case 'key-differs':
      return t.errKeyDiffers
    case 'link-stale':
      return t.errLinkStale
    case 'unavailable':
      return t.errUnavailable
    case 'locked':
      return t.errLocked
    case 'untrusted':
      return t.untrusted
    case 'unreachable':
      return t.errUnreachable
    case 'rotation-failed':
      return t.errRotation
    case 'elevation-required':
    case 'device-too-new':
    case 'requester-too-new':
    case 'no-second-device':
    case 'not-signed-in':
      return serverErrorText(d, error)
    default:
      return t.errFailed
  }
}

export function syncServerStatusError(d: Dict, error: string | undefined): string | null {
  const t = d.syncServer
  switch (error) {
    case 'server-signed-out':
      return t.errServerSignedOut
    case 'server-locked':
      return t.errServerLocked
    case 'stale-manifest':
      return t.errStaleManifest
    case 'server-unreachable':
      return t.errServerUnreachable
    case 'server-quota':
      return t.errServerQuota
    case 'server-corrupt':
      return t.errServerCorrupt
    default:
      return null
  }
}

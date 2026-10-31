import type { Dict } from '@shared/app/dict'
import type { ServerFailure } from '@shared/server/serverApi'

export type ServerErrorCode = ServerFailure | 'denied' | 'expired'

export function serverErrorText(d: Dict, error: ServerErrorCode): string {
  switch (error) {
    case 'no-server':
      return d.server.errNoServer
    case 'invalid-url':
      return d.server.addressInvalid
    case 'not-signed-in':
      return d.server.errNotSignedIn
    case 'unreachable':
      return d.server.errUnreachable
    case 'rate-limited':
      return d.server.errRateLimited
    case 'invalid-invite':
      return d.server.errInvalidInvite
    case 'device-limit':
      return d.server.errDeviceLimit
    case 'unavailable':
      return d.server.errUnavailable
    case 'not-a-github-account':
      return d.server.errNotGithub
    case 'stale-signature':
      return d.server.errStaleSignature
    case 'quota':
      return d.server.errQuota
    case 'denied':
      return d.server.errDenied
    case 'expired':
      return d.server.errExpired
    default:
      return d.server.errFailed
  }
}

import type { Dict } from '@shared/app/dict'
import { fmt } from '@shared/app/dict'
import type { PortableResult } from '@shared/artifacts/portable'
import type { ShareAvailability, ShareFailure } from '@shared/artifacts/shares'

type Refused = Extract<PortableResult, { ok: false }>

export function publishProblemText(d: Dict, result: Refused): string | null {
  switch (result.reason) {
    case 'cancelled':
    case 'findings':
      return null
    case 'scan-failed':
      return d.shares.errScanFailed
    case 'signed-out':
      return d.shares.errSignedOut
    case 'publish-off':
      return d.shares.errPublishOff
    case 'unreachable':
      return d.shares.errUnreachable
    case 'quota':
      return d.shares.errQuota
    case 'public-off':
      return d.shares.errPublicOff
    case 'never-off':
      return d.shares.errNeverOff
    case 'bad-options':
      return d.shares.errBadOptions
    case 'unavailable':
      return d.shares.errUnavailable
    case 'too-large':
      return d.shares.errTooLarge
    case 'sandboxed':
      return d.portable.sandboxed
    case 'not-built':
      return fmt(d.portable.notBuilt, { message: result.message ?? '' })
    case 'no-tables':
      return d.portable.openFirst
    default:
      return d.shares.errFailed
  }
}

export function shareFailureText(d: Dict, error: ShareFailure): string {
  switch (error) {
    case 'signed-out':
      return d.shares.errSignedOut
    case 'unreachable':
      return d.shares.errUnreachable
    case 'unknown':
      return d.shares.errUnknown
    default:
      return d.shares.errFailed
  }
}

export function disabledHint(d: Dict, availability: ShareAvailability | null): string | null {
  switch (availability?.state) {
    case 'ready':
      return null
    case 'off':
      return d.shares.disabledOff
    case 'unreachable':
      return d.shares.disabledUnreachable
    case 'unavailable':
      return d.shares.disabledUnavailable
    default:
      return d.shares.disabledSignedOut
  }
}

import type { PaneIdentity } from '../control/idRegistry'
import { carryTrust } from './claudeFolderTrust'
import { type TrustPlaceDeps, trustPlaceOf } from './trustPlace'

export function createTrustCarry(
  deps: TrustPlaceDeps,
): (profileDir: string, identity: PaneIdentity) => Promise<boolean> {
  return async (profileDir, identity) => {
    const place = trustPlaceOf(deps, identity)
    if (!place) return false
    return carryTrust(
      {
        ...place,
        configDir: profileDir,
        customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
      },
      process.env.CLAUDE_CONFIG_DIR || undefined,
    )
  }
}

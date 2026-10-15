import { describe, expect, it } from 'vitest'
import { packageCooldownEnv } from './packageEnv'

describe('packageCooldownEnv', () => {
  it('sets each package manager cooldown from the policy, and nothing when it is off', () => {
    const now = Date.parse('2026-09-30T12:00:00Z')
    expect(packageCooldownEnv(2, now)).toEqual({
      NPM_CONFIG_MIN_RELEASE_AGE: '2',
      PNPM_CONFIG_MINIMUM_RELEASE_AGE: '2880',
      UV_EXCLUDE_NEWER: '2026-09-28T12:00:00.000Z',
      PIP_UPLOADED_PRIOR_TO: '2026-09-28T12:00:00.000Z',
    })
    expect(packageCooldownEnv(0, now)).toEqual({})
  })
})

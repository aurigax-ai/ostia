const DAY_MS = 24 * 3600_000
const MINUTES_PER_DAY = 24 * 60

export function packageCooldownEnv(cooldownDays: number, now: number): Record<string, string> {
  if (cooldownDays <= 0) return {}
  const before = new Date(now - cooldownDays * DAY_MS).toISOString()
  return {
    NPM_CONFIG_MIN_RELEASE_AGE: String(cooldownDays),
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: String(cooldownDays * MINUTES_PER_DAY),
    UV_EXCLUDE_NEWER: before,
    PIP_UPLOADED_PRIOR_TO: before,
  }
}

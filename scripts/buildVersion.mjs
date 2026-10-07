export function buildVersion(base, git) {
  if (!git) return base
  if (!git.dirty && git.tags.includes(`v${base}`)) return base
  return `${base}+sha.${git.commit}${git.dirty ? '.dirty' : ''}`
}

export function telemetryStamp(env) {
  const key = env.OSTIA_TELEMETRY_KEY
  const host = env.OSTIA_TELEMETRY_HOST
  return key && host ? { key, host } : null
}

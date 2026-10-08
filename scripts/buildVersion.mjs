const RELEASE_PART = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/
const RUN_NUMBER = /^[1-9]\d*$/

export function nextPatch(base) {
  const match = RELEASE_PART.exec(base)
  if (!match) throw new Error(`not a release version: ${base}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

export function buildVersion(base, git, mainRun = null) {
  if (mainRun !== null) {
    if (!git) throw new Error('a main build needs the git commit')
    return `${nextPatch(base)}-main.${mainRun}+sha.${git.commit}${git.dirty ? '.dirty' : ''}`
  }
  if (!git) return base
  if (!git.dirty && git.tags.includes(`v${base}`)) return base
  return `${base}+sha.${git.commit}${git.dirty ? '.dirty' : ''}`
}

export function mainBuildRun(env) {
  const run = env.OSTIA_MAIN_BUILD
  if (run === undefined || run === '') return null
  if (!RUN_NUMBER.test(run)) throw new Error(`OSTIA_MAIN_BUILD is not a run number: ${run}`)
  return run
}

export function telemetryStamp(env) {
  const key = env.OSTIA_TELEMETRY_KEY
  const host = env.OSTIA_TELEMETRY_HOST
  return key && host ? { key, host } : null
}

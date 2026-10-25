import { envName, readEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'

const RELAUNCHED = 'NO_NEW_PRIVS_RELAUNCHED'

interface NoNewPrivsRelaunch {
  noNewPrivs: boolean
  env: NodeJS.ProcessEnv
  launch: (env: NodeJS.ProcessEnv) => boolean
  warn: (line: string) => void
}

export function relaunchWithoutNoNewPrivs({
  noNewPrivs,
  env,
  launch,
  warn,
}: NoNewPrivsRelaunch): boolean {
  const relaunched = readEnv(RELAUNCHED, env) !== undefined
  delete env[envName(RELAUNCHED)]
  if (!noNewPrivs) return false
  if (relaunched) {
    warn('no-new-privs: still set after the systemd relaunch; terminals cannot use sudo')
    return false
  }
  if (launch({ ...env, [envName(RELAUNCHED)]: '1' })) return true
  warn('no-new-privs: could not relaunch through systemd; terminals cannot use sudo')
  return false
}

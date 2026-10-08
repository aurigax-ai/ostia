import { envName } from '../../shared/appEnv'
import { ARTIFACTS_ENV, PAD_ENV } from '../../shared/artifacts'

export const AGENT_SOCKET_VARS = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO']

export const UNBOUND_FOLDER_VARS = [envName(ARTIFACTS_ENV), envName(PAD_ENV)]

export function sandboxSpawnEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const name of [...AGENT_SOCKET_VARS, ...UNBOUND_FOLDER_VARS]) delete out[name]
  return out
}

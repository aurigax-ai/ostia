export const AGENT_SOCKET_VARS = ['SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO']

export function sandboxSpawnEnv(env: Record<string, string>): Record<string, string> {
  const out = { ...env }
  for (const name of AGENT_SOCKET_VARS) delete out[name]
  return out
}

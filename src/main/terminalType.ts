import { delimiter } from 'node:path'
import { agentHooksEnv } from '../shared/agentHooks'
import { withLauncherOnPath } from './paneLauncher'

export const PTY_TERM_NAME = 'xterm-256color'

export const PTY_COLOR_ENV = { COLORTERM: 'truecolor' }

export interface PaneShellEnvParts {
  parent: NodeJS.ProcessEnv
  integration: Record<string, string>
  pane: Record<string, string>
  agentHooks: unknown
  launcherDir?: string
}

export function paneShellEnv(parts: PaneShellEnvParts): Record<string, string> {
  const env = {
    ...parts.parent,
    ...parts.integration,
    ...parts.pane,
    ...agentHooksEnv(parts.agentHooks),
    ...PTY_COLOR_ENV,
  } as Record<string, string>
  return parts.launcherDir ? withLauncherOnPath(env, parts.launcherDir, delimiter) : env
}

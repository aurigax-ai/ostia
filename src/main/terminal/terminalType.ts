import { delimiter, join } from 'node:path'
import { agentHooksEnv } from '../../shared/agentHooks'
import { appEnv, withoutEnv } from '../../shared/appEnv'
import { ARTIFACTS_ENV, PAD_ENV, PAD_FILE } from '../../shared/artifacts'
import { withoutGpuLaunchEnv } from '../platform/discreteGpu'
import { withLauncherOnPath } from './paneLauncher'

export const PTY_TERM_NAME = 'xterm-256color'

export const PTY_COLOR_ENV = { COLORTERM: 'truecolor' }

export function ptyIdentityEnv(version: string): Record<string, string> {
  return { TERM_PROGRAM: 'ostia', TERM_PROGRAM_VERSION: version }
}

export interface PaneShellEnvParts {
  version: string
  parent: NodeJS.ProcessEnv
  integration: Record<string, string>
  pane: Record<string, string>
  agentHooks: unknown
  artifactsDir?: string | null
  launcherDir?: string
}

export function artifactsEnv(dir: string | null | undefined): Record<string, string> {
  return dir ? appEnv({ [ARTIFACTS_ENV]: dir, [PAD_ENV]: join(dir, PAD_FILE) }) : {}
}

export function paneShellEnv(parts: PaneShellEnvParts): Record<string, string> {
  const env = {
    ...withoutEnv(withoutGpuLaunchEnv(parts.parent), [ARTIFACTS_ENV, PAD_ENV]),
    ...parts.integration,
    ...parts.pane,
    ...artifactsEnv(parts.artifactsDir),
    ...agentHooksEnv(parts.agentHooks),
    ...PTY_COLOR_ENV,
    ...ptyIdentityEnv(parts.version),
  } as Record<string, string>
  return parts.launcherDir ? withLauncherOnPath(env, parts.launcherDir, delimiter) : env
}

export function withPaneToken(
  env: Record<string, string>,
  token: string,
  tokenFile: string | null,
): Record<string, string> {
  return {
    ...(withoutEnv(env, ['TOKEN', 'TOKEN_FILE']) as Record<string, string>),
    ...appEnv(tokenFile ? { TOKEN_FILE: tokenFile } : { TOKEN: token }),
  }
}

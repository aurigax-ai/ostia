import { join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { writeAgentPlugin } from '../main/terminal/agentPlugin'
import { writeOstiaLauncher } from '../main/terminal/paneLauncher'
import { NODE_CLI } from '../shared/remote/remoteNode'
import type { RemoteAgent } from '../shared/remote/remoteSetup'
import type { NodePaths } from './nodePaths'
import type { SessionSpec } from './tmuxHost'

const SHELL_TAIL = 'exec "${SHELL:-sh}" -l'

const CLAUDE_SCRIPT = [
  'claude --plugin-dir "$OSTIA_AGENT_DIR/claude-plugin" --plugin-dir "$OSTIA_AGENT_DIR/claude-fold"',
  SHELL_TAIL,
].join('; ')

const CODEX_SCRIPT = [
  'bash -c \'. "$OSTIA_AGENT_DIR/codex/hook-args.sh"; command codex "${__ostia_codex_hook_args[@]}"\'',
  SHELL_TAIL,
].join('; ')

export interface LaunchInput {
  paths: NodePaths
  versionDir: string
  pane: string
  agent: RemoteAgent | 'shell'
  folder: string
  env: NodeJS.ProcessEnv
}

function scriptFor(agent: RemoteAgent | 'shell'): string {
  if (agent === 'claude') return CLAUDE_SCRIPT
  if (agent === 'codex') return CODEX_SCRIPT
  return SHELL_TAIL
}

export function launchSpec(input: LaunchInput): SessionSpec {
  const { paths, pane, agent, folder, env } = input
  const binDir = join(paths.run, 'bin')
  writeOstiaLauncher(binDir)
  const tokenFile = join(paths.tokens, pane)
  return {
    name: pane,
    cwd: folder,
    env: {
      ...appEnv({
        SOCKET: paths.socket,
        TOKEN_FILE: tokenFile,
        CLI: join(input.versionDir, NODE_CLI),
        NODE: process.execPath,
        AGENT_DIR: writeAgentPlugin(paths.agents, NO_AGENT_PLUGINS),
      }),
      PATH: `${binDir}:${env.PATH ?? ''}`,
    },
    argv: ['sh', '-c', scriptFor(agent)],
  }
}

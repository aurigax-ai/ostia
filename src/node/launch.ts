import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { NO_AGENT_PLUGINS } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { writeAgentPlugin } from '../main/terminal/agentPlugin'
import { writeOstiaLauncher } from '../main/terminal/paneLauncher'
import { NODE_CLI } from '../shared/remote/remoteNode'
import type { RemoteAgent } from '../shared/remote/remoteSetup'
import type { NodePaths } from './nodePaths'
import type { SessionSpec } from './tmuxHost'

const SHELL_TAIL = 'exec "${SHELL:-sh}" -l'

const TAKE_INPUT = 'p=$OSTIA_PROMPT; m=$OSTIA_MODEL; unset OSTIA_PROMPT OSTIA_MODEL'

const NOTE_EXIT = 'echo $? >"$OSTIA_EXIT_FILE"'

const CLAUDE_SCRIPT = [
  TAKE_INPUT,
  'claude ${m:+--model "$m"} --plugin-dir "$OSTIA_AGENT_DIR/claude-plugin" --plugin-dir "$OSTIA_AGENT_DIR/claude-fold" ${p:+"$p"}',
  NOTE_EXIT,
  SHELL_TAIL,
].join('; ')

const CODEX_SCRIPT = [
  `bash -c '${TAKE_INPUT}; . "$OSTIA_AGENT_DIR/codex/hook-args.sh"; command codex \${m:+--model "$m"} "\${__ostia_codex_hook_args[@]}" \${p:+"$p"}'`,
  NOTE_EXIT,
  SHELL_TAIL,
].join('; ')

export interface LaunchInput {
  paths: NodePaths
  versionDir: string
  pane: string
  agent: RemoteAgent | 'shell'
  folder: string
  env: NodeJS.ProcessEnv
  prompt?: string
  model?: string
}

function scriptFor(agent: RemoteAgent | 'shell'): string {
  if (agent === 'claude') return CLAUDE_SCRIPT
  if (agent === 'codex') return CODEX_SCRIPT
  return SHELL_TAIL
}

export function exitFileOf(paths: NodePaths, pane: string): string {
  return join(paths.run, 'exits', pane)
}

export function launchSpec(input: LaunchInput): SessionSpec {
  const { paths, pane, agent, folder, env } = input
  const binDir = join(paths.run, 'bin')
  writeOstiaLauncher(binDir)
  const tokenFile = join(paths.tokens, pane)
  const exitFile = exitFileOf(paths, pane)
  mkdirSync(dirname(exitFile), { recursive: true, mode: 0o700 })
  rmSync(exitFile, { force: true })
  return {
    name: pane,
    cwd: folder,
    env: {
      ...appEnv({
        SOCKET: paths.socket,
        TOKEN_FILE: tokenFile,
        EXIT_FILE: exitFile,
        CLI: join(input.versionDir, NODE_CLI),
        NODE: process.execPath,
        AGENT_DIR: writeAgentPlugin(paths.agents, NO_AGENT_PLUGINS),
        ...(input.prompt ? { PROMPT: input.prompt } : {}),
        ...(input.model ? { MODEL: input.model } : {}),
      }),
      PATH: `${binDir}:${env.PATH ?? ''}`,
    },
    argv: ['sh', '-c', scriptFor(agent)],
  }
}

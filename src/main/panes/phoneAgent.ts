import { leadsWithFlag } from '../../shared/agents/agentLaunch'
import { plainBlock } from '../../shared/agents/questions'
import { quoteArgv } from '../../shared/terminal/shellQuote'

export type PhoneAgent = 'claude' | 'codex'

const COMMAND_MAX = 8 * 1024

const SUBCOMMANDS = new Set([
  'a',
  'agents',
  'app-server',
  'apply',
  'archive',
  'attach',
  'auth',
  'auto-mode',
  'cloud',
  'completion',
  'debug',
  'delete',
  'doctor',
  'e',
  'exec',
  'exec-server',
  'features',
  'fork',
  'gateway',
  'help',
  'import',
  'install',
  'kill',
  'login',
  'logout',
  'logs',
  'mcp',
  'migrate-rollouts',
  'plugin',
  'plugins',
  'purge',
  'queue',
  'remote-control',
  'respawn',
  'resume',
  'review',
  'rm',
  'sandbox',
  'setup-token',
  'stop',
  'ultrareview',
  'unarchive',
  'update',
  'upgrade',
])

export function phoneAgentCommand(agent: PhoneAgent, raw: string): string | null {
  const prompt = plainBlock(raw)
  const words = prompt.split(/\s+/)
  const first = words[0]?.toLowerCase() ?? ''
  if (words.length < 2 || leadsWithFlag(prompt) || SUBCOMMANDS.has(first)) return null
  const command = quoteArgv([agent, prompt])
  return command.length > COMMAND_MAX ? null : command
}

import { appEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'

export interface AgentHooks {
  claude: boolean
  codex: boolean
  agy: boolean
}

export const DEFAULT_AGENT_HOOKS: AgentHooks = { claude: true, codex: true, agy: true }

export const AGENT_HOOKS_OFF_ENV: Record<keyof AgentHooks, string> = {
  claude: 'NO_CLAUDE_HOOKS',
  codex: 'NO_CODEX_HOOKS',
  agy: 'NO_AGY_HOOKS',
}

export function parseAgentHooks(raw: unknown): AgentHooks {
  const src = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return { claude: src.claude !== false, codex: src.codex !== false, agy: src.agy !== false }
}

export function agentHooksEnv(raw: unknown): Record<string, string> {
  const hooks = parseAgentHooks(raw)
  const env: Record<string, string> = {}
  for (const agent of Object.keys(AGENT_HOOKS_OFF_ENV) as (keyof AgentHooks)[]) {
    env[AGENT_HOOKS_OFF_ENV[agent]] = hooks[agent] ? '' : '1'
  }
  return appEnv(env)
}

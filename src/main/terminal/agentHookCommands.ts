import {
  type AgentHookEvent,
  type HookAgent,
  hookAgentsFor,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { shellEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import type { ExtensionAgentHook } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'

export const CLI_PATH = shellEnv('CLI')
export const CLI_RUN = `ELECTRON_RUN_AS_NODE=1 "${shellEnv('NODE')}" "${CLI_PATH}"`
export const IN_PANE = `[ -n "${shellEnv('SOCKET')}" ]`
export const AGENT_DIR = shellEnv('AGENT_DIR')

export const commandHook = (command: string) => ({ type: 'command', command })

export function hookCommand(cliArgs: string): string {
  return `${IN_PANE} && ${CLI_RUN} ${cliArgs} >/dev/null 2>&1 || true`
}

export function turnHookCommand(event: string): string {
  return `${IN_PANE} && { input=$(cat); printf '%s' "$input" | ${CLI_RUN} turn-hook ${event} >/dev/null 2>&1 & } || true`
}

export function busHookCommand(event: AgentHookEvent): string {
  return `${IN_PANE} && ${CLI_RUN} bus hook ${event} 2>/dev/null || true`
}

export function permissionHookCommand(agent: HookAgent): string {
  return `${IN_PANE} && ${CLI_RUN} permission-hook ${agent} 2>/dev/null || true`
}

export function extensionHookCommand(hook: ExtensionAgentHook, agent: HookAgent): string {
  return `${IN_PANE} && ${CLI_RUN} agent-hook ${hook.extId} ${hook.command} ${agent} ${hook.event} 2>/dev/null || true`
}

export function hooksFor(
  hooks: readonly ExtensionAgentHook[],
  agent: HookAgent,
  event: AgentHookEvent,
): string[] {
  return hooks
    .filter((hook) => hook.event === event && hookAgentsFor(event).includes(agent))
    .map((hook) => extensionHookCommand(hook, agent))
}

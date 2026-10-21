import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_HOOK_EVENTS,
  AGENT_SKILL_ENTRY,
  type AgentHookEvent,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { envName, shellEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import {
  type AgentPluginContent,
  type ExtensionAgentHook,
  type LoadedAgentSkill,
  NO_AGENT_PLUGINS,
} from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { version } from '../../../package.json'
import { AGENT_HOOKS_OFF_ENV } from '../../shared/agents/agentHooks'
import { AGENT_ARGS_ENV } from '../../shared/agents/agentLaunch'
import { CLAUDE_QUESTION_TOOLS } from '../../shared/agents/claudeAttention'
import { CORE_SKILL_FILES, writeBundledSkill } from '../agents/bundledSkills'
import type { PlaybookFile } from '../agents/playbookFiles'
import {
  AGENT_DIR,
  busHookCommand,
  CLI_PATH,
  hookCommand,
  hooksFor,
  permissionHookCommand,
  turnHookCommand,
} from './agentHookCommands'
import claudeModSource from './claudeMod/register.ts?raw'

const CLAUDE_ARGS = envName(AGENT_ARGS_ENV.claude)

const commandHook = (command: string) => ({ type: 'command', command })

const CLAUDE_SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const

export const CLAUDE_MOD_FILE = 'register.ts'

export function claudeHookSettings(extensionHooks: readonly ExtensionAgentHook[] = []): {
  hooks: Record<string, unknown[]>
} {
  const own: Partial<Record<AgentHookEvent, string[]>> = {
    SessionStart: [hookCommand('resume-token claude -'), busHookCommand('SessionStart')],
    UserPromptSubmit: [
      hookCommand('state working'),
      busHookCommand('UserPromptSubmit'),
      turnHookCommand('UserPromptSubmit'),
    ],
    PostToolUse: [turnHookCommand('PostToolUse')],
    Notification: [hookCommand('claude-hook Notification')],
    Stop: [hookCommand('claude-hook Stop'), turnHookCommand('Stop')],
  }
  const hooks: Record<string, unknown[]> = {}
  for (const event of AGENT_HOOK_EVENTS) {
    const commands = [...(own[event] ?? []), ...hooksFor(extensionHooks, 'claude', event)]
    if (commands.length === 0) continue
    hooks[event] = [{ hooks: commands.map(commandHook) }]
  }
  hooks.PreToolUse = [
    {
      matcher: CLAUDE_QUESTION_TOOLS.join('|'),
      hooks: [commandHook(hookCommand('claude-hook PreToolUse'))],
    },
    ...(hooks.PreToolUse ?? []),
  ]
  hooks.PostToolUse = [
    {
      matcher: CLAUDE_QUESTION_TOOLS.join('|'),
      hooks: [commandHook(hookCommand('claude-hook PostToolUse'))],
    },
    ...(hooks.PostToolUse ?? []),
  ]
  hooks.StopFailure = [{ hooks: [commandHook(hookCommand('claude-hook StopFailure'))] }]
  for (const event of CLAUDE_SUBAGENT_EVENTS) {
    hooks[event] = [{ hooks: [commandHook(hookCommand(`claude-hook ${event}`))] }]
  }
  hooks.PermissionRequest = [{ hooks: [commandHook(permissionHookCommand('claude'))] }]
  return { hooks }
}

export const AGENT_SKILL_NAME = PRODUCT_NAME

export const CLAUDE_PLUGIN_MANIFEST = {
  name: AGENT_SKILL_NAME,
  version,
  description: `${PRODUCT_NAME} integration: the ${PRODUCT_NAME} CLI skill plus hooks for the agent's resume token and attention state.`,
}

export function writePlaybookFile(dir: string, playbook: PlaybookFile): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, AGENT_SKILL_ENTRY), playbook.skill, 'utf8')
}

export function writeSkillFiles(dir: string, skill: LoadedAgentSkill): void {
  mkdirSync(dir, { recursive: true })
  for (const file of skill.files) writeFileSync(join(dir, file.name), file.data)
}

export function writeClaudePlugin(
  dir: string,
  content: AgentPluginContent = NO_AGENT_PLUGINS,
  playbooks: readonly PlaybookFile[] = [],
): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(CLAUDE_PLUGIN_MANIFEST, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify({ ...claudeHookSettings(content.hooks), modules: [`./${CLAUDE_MOD_FILE}`] }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'hooks', CLAUDE_MOD_FILE), claudeModSource, 'utf8')
  writeBundledSkill(join(dir, 'skills', AGENT_SKILL_NAME), CORE_SKILL_FILES)
  for (const skill of content.skills) writeSkillFiles(join(dir, 'skills', skill.id), skill)
  for (const playbook of playbooks) writePlaybookFile(join(dir, 'skills', playbook.id), playbook)
}

export function claudeWrapper(): string {
  return [
    '',
    '# Run claude with the Ostia plugin (CLI skill, extension skills and hooks, resume token,',
    '# attention hooks). `command claude` skips it.',
    `if [ -n "${CLI_PATH}" ] && [ -z "${shellEnv(AGENT_HOOKS_OFF_ENV.claude)}" ]; then`,
    '  claude() {',
    "    local IFS=$'\\037'",
    `    if [ -n "${AGENT_DIR}" ] && [ -d "${AGENT_DIR}/claude-plugin" ]; then`,
    `      ${CLAUDE_ARGS}="$*" command claude --plugin-dir "${AGENT_DIR}/claude-plugin" "$@"`,
    '    else',
    `      ${CLAUDE_ARGS}="$*" command claude "$@"`,
    '    fi',
    '  }',
    'fi',
    '',
  ].join('\n')
}

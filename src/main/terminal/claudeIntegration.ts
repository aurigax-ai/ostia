import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  CLI_RUN,
  hookCommand,
  hooksFor,
  IN_PANE,
  permissionHookCommand,
  turnHookCommand,
} from './agentHookCommands'
import claudeFoldSource from './claudeMod/fold.ts?raw'
import claudeModSource from './claudeMod/register.ts?raw'

export const CLAUDE_MOD_SOURCE = claudeModSource
export const CLAUDE_FOLD_SOURCE = claudeFoldSource

const CLAUDE_ARGS = envName(AGENT_ARGS_ENV.claude)

const commandHook = (command: string) => ({ type: 'command', command })

const CLAUDE_SUBAGENT_EVENTS = ['SubagentStart', 'SubagentStop'] as const

export const CLAUDE_MOD_FILE = 'register.ts'
export const CLAUDE_FOLD_DIR = 'claude-fold'
const CLAUDE_PLUGIN_DIR = 'claude-plugin'

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
  hooks.PermissionDenied = [{ hooks: [commandHook(hookCommand('claude-hook PermissionDenied'))] }]
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

export const CLAUDE_FOLD_MANIFEST = {
  name: `${PRODUCT_NAME}-fold`,
  version,
  description: `${PRODUCT_NAME} display plugin: draws a bus message turn as one row.`,
}

export function writePlaybookFile(dir: string, playbook: PlaybookFile): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, AGENT_SKILL_ENTRY), playbook.skill, 'utf8')
  for (const file of playbook.files) {
    mkdirSync(dirname(join(dir, file.path)), { recursive: true })
    writeFileSync(join(dir, file.path), file.text, 'utf8')
  }
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

export function writeClaudeFoldPlugin(dir: string): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(CLAUDE_FOLD_MANIFEST, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify({ hooks: {}, modules: [`./${CLAUDE_MOD_FILE}`] }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'hooks', CLAUDE_MOD_FILE), claudeFoldSource, 'utf8')
}

export function claudeWrapper(): string {
  const hooksOn = `[ -z "${shellEnv(AGENT_HOOKS_OFF_ENV.claude)}" ]`
  const pluginDir = `${AGENT_DIR}/${CLAUDE_PLUGIN_DIR}`
  const foldDir = `${AGENT_DIR}/${CLAUDE_FOLD_DIR}`
  return [
    '',
    '# Run claude with the Ostia plugins (CLI skill, extension skills and hooks, resume token,',
    '# attention hooks, bus row display) and on the Claude account Ostia picks for this start.',
    '# `command claude` skips both.',
    `if [ -n "${CLI_PATH}" ]; then`,
    '  __ostia_claude() {',
    "    local IFS=$'\\037'",
    `    if ${hooksOn} && [ -n "${AGENT_DIR}" ] && [ -d "${pluginDir}" ] && [ -d "${foldDir}" ]; then`,
    `      ${CLAUDE_ARGS}="$*" command claude --plugin-dir "${pluginDir}" --plugin-dir "${foldDir}" "$@"`,
    `    elif ${hooksOn}; then`,
    `      ${CLAUDE_ARGS}="$*" command claude "$@"`,
    '    else',
    '      command claude "$@"',
    '    fi',
    '  }',
    '  claude() {',
    "    local IFS=$'\\037' account= answer= memory=",
    `    if [ -z "\${CLAUDE_CONFIG_DIR-}" ] && ${IN_PANE}; then`,
    `      answer=$(${CLI_RUN} claude-account start 2>/dev/null)`,
    "      account=${answer%%$'\\n'*}",
    '      memory=${answer#"$account"}',
    "      memory=${memory#$'\\n'}",
    '    fi',
    '    if [ -n "$account" ]; then',
    '      CLAUDE_CONFIG_DIR="$account" CLAUDE_CODE_REMOTE_MEMORY_DIR="$memory" __ostia_claude "$@"',
    '    else',
    '      __ostia_claude "$@"',
    '    fi',
    '  }',
    'fi',
    '',
  ].join('\n')
}

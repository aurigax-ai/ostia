import { hash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_SKILL_ENTRY,
  isAgentHookEvent,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import { envName, shellEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import {
  type AgentPluginContent,
  type ExtensionAgentHook,
  NO_AGENT_PLUGINS,
} from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { AGENT_HOOKS_OFF_ENV } from '../../shared/agents/agentHooks'
import { AGENT_ARGS_ENV, CODEX_HOOK_ARGS_JSON } from '../../shared/agents/agentLaunch'
import { CORE_SKILL_FILES, writeBundledSkill } from '../agents/bundledSkills'
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
import { writeSkillFiles } from './claudeIntegration'

const CODEX_ARGS = envName(AGENT_ARGS_ENV.codex)

const CODEX_HOOK_EVENTS = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop',
  SessionEnd: 'session_end',
} as const

export type CodexHookEvent = keyof typeof CODEX_HOOK_EVENTS

const CODEX_SESSION_FLAGS_SOURCE = '/<session-flags>/config.toml'

const CODEX_DEFAULT_HOOK_TIMEOUT_SEC = 600

const CODEX_VALUE_OPTIONS = [
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--remote',
  '--remote-auth-token-env',
  '-i',
  '--image',
  '-m',
  '--model',
  '--local-provider',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-C',
  '--cd',
  '--add-dir',
  '-a',
  '--ask-for-approval',
]

const CODEX_SESSION_SUBCOMMANDS = ['resume', 'fork']

const CODEX_OTHER_SUBCOMMANDS = [
  'agents',
  'tcp-tunnel',
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'execpolicy',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud',
  'cloud-tasks',
  'responses-api-proxy',
  'stdio-to-uds',
  'exec-server',
  'features',
  'help',
]

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

export function codexHookCommands(
  contextFile: string,
  extensionHooks: readonly ExtensionAgentHook[] = [],
): Partial<Record<CodexHookEvent, string[]>> {
  const own: Partial<Record<CodexHookEvent, string[]>> = {
    SessionStart: [
      hookCommand('resume-token codex -'),
      `${IN_PANE} && cat ${shellQuote(contextFile)} 2>/dev/null || true`,
      busHookCommand('SessionStart'),
    ],
    UserPromptSubmit: [
      hookCommand('state working'),
      busHookCommand('UserPromptSubmit'),
      turnHookCommand('UserPromptSubmit'),
    ],
    PostToolUse: [turnHookCommand('PostToolUse')],
    PermissionRequest: [hookCommand('state waiting -'), permissionHookCommand('codex')],
    Stop: [hookCommand('state done --stop'), turnHookCommand('Stop')],
  }
  const commands: Partial<Record<CodexHookEvent, string[]>> = {}
  for (const event of Object.keys(CODEX_HOOK_EVENTS) as CodexHookEvent[]) {
    const extra = isAgentHookEvent(event) ? hooksFor(extensionHooks, 'codex', event) : []
    const handlers = [...(own[event] ?? []), ...extra]
    if (handlers.length > 0) commands[event] = handlers
  }
  return commands
}

export function codexHookTrustHash(event: CodexHookEvent, command: string): string {
  const identity = {
    event_name: CODEX_HOOK_EVENTS[event],
    hooks: [{ async: false, command, timeout: CODEX_DEFAULT_HOOK_TIMEOUT_SEC, type: 'command' }],
  }
  return `sha256:${hash('sha256', JSON.stringify(identity))}`
}

export function codexHookKey(event: CodexHookEvent, handlerIndex: number): string {
  return `${CODEX_SESSION_FLAGS_SOURCE}:${CODEX_HOOK_EVENTS[event]}:0:${handlerIndex}`
}

export function codexHookArgs(
  contextFile: string,
  extensionHooks: readonly ExtensionAgentHook[] = [],
): string[] {
  const commands = Object.entries(codexHookCommands(contextFile, extensionHooks)) as [
    CodexHookEvent,
    string[],
  ][]
  const args = ['--no-daemon']
  const trust: string[] = []
  for (const [event, handlers] of commands) {
    const hooks = handlers.map((command) => `{type="command",command=${tomlString(command)}}`)
    args.push('-c', `hooks.${event}=[{hooks=[${hooks.join(',')}]}]`)
    handlers.forEach((command, index) => {
      trust.push(
        `${tomlString(codexHookKey(event, index))}={trusted_hash=${tomlString(codexHookTrustHash(event, command))}}`,
      )
    })
  }
  args.push('-c', `hooks.state={${trust.join(',')}}`)
  return args
}

function codexSessionContext(
  skillFile: string,
  skills: { id: string; file: string; description: string }[],
): string {
  return [
    `This Codex session runs in a ${PRODUCT_NAME} terminal pane. The \`ostia\` CLI controls the pane and its workspace: notifications, attention state, the in-app browser, background processes, the secret vault, and a message bus to agents in other panes.`,
    `Before you use it, read its guide: ${skillFile}`,
    ...(skills.length > 0
      ? [
          '',
          `${PRODUCT_NAME} extensions the human enabled add these skills. When a task matches one, read its file first:`,
          ...skills.map((skill) => `- ${skill.id} (${skill.file}): ${skill.description}`),
        ]
      : []),
    '',
  ].join('\n')
}

export const CODEX_HOOK_ARGS_FILE = 'hook-args.sh'
const CODEX_SERVER_CALL = `${CLI_RUN} codex-server`

function codexHookArgsScript(args: readonly string[]): string {
  return ['__ostia_codex_hook_args=(', ...args.map((arg) => `  ${shellQuote(arg)}`), ')', ''].join(
    '\n',
  )
}

export function writeCodexIntegration(
  dir: string,
  content: AgentPluginContent = NO_AGENT_PLUGINS,
  finalDir: string = dir,
): { contextFile: string } {
  mkdirSync(dir, { recursive: true })
  const skillFile = join(finalDir, 'SKILL.md')
  const contextFile = join(finalDir, 'session-context.md')
  writeBundledSkill(dir, CORE_SKILL_FILES)
  const skills = content.skills.map((skill) => {
    writeSkillFiles(join(dir, 'skills', skill.id), skill)
    return {
      id: skill.id,
      file: join(finalDir, 'skills', skill.id, AGENT_SKILL_ENTRY),
      description: skill.description.replace(/\s+/g, ' '),
    }
  })
  writeFileSync(join(dir, 'session-context.md'), codexSessionContext(skillFile, skills), 'utf8')
  const hookArgs = codexHookArgs(contextFile, content.hooks)
  writeFileSync(join(dir, CODEX_HOOK_ARGS_FILE), codexHookArgsScript(hookArgs), 'utf8')
  writeFileSync(join(dir, CODEX_HOOK_ARGS_JSON), `${JSON.stringify(hookArgs)}\n`, 'utf8')
  return { contextFile }
}

export function codexWrapper(): string {
  return [
    '',
    '# Run interactive codex sessions with the Ostia hooks (resume token, attention state, CLI',
    '# context, extension hooks). Other subcommands run untouched; `command codex` skips it.',
    '__ostia_codex_starts_session() {',
    '  local __ostia_skip= __ostia_arg',
    '  for __ostia_arg in "$@"; do',
    '    if [ -n "$__ostia_skip" ]; then',
    '      __ostia_skip=',
    '      continue',
    '    fi',
    '    case "$__ostia_arg" in',
    '      -h|--help|-V|--version) return 1 ;;',
    '      --) return 0 ;;',
    `      ${CODEX_VALUE_OPTIONS.join('|')}) __ostia_skip=1 ;;`,
    '      -*) ;;',
    `      ${CODEX_SESSION_SUBCOMMANDS.join('|')}) return 0 ;;`,
    `      ${CODEX_OTHER_SUBCOMMANDS.join('|')}) return 1 ;;`,
    '      *) return 0 ;;',
    '    esac',
    '  done',
    '  return 0',
    '}',
    `if [ -n "${CLI_PATH}" ] && [ -z "${shellEnv(AGENT_HOOKS_OFF_ENV.codex)}" ]; then`,
    '  codex() {',
    `    if [ -n "${AGENT_DIR}" ] && [ -f "${AGENT_DIR}/codex/${CODEX_HOOK_ARGS_FILE}" ] && __ostia_codex_starts_session "$@"; then`,
    '      local -a __ostia_codex_hook_args',
    "      local IFS=$'\\037'",
    `      . "${AGENT_DIR}/codex/${CODEX_HOOK_ARGS_FILE}"`,
    `      if [ -n "${shellEnv('CODEX_SOCK')}" ]; then`,
    '        local __ostia_codex_sock __ostia_codex_status',
    `        __ostia_codex_sock="$(${CODEX_SERVER_CALL} start -- "$@" 2>/dev/null)"`,
    '        if [ -n "$__ostia_codex_sock" ]; then',
    '          command codex --remote "unix://$__ostia_codex_sock" "$@"',
    '          __ostia_codex_status=$?',
    `          ${CODEX_SERVER_CALL} stop >/dev/null 2>&1`,
    '          return $__ostia_codex_status',
    '        fi',
    '      fi',
    `      ${CODEX_ARGS}="$*" command codex "\${__ostia_codex_hook_args[@]}" "$@"`,
    '    else',
    '      command codex "$@"',
    '    fi',
    '  }',
    'fi',
    '',
  ].join('\n')
}

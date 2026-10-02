import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { version } from '../../package.json'
import {
  AGENT_HOOK_EVENTS,
  AGENT_SKILL_ENTRY,
  type AgentHookEvent,
  type HookAgent,
  hookAgentsFor,
  isAgentHookEvent,
} from '../shared/agentPlugins'
import { PRODUCT_NAME } from '../shared/product'
import { type PromptSeparator, isPromptSeparator } from '../shared/promptSettings'
import pineSkill from './agent/pine-skill.md?raw'
import {
  type AgentPluginContent,
  type ExtensionAgentHook,
  type LoadedAgentSkill,
  NO_AGENT_PLUGINS,
} from './agentSkills'
import { privateTmpDir } from './privateTmp'

export const INTEGRATION_DIR = privateTmpDir('pine-shell-integration')

const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`

const ZSH_INIT =
  `# Pine shell integration for zsh (generated — safe to delete; regenerated on launch).
# Emits OSC 133 prompt/command marks + OSC 7 cwd reports so Pine can render command blocks
# and follow ` +
  '"cd"' +
  ` without polling /proc.
if [ -n "$PINE_SHELL_INTEGRATION" ]; then return; fi
PINE_SHELL_INTEGRATION=1

__pine_osc7() {
  print -Pn "\\e]7;file://%m%d\\e\\\\"
}

__pine_mark_a() { print -Pn "\\e]133;A\\e\\\\" }
__pine_mark_c() { print -Pn "\\e]133;C\\e\\\\" }
__pine_mark_d() { print -Pn "\\e]133;D;$1\\e\\\\" }
__pine_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  print -rn -- $'\\e]633;E;'"$s"$'\\e\\\\'
}

typeset -g __pine_b_mark=$'%{\\e]133;B\\e\\\\%}'
typeset -g __pine_cmd_running=0
typeset -g __pine_last_state=''
zmodload -i zsh/parameter 2>/dev/null

__pine_report_shell() {
  [[ -n "$PINE_SHELL_STATE" ]] || return 0
  local names="\${(j: :)\${(@ok)builtins}} \${(j: :)\${(@ok)reswords}} \${(j: :)\${(@ok)aliases}} \${(j: :)\${(@)\${(@ok)functions}:#_*}}"
  local nl=$'\\n'
  local state="$PATH$nl\${VIRTUAL_ENV//$nl/}$nl\${CONDA_DEFAULT_ENV//$nl/}$nl\${KUBECONFIG//$nl/}$nl$names"
  [[ "$state" == "$__pine_last_state" ]] && return 0
  __pine_last_state=$state
  print -r -- "$state" >| "$PINE_SHELL_STATE" 2>/dev/null
}

typeset -gi __pine_prompt_on=0
typeset -gi __pine_prompt_torn=0
typeset -g __pine_prompt_tail=' '
typeset -g __pine_prompt_text=''
if [[ "$PINE_PROMPT" == pine ]]; then
  __pine_prompt_on=1
  case "$PINE_PROMPT_SEPARATOR" in
    '%') __pine_prompt_tail=' %% ' ;;
    '$'|'>') __pine_prompt_tail=" $PINE_PROMPT_SEPARATOR " ;;
  esac
  if [[ "$PINE_PROMPT_LINES" == 2 ]]; then
    __pine_prompt_text="%~"$'\n'"\${__pine_prompt_tail# }"
  else
    __pine_prompt_text="%~$__pine_prompt_tail"
  fi
fi
unset PINE_PROMPT PINE_PROMPT_SEPARATOR PINE_PROMPT_LINES

# Scratch workspace: keep this shell's history in its scratch folder, never the user's file.
if [[ -n "$PINE_HISTFILE" ]]; then
  HISTFILE="$PINE_HISTFILE"
fi
unset PINE_HISTFILE

# Pine prompt: the input editor draws the context, so the shell line is only "cwd sep". This
# file loads after the user's rc; powerlevel10k rebuilds PROMPT in its own last precmd, so it is
# torn down once, here at load, before its first precmd runs its full (slow) initialization.
__pine_apply_prompt() {
  (( __pine_prompt_on )) || return 0
  if (( ! __pine_prompt_torn )) && (( $+functions[prompt_powerlevel9k_teardown] )); then
    __pine_prompt_torn=1
    prompt_powerlevel9k_teardown
  fi
  PROMPT="$__pine_prompt_text"
  RPROMPT=''
  RPS1=''
}
__pine_apply_prompt

__pine_precmd() {
  local ec=$?
  if (( __pine_cmd_running )); then
    __pine_mark_d "$ec"
    __pine_cmd_running=0
  fi
  __pine_osc7
  __pine_report_shell
  __pine_apply_prompt
  __pine_mark_a
  # Append the (zero-width) prompt-end mark once, so it always lands right after the
  # visible prompt text — works even when a prompt framework redraws PROMPT each cycle.
  case "$PROMPT" in
    *"$__pine_b_mark") ;;
    *) PROMPT="\${PROMPT}\${__pine_b_mark}" ;;
  esac
}

__pine_preexec() {
  __pine_cmd_running=1
  __pine_mark_e "$1"
  __pine_mark_c
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __pine_precmd
add-zsh-hook preexec __pine_preexec
add-zsh-hook chpwd __pine_osc7

# \`pine\` CLI (Slice 5): resolves the control-socket client via the absolute path
# injected as $PINE_CLI (a packaged app would install the bin on PATH instead).
if [ -n "$PINE_CLI" ]; then
  pine() { ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" "$@"; }
fi
`

const BASH_INIT = `# Pine shell integration for bash (generated — safe to delete; regenerated on launch).
# Emits OSC 133 prompt/command marks + OSC 7 cwd reports so Pine can render command blocks
# and follow cd without polling /proc.
if [ -n "$PINE_SHELL_INTEGRATION" ]; then return; fi
PINE_SHELL_INTEGRATION=1

__pine_osc7() {
  printf '\\e]7;file://%s%s\\e\\\\' "\${HOSTNAME:-$(hostname 2>/dev/null)}" "$PWD"
}

__pine_executing=0
# Only "on" for the one real preexec firing right after a precmd — the DEBUG trap also fires
# for PROMPT_COMMAND's own (possibly multi-statement) body, which must NOT count as a command.
# Same interactive-mode gate the bash-preexec project uses to solve this.
__pine_interactive_mode=""

__pine_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  printf '\\e]633;E;%s\\e\\\\' "$s"
}

__pine_preexec() {
  [ -n "$COMP_LINE" ] && return
  if [ "$__pine_interactive_mode" != "on" ]; then
    return
  fi
  __pine_interactive_mode=""
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __pine_executing=1
  local __pine_line
  __pine_line=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  __pine_line=\${__pine_line#*[[:digit:]][* ] }
  case "$__pine_line" in
    *"$BASH_COMMAND"*) __pine_mark_e "$__pine_line" ;;
  esac
  printf '\\e]133;C\\e\\\\'
}

# Bash 5.1+ lets PROMPT_COMMAND be an array, and distros (e.g. /etc/bash.bashrc) often
# append to it. Capture whatever was already there and run it FROM INSIDE our own function
# below, instead of joining it onto PROMPT_COMMAND with a ';'. That matters: bash does not
# fire the DEBUG trap for commands inside a function body, but it DOES fire it for each
# top-level ';'-joined statement — so a naive join makes the user's own prompt commands
# look like a real preexec (a false "command executed" mark right after every prompt).
__pine_orig_prompt_command=("\${PROMPT_COMMAND[@]}")

__pine_last_state=''
__pine_report_shell() {
  [ -n "$PINE_SHELL_STATE" ] || return 0
  local names
  names=$(compgen -abk -A function -X '_*' 2>/dev/null)
  local nl=$'\\n'
  local state="$PATH$nl\${VIRTUAL_ENV//$nl/}$nl\${CONDA_DEFAULT_ENV//$nl/}$nl\${KUBECONFIG//$nl/}$nl\${names//$nl/ }"
  [ "$state" = "$__pine_last_state" ] && return 0
  __pine_last_state=$state
  printf '%s\\n' "$state" >| "$PINE_SHELL_STATE" 2>/dev/null
}

__pine_prompt_on=0
__pine_prompt_tail=' '
__pine_prompt_text=''
if [ "$PINE_PROMPT" = pine ]; then
  __pine_prompt_on=1
  case "$PINE_PROMPT_SEPARATOR" in
    '%'|'$'|'>') __pine_prompt_tail=" $PINE_PROMPT_SEPARATOR " ;;
  esac
  if [ "$PINE_PROMPT_LINES" = 2 ]; then
    __pine_prompt_text='\\w\\n'"\${__pine_prompt_tail# }"
  else
    __pine_prompt_text='\\w'"$__pine_prompt_tail"
  fi
fi
unset PINE_PROMPT PINE_PROMPT_SEPARATOR PINE_PROMPT_LINES

# Scratch workspace: keep this shell's history in its scratch folder, never the user's file.
if [ -n "$PINE_HISTFILE" ]; then
  HISTFILE="$PINE_HISTFILE"
fi
unset PINE_HISTFILE

__pine_prompt_command() {
  local ec=$?
  if [ "$__pine_executing" = "1" ]; then
    printf '\\e]133;D;%s\\e\\\\' "$ec"
    __pine_executing=0
  fi
  __pine_osc7
  printf '\\e]133;A\\e\\\\'
  local __pine_cmd
  for __pine_cmd in "\${__pine_orig_prompt_command[@]}"; do
    [ -n "$__pine_cmd" ] && eval "$__pine_cmd"
  done
  __pine_report_shell
  # Pine prompt: after the user's PROMPT_COMMAND, so a framework's PS1 becomes only "cwd sep".
  [ "$__pine_prompt_on" = 1 ] && PS1="$__pine_prompt_text"
  # Append the (zero-width) prompt-end mark AFTER the user's PROMPT_COMMAND has run — prompt
  # frameworks (starship, powerline, git-prompt) rebuild PS1 there, which would otherwise wipe
  # an earlier mark. Single-quoted so bash stores it byte-exact (see BASH_B_MARK doc above).
  case "$PS1" in
    *'${BASH_B_MARK}') ;;
    *) PS1="\${PS1}"'${BASH_B_MARK}' ;;
  esac
  __pine_interactive_mode="on"
}

unset PROMPT_COMMAND
PROMPT_COMMAND="__pine_prompt_command"
trap '__pine_preexec' DEBUG

# \`pine\` CLI (Slice 5): resolves the control-socket client via the absolute path
# injected as $PINE_CLI (a packaged app would install the bin on PATH instead).
if [ -n "$PINE_CLI" ]; then
  pine() { ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" "$@"; }
fi
`

function hookCommand(pineArgs: string): string {
  return `[ -n "$PINE_SOCKET" ] && ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" ${pineArgs} >/dev/null 2>&1 || true`
}

export function extensionHookCommand(hook: ExtensionAgentHook, agent: HookAgent): string {
  return `[ -n "$PINE_SOCKET" ] && ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" agent-hook ${hook.extId} ${hook.command} ${agent} ${hook.event} 2>/dev/null || true`
}

function hooksFor(
  hooks: readonly ExtensionAgentHook[],
  agent: HookAgent,
  event: AgentHookEvent,
): string[] {
  return hooks
    .filter((hook) => hook.event === event && hookAgentsFor(event).includes(agent))
    .map((hook) => extensionHookCommand(hook, agent))
}

export function claudeHookSettings(extensionHooks: readonly ExtensionAgentHook[] = []): {
  hooks: Record<string, unknown[]>
} {
  const own: Partial<Record<AgentHookEvent, string[]>> = {
    SessionStart: [hookCommand('resume-token claude -')],
    UserPromptSubmit: [hookCommand('state working')],
    Notification: [hookCommand('state waiting -')],
    Stop: [hookCommand('state done')],
  }
  const hooks: Record<string, unknown[]> = {}
  for (const event of AGENT_HOOK_EVENTS) {
    const commands = [...(own[event] ?? []), ...hooksFor(extensionHooks, 'claude', event)]
    if (commands.length === 0) continue
    hooks[event] = [{ hooks: commands.map((command) => ({ type: 'command', command })) }]
  }
  return { hooks }
}

export const CLAUDE_PLUGIN_MANIFEST = {
  name: PRODUCT_NAME,
  version,
  description: `${PRODUCT_NAME} integration: the ${PRODUCT_NAME} CLI skill plus hooks for the agent's resume token and attention state.`,
}

function writeSkillFiles(dir: string, skill: LoadedAgentSkill): void {
  mkdirSync(dir, { recursive: true })
  for (const file of skill.files) writeFileSync(join(dir, file.name), file.data)
}

export function writeClaudePlugin(
  dir: string,
  content: AgentPluginContent = NO_AGENT_PLUGINS,
): void {
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  mkdirSync(join(dir, 'hooks'), { recursive: true })
  mkdirSync(join(dir, 'skills', PRODUCT_NAME), { recursive: true })
  writeFileSync(
    join(dir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify(CLAUDE_PLUGIN_MANIFEST, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(dir, 'hooks', 'hooks.json'),
    `${JSON.stringify(claudeHookSettings(content.hooks), null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(dir, 'skills', PRODUCT_NAME, 'SKILL.md'), pineSkill, 'utf8')
  for (const skill of content.skills) writeSkillFiles(join(dir, 'skills', skill.id), skill)
}

function claudeWrapper(): string {
  return [
    '',
    '# Run claude with the Pine plugin (CLI skill, extension skills and hooks, resume token,',
    '# attention hooks). `command claude` skips it.',
    'if [ -n "$PINE_CLI" ]; then',
    '  claude() {',
    '    if [ -n "$PINE_AGENT_DIR" ] && [ -d "$PINE_AGENT_DIR/claude-plugin" ]; then',
    '      command claude --plugin-dir "$PINE_AGENT_DIR/claude-plugin" "$@"',
    '    else',
    '      command claude "$@"',
    '    fi',
    '  }',
    'fi',
    '',
  ].join('\n')
}

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
      `[ -n "$PINE_SOCKET" ] && cat ${shellQuote(contextFile)} 2>/dev/null || true`,
    ],
    UserPromptSubmit: [hookCommand('state working')],
    PermissionRequest: [hookCommand('state waiting -')],
    Stop: [hookCommand('state done')],
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
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
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
    `This Codex session runs in a ${PRODUCT_NAME} terminal pane. The \`pine\` CLI controls the pane and its workspace: notifications, attention state, the in-app browser, background processes, the secret vault, and a message bus to agents in other panes.`,
    'Your shell tool does not have the `pine` shell function, so run the CLI as `ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" <command>`.',
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

export function codexHookArgsScript(args: readonly string[]): string {
  return ['__pine_codex_hook_args=(', ...args.map((arg) => `  ${shellQuote(arg)}`), ')', ''].join(
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
  writeFileSync(join(dir, 'SKILL.md'), pineSkill, 'utf8')
  const skills = content.skills.map((skill) => {
    writeSkillFiles(join(dir, 'skills', skill.id), skill)
    return {
      id: skill.id,
      file: join(finalDir, 'skills', skill.id, AGENT_SKILL_ENTRY),
      description: skill.description.replace(/\s+/g, ' '),
    }
  })
  writeFileSync(join(dir, 'session-context.md'), codexSessionContext(skillFile, skills), 'utf8')
  writeFileSync(
    join(dir, CODEX_HOOK_ARGS_FILE),
    codexHookArgsScript(codexHookArgs(contextFile, content.hooks)),
    'utf8',
  )
  return { contextFile }
}

export function codexWrapper(): string {
  return [
    '',
    '# Run interactive codex sessions with the Pine hooks (resume token, attention state, CLI',
    '# context, extension hooks). Other subcommands run untouched; `command codex` skips it.',
    '__pine_codex_starts_session() {',
    '  local __pine_skip= __pine_arg',
    '  for __pine_arg in "$@"; do',
    '    if [ -n "$__pine_skip" ]; then',
    '      __pine_skip=',
    '      continue',
    '    fi',
    '    case "$__pine_arg" in',
    '      -h|--help|-V|--version) return 1 ;;',
    '      --) return 0 ;;',
    `      ${CODEX_VALUE_OPTIONS.join('|')}) __pine_skip=1 ;;`,
    '      -*) ;;',
    `      ${CODEX_SESSION_SUBCOMMANDS.join('|')}) return 0 ;;`,
    `      ${CODEX_OTHER_SUBCOMMANDS.join('|')}) return 1 ;;`,
    '      *) return 0 ;;',
    '    esac',
    '  done',
    '  return 0',
    '}',
    'if [ -n "$PINE_CLI" ]; then',
    '  codex() {',
    `    if [ -n "$PINE_AGENT_DIR" ] && [ -f "$PINE_AGENT_DIR/codex/${CODEX_HOOK_ARGS_FILE}" ] && __pine_codex_starts_session "$@"; then`,
    '      local -a __pine_codex_hook_args',
    `      . "$PINE_AGENT_DIR/codex/${CODEX_HOOK_ARGS_FILE}"`,
    '      command codex "${__pine_codex_hook_args[@]}" "$@"',
    '    else',
    '      command codex "$@"',
    '    fi',
    '  }',
    'fi',
    '',
  ].join('\n')
}

export function agentPluginDigest(content: AgentPluginContent): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ version, hooks: content.hooks }))
  hash.update(pineSkill)
  for (const skill of content.skills) {
    hash.update(JSON.stringify({ id: skill.id, description: skill.description }))
    for (const file of skill.files) {
      hash.update(JSON.stringify({ name: file.name, size: file.data.length }))
      hash.update(file.data)
    }
  }
  return hash.digest('hex').slice(0, 32)
}

export function writeAgentPlugin(root: string, content: AgentPluginContent): string {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const dir = join(root, agentPluginDigest(content))
  if (existsSync(dir)) return dir
  const staging = mkdtempSync(join(root, '.staging-'))
  try {
    writeClaudePlugin(join(staging, 'claude-plugin'), content)
    writeCodexIntegration(join(staging, 'codex'), content, join(dir, 'codex'))
    renameSync(staging, dir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (!existsSync(dir)) throw err
  }
  return dir
}

export const AGENT_PLUGINS_DIR = join(INTEGRATION_DIR, 'agents')

let agentDir: string | null = null

export function setAgentPlugins(content: AgentPluginContent): string {
  agentDir = writeAgentPlugin(AGENT_PLUGINS_DIR, content)
  return agentDir
}

function currentAgentDir(): string {
  return agentDir ?? setAgentPlugins(NO_AGENT_PLUGINS)
}

interface IntegrationPaths {
  zshInit: string
  bashInit: string
  zshRc: string
  bashRc: string
}

let cached: IntegrationPaths | null = null

function ensureFiles(): IntegrationPaths {
  if (cached) return cached
  mkdirSync(INTEGRATION_DIR, { recursive: true })

  const agentWrappers = claudeWrapper() + codexWrapper()

  const zshInit = join(INTEGRATION_DIR, 'init.zsh')
  const bashInit = join(INTEGRATION_DIR, 'init.bash')
  writeFileSync(zshInit, ZSH_INIT + agentWrappers, 'utf8')
  writeFileSync(bashInit, BASH_INIT + agentWrappers, 'utf8')

  const zshenv = join(INTEGRATION_DIR, '.zshenv')
  writeFileSync(
    zshenv,
    [
      '# Pine shell integration (generated). Load the real .zshenv; ZDOTDIR is restored to',
      '# PINE_ZDOTDIR_ORIG at the end of .zshrc below, once our hooks are installed.',
      '[ -n "$PINE_ZDOTDIR_ORIG" ] && [ -f "$PINE_ZDOTDIR_ORIG/.zshenv" ] && source "$PINE_ZDOTDIR_ORIG/.zshenv"',
      '# If the real .zshenv redirected ZDOTDIR, remember its target as the effective dotdir',
      '# and reclaim ZDOTDIR so zsh still reads OUR .zshrc next (else integration is bypassed).',
      `if [ "$ZDOTDIR" != "${INTEGRATION_DIR}" ]; then PINE_ZDOTDIR_ORIG="$ZDOTDIR"; ZDOTDIR="${INTEGRATION_DIR}"; fi`,
      '',
    ].join('\n'),
    'utf8',
  )
  const zshRc = join(INTEGRATION_DIR, '.zshrc')
  writeFileSync(
    zshRc,
    [
      '# Pine shell integration (generated). Load the real .zshrc, add our hooks, then',
      '# restore ZDOTDIR so nested/child zsh invocations see a normal environment.',
      '# With the Pine prompt, powerlevel10k must not start its instant prompt: its prompt never',
      '# draws, so it would hold the shell output and delete its own caches at exit.',
      '[ "$PINE_PROMPT" = pine ] && typeset -g POWERLEVEL9K_INSTANT_PROMPT=off',
      '[ -n "$PINE_ZDOTDIR_ORIG" ] && [ -f "$PINE_ZDOTDIR_ORIG/.zshrc" ] && source "$PINE_ZDOTDIR_ORIG/.zshrc"',
      `source "${zshInit}"`,
      'ZDOTDIR="$PINE_ZDOTDIR_ORIG"',
      'unset PINE_ZDOTDIR_ORIG',
      '',
    ].join('\n'),
    'utf8',
  )

  const bashRc = join(INTEGRATION_DIR, 'bashrc')
  writeFileSync(
    bashRc,
    [
      '# Pine shell integration (generated). Load the real ~/.bashrc, then add our hooks.',
      '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"',
      `source "${bashInit}"`,
      '',
    ].join('\n'),
    'utf8',
  )

  cached = { zshInit, bashInit, zshRc, bashRc }
  return cached
}

export interface PinePromptOption {
  separator: PromptSeparator
  sameLine: boolean
}

function promptEnv(option: PinePromptOption | null): Record<string, string> {
  if (!option || !isPromptSeparator(option.separator)) return {}
  return {
    PINE_PROMPT: 'pine',
    PINE_PROMPT_SEPARATOR: option.separator,
    PINE_PROMPT_LINES: option.sameLine === true ? '1' : '2',
  }
}

function historyEnv(histFile: string | null): Record<string, string> {
  return histFile ? { PINE_HISTFILE: histFile } : {}
}

export function shellIntegrationSpawnOptions(
  shellPath: string,
  baseEnv: NodeJS.ProcessEnv,
  pinePrompt: PinePromptOption | null = null,
  histFile: string | null = null,
): { args: string[]; env: Record<string, string> } {
  const name = basename(shellPath).toLowerCase()

  if (name === 'zsh') {
    const { zshRc: _unused } = ensureFiles()
    return {
      args: [],
      env: {
        ZDOTDIR: INTEGRATION_DIR,
        PINE_ZDOTDIR_ORIG: baseEnv.ZDOTDIR || baseEnv.HOME || '',
        PINE_AGENT_DIR: currentAgentDir(),
        ...promptEnv(pinePrompt),
        ...historyEnv(histFile),
      },
    }
  }

  if (name === 'bash') {
    const { bashRc } = ensureFiles()
    return {
      args: ['--rcfile', bashRc],
      env: {
        PINE_AGENT_DIR: currentAgentDir(),
        ...promptEnv(pinePrompt),
        ...historyEnv(histFile),
      },
    }
  }

  return { args: [], env: {} }
}

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { appEnv, envName, shellEnv } from '@aurigax-ai/ostia-extension-sdk/contract/appEnv'
import {
  type AgentPluginContent,
  NO_AGENT_PLUGINS,
} from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { isPromptSeparator, type PromptSeparator } from '../../shared/terminal/promptSettings'
import type { PlaybookFile } from '../agents/playbookFiles'
import { privateRunDir } from '../platform/privateTmp'
import { CLI_PATH, CLI_RUN } from './agentHookCommands'
import { agentPluginFiles, writeAgentPlugin } from './agentPlugin'
import { claudeWrapper } from './claudeIntegration'
import { codexWrapper, PLAYBOOKS_DIR } from './codexIntegration'
import { hasFiles, installGenerated, removeGenerated, sweepOldGenerations } from './generatedFolder'

export const INTEGRATION_DIR = privateRunDir('shell-integration')

const SHELL_STATE_FILE = shellEnv('SHELL_STATE')

const MARK_NONCE_FILE = envName('MARK_NONCE_FILE')

const READ_MARK_NONCE = [
  `if [ -n "$${MARK_NONCE_FILE}" ]; then`,
  `  { IFS= read -r __ostia_nonce < "$${MARK_NONCE_FILE}"; } 2>/dev/null`,
  `  { : >| "$${MARK_NONCE_FILE}"; } 2>/dev/null`,
  `  command rm -f "$${MARK_NONCE_FILE}" 2>/dev/null`,
  'fi',
  `unset ${MARK_NONCE_FILE}`,
]

const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`

const ZSH_INIT = `# Ostia shell integration for zsh (generated — safe to delete; regenerated on launch).
# Emits OSC 133 prompt/command marks + OSC 7 cwd reports so Ostia can render command blocks
# and follow "cd" without polling /proc.
if [ -n "$OSTIA_SHELL_INTEGRATION" ]; then return; fi
OSTIA_SHELL_INTEGRATION=1

__ostia_osc7() {
  print -Pn "\\e]7;file://%m%d\\e\\\\"
}

__ostia_mark_a() { print -Pn "\\e]133;A\\e\\\\" }
__ostia_mark_c() { print -Pn "\\e]133;C\\e\\\\" }
__ostia_mark_d() { print -Pn "\\e]133;D;$1\\e\\\\" }
__ostia_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  print -rn -- $'\\e]633;E;'"$s\${__ostia_nonce:+;$__ostia_nonce}"$'\\e\\\\'
}

typeset -g __ostia_b_mark=$'%{\\e]133;B\\e\\\\%}'
typeset -g __ostia_cmd_running=0
typeset -g __ostia_last_state=''
zmodload -i zsh/parameter 2>/dev/null

__ostia_report_shell() {
  [[ -n "${SHELL_STATE_FILE}" ]] || return 0
  local names="\${(j: :)\${(@ok)builtins}} \${(j: :)\${(@ok)reswords}} \${(j: :)\${(@ok)aliases}} \${(j: :)\${(@)\${(@ok)functions}:#_*}}"
  local nl=$'\\n'
  local state="$PATH$nl\${VIRTUAL_ENV//$nl/}$nl\${CONDA_DEFAULT_ENV//$nl/}$nl\${KUBECONFIG//$nl/}$nl\${names//$nl/ }$nl\${HISTFILE//$nl/}"
  [[ "$state" == "$__ostia_last_state" ]] && return 0
  __ostia_last_state=$state
  print -r -- "$state" >| "${SHELL_STATE_FILE}" 2>/dev/null
}

typeset -gi __ostia_prompt_on=0
typeset -gi __ostia_prompt_torn=0
typeset -g __ostia_prompt_tail=' '
typeset -g __ostia_prompt_text=''
if [[ "$OSTIA_PROMPT" == ostia ]]; then
  __ostia_prompt_on=1
  case "$OSTIA_PROMPT_SEPARATOR" in
    '%') __ostia_prompt_tail=' %% ' ;;
    '$'|'>') __ostia_prompt_tail=" $OSTIA_PROMPT_SEPARATOR " ;;
  esac
  if [[ "$OSTIA_PROMPT_LINES" == 2 ]]; then
    __ostia_prompt_text="%~"$'\n'"\${__ostia_prompt_tail# }"
  else
    __ostia_prompt_text="%~$__ostia_prompt_tail"
  fi
fi
unset OSTIA_PROMPT OSTIA_PROMPT_SEPARATOR OSTIA_PROMPT_LINES

# Scratch workspace: keep this shell's history in its scratch folder, never the user's file.
if [[ -n "$OSTIA_HISTFILE" ]]; then
  HISTFILE="$OSTIA_HISTFILE"
fi
unset OSTIA_HISTFILE

# Ostia prompt: the input editor draws the context, so the shell line is only "cwd sep". This
# file loads after the user's rc; powerlevel10k rebuilds PROMPT in its own last precmd, so it is
# torn down once, here at load, before its first precmd runs its full (slow) initialization.
__ostia_apply_prompt() {
  (( __ostia_prompt_on )) || return 0
  if (( ! __ostia_prompt_torn )) && (( $+functions[prompt_powerlevel9k_teardown] )); then
    __ostia_prompt_torn=1
    prompt_powerlevel9k_teardown
  fi
  PROMPT="$__ostia_prompt_text"
  RPROMPT=''
  RPS1=''
}
__ostia_apply_prompt

__ostia_precmd() {
  local ec=$?
  if (( __ostia_cmd_running )); then
    __ostia_mark_d "$ec"
    __ostia_cmd_running=0
  fi
  __ostia_osc7
  __ostia_report_shell
  __ostia_apply_prompt
  __ostia_mark_a
  # Append the (zero-width) prompt-end mark once, so it always lands right after the
  # visible prompt text — works even when a prompt framework redraws PROMPT each cycle.
  case "$PROMPT" in
    *"$__ostia_b_mark") ;;
    *) PROMPT="\${PROMPT}\${__ostia_b_mark}" ;;
  esac
}

__ostia_preexec() {
  __ostia_cmd_running=1
  __ostia_mark_e "$1"
  __ostia_mark_c
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __ostia_precmd
add-zsh-hook preexec __ostia_preexec
add-zsh-hook chpwd __ostia_osc7

# \`ostia\` CLI: runs the control-socket client injected as $OSTIA_CLI.
if [ -n "${CLI_PATH}" ]; then
  ostia() { ${CLI_RUN} "$@"; }
fi
`

const BASH_INIT = `# Ostia shell integration for bash (generated — safe to delete; regenerated on launch).
# Emits OSC 133 prompt/command marks + OSC 7 cwd reports so Ostia can render command blocks
# and follow cd without polling /proc.
if [ -n "$OSTIA_SHELL_INTEGRATION" ]; then return; fi
OSTIA_SHELL_INTEGRATION=1

__ostia_osc7() {
  printf '\\e]7;file://%s%s\\e\\\\' "\${HOSTNAME:-$(hostname 2>/dev/null)}" "$PWD"
}

__ostia_executing=0
# Only "on" for the one real preexec firing right after a precmd — the DEBUG trap also fires
# for PROMPT_COMMAND's own (possibly multi-statement) body, which must NOT count as a command.
# Same interactive-mode gate the bash-preexec project uses to solve this.
__ostia_interactive_mode=""

__ostia_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  printf '\\e]633;E;%s%s\\e\\\\' "$s" "\${__ostia_nonce:+;$__ostia_nonce}"
}

__ostia_preexec() {
  [ -n "$COMP_LINE" ] && return
  if [ "$__ostia_interactive_mode" != "on" ]; then
    return
  fi
  __ostia_interactive_mode=""
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __ostia_executing=1
  local __ostia_line
  __ostia_line=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  __ostia_first_entry=\${__ostia_line#"\${__ostia_line%%[! ]*}"}
  __ostia_first_entry=\${__ostia_first_entry%%[!0-9]*}
  __ostia_first_line=\${__ostia_line#*[[:digit:]][* ] }
  case "$__ostia_first_line" in
    *"$BASH_COMMAND"*) __ostia_mark_e "$__ostia_first_line" ;;
    *) __ostia_first_entry='' ;;
  esac
  printf '\\e]133;C\\e\\\\'
}

# Bash reads a pasted multi-line input one line at a time: when the first command starts, only
# its own line is in the history, so the mark above carries just that line. Once every line has
# run, report the history entries added since (first..last) as the block's whole command, before
# the D mark. Anything unexpected in the listing (erasedups, history -c, a trimmed list) keeps
# the first line.
__ostia_first_entry=''
__ostia_first_line=''
__ostia_mark_whole_command() {
  [ -n "$__ostia_first_entry" ] || return 0
  local first=$__ostia_first_entry last lines pad n nl=$'\\n'
  __ostia_first_entry=''
  last=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  last=\${last#"\${last%%[! ]*}"}
  last=\${last%%[!0-9]*}
  [ "$last" -gt "$first" ] 2>/dev/null || return 0
  lines=$(LC_ALL=C HISTTIMEFORMAT= builtin history $((last - first + 1)))
  printf -v pad '%5d' "$first"
  case "$lines" in
    "$pad"[*\\ ]" $__ostia_first_line$nl"*) lines=\${lines#"$pad"[* ] } ;;
    *) return 0 ;;
  esac
  for ((n = first + 1; n <= last; n++)); do
    printf -v pad '%5d' "$n"
    case "$lines" in
      *"$nl$pad"[*\\ ]" "*) lines=\${lines/"$nl$pad"[* ] /$nl} ;;
      *) return 0 ;;
    esac
  done
  __ostia_mark_e "$lines"
}

# Bash 5.1+ lets PROMPT_COMMAND be an array, and distros (e.g. /etc/bash.bashrc) often
# append to it. Capture whatever was already there and run it FROM INSIDE our own function
# below, instead of joining it onto PROMPT_COMMAND with a ';'. That matters: bash does not
# fire the DEBUG trap for commands inside a function body, but it DOES fire it for each
# top-level ';'-joined statement — so a naive join makes the user's own prompt commands
# look like a real preexec (a false "command executed" mark right after every prompt).
__ostia_orig_prompt_command=("\${PROMPT_COMMAND[@]}")

__ostia_last_state=''
__ostia_report_shell() {
  [ -n "${SHELL_STATE_FILE}" ] || return 0
  local names
  names=$(compgen -abk -A function -X '_*' 2>/dev/null)
  local nl=$'\\n'
  local state="$PATH$nl\${VIRTUAL_ENV//$nl/}$nl\${CONDA_DEFAULT_ENV//$nl/}$nl\${KUBECONFIG//$nl/}$nl\${names//$nl/ }$nl\${HISTFILE//$nl/}"
  [ "$state" = "$__ostia_last_state" ] && return 0
  __ostia_last_state=$state
  printf '%s\\n' "$state" >| "${SHELL_STATE_FILE}" 2>/dev/null
}

__ostia_prompt_on=0
__ostia_prompt_tail=' '
__ostia_prompt_text=''
if [ "$OSTIA_PROMPT" = ostia ]; then
  __ostia_prompt_on=1
  case "$OSTIA_PROMPT_SEPARATOR" in
    '%'|'$'|'>') __ostia_prompt_tail=" $OSTIA_PROMPT_SEPARATOR " ;;
  esac
  if [ "$OSTIA_PROMPT_LINES" = 2 ]; then
    __ostia_prompt_text='\\w\\n'"\${__ostia_prompt_tail# }"
  else
    __ostia_prompt_text='\\w'"$__ostia_prompt_tail"
  fi
fi
unset OSTIA_PROMPT OSTIA_PROMPT_SEPARATOR OSTIA_PROMPT_LINES

# Scratch workspace: keep this shell's history in its scratch folder, never the user's file.
if [ -n "$OSTIA_HISTFILE" ]; then
  HISTFILE="$OSTIA_HISTFILE"
fi
unset OSTIA_HISTFILE

__ostia_prompt_command() {
  local ec=$?
  if [ "$__ostia_executing" = "1" ]; then
    __ostia_mark_whole_command
    printf '\\e]133;D;%s\\e\\\\' "$ec"
    __ostia_executing=0
  fi
  __ostia_osc7
  printf '\\e]133;A\\e\\\\'
  local __ostia_cmd
  for __ostia_cmd in "\${__ostia_orig_prompt_command[@]}"; do
    [ -n "$__ostia_cmd" ] && eval "$__ostia_cmd"
  done
  __ostia_report_shell
  # Ostia prompt: after the user's PROMPT_COMMAND, so a framework's PS1 becomes only "cwd sep".
  [ "$__ostia_prompt_on" = 1 ] && PS1="$__ostia_prompt_text"
  # Append the (zero-width) prompt-end mark AFTER the user's PROMPT_COMMAND has run — prompt
  # frameworks (starship, powerline, git-prompt) rebuild PS1 there, which would otherwise wipe
  # an earlier mark. Single-quoted so bash stores it byte-exact (see BASH_B_MARK doc above).
  case "$PS1" in
    *'${BASH_B_MARK}') ;;
    *) PS1="\${PS1}"'${BASH_B_MARK}' ;;
  esac
  __ostia_interactive_mode="on"
}

unset PROMPT_COMMAND
PROMPT_COMMAND="__ostia_prompt_command"
trap '__ostia_preexec' DEBUG

# \`ostia\` CLI: runs the control-socket client injected as $OSTIA_CLI.
if [ -n "${CLI_PATH}" ]; then
  ostia() { ${CLI_RUN} "$@"; }
fi
`

const AGENT_PLUGINS_DIR = join(INTEGRATION_DIR, 'agents')

let agentContent: AgentPluginContent = NO_AGENT_PLUGINS
let playbookSource: (taken: readonly string[]) => PlaybookFile[] = () => []
let built: { dir: string; names: string[] } | null = null
const generations = new Map<string, string[]>()
const inUse = new Map<string, string>()

export function setPlaybookSource(source: (taken: readonly string[]) => PlaybookFile[]): void {
  playbookSource = source
}

function sweepGenerations(): void {
  const used = new Set(inUse.values())
  for (const [dir, names] of [...generations]) {
    if (dir === built?.dir || used.has(dir)) continue
    generations.delete(dir)
    removeGenerated(dir, names)
  }
}

function rebuildPlugin(): string {
  const playbooks = playbookSource(agentContent.skills.map((skill) => skill.id))
  const dir = writeAgentPlugin(AGENT_PLUGINS_DIR, agentContent, playbooks)
  built = { dir, names: agentPluginFiles(agentContent, playbooks) }
  generations.set(dir, built.names)
  sweepGenerations()
  return dir
}

export function setAgentPlugins(content: AgentPluginContent): string {
  agentContent = content
  return rebuildPlugin()
}

export function refreshAgentPlugin(): void {
  rebuildPlugin()
}

export function retainAgentDir(paneId: string, dir: string): void {
  inUse.set(paneId, dir)
}

export function releaseAgentDir(paneId: string): void {
  if (inUse.delete(paneId)) sweepGenerations()
}

function currentAgentDir(): string {
  if (built !== null && hasFiles(built.dir, built.names)) return built.dir
  return rebuildPlugin()
}

export function playbooksFolder(): string {
  return join(currentAgentDir(), 'codex', PLAYBOOKS_DIR)
}

export type ShellIntegrationFiles = Record<string, string>

const DIGEST_PLACEHOLDER = '\u0000dir\u0000'

export function shellIntegrationFiles(dir: string): ShellIntegrationFiles {
  const agentWrappers = claudeWrapper() + codexWrapper()
  const zshInit = join(dir, 'init.zsh')
  const bashInit = join(dir, 'init.bash')
  return {
    'init.zsh': ZSH_INIT + agentWrappers,
    'init.bash': BASH_INIT + agentWrappers,
    '.zshenv': [
      '# Ostia shell integration (generated). Load the real .zshenv; ZDOTDIR is restored to',
      '# OSTIA_ZDOTDIR_ORIG at the end of .zshrc below, once our hooks are installed.',
      ...READ_MARK_NONCE,
      '[ -n "$OSTIA_ZDOTDIR_ORIG" ] && [ -f "$OSTIA_ZDOTDIR_ORIG/.zshenv" ] && source "$OSTIA_ZDOTDIR_ORIG/.zshenv"',
      '# If the real .zshenv redirected ZDOTDIR, remember its target as the effective dotdir',
      '# and reclaim ZDOTDIR so zsh still reads OUR .zshrc next (else integration is bypassed).',
      `if [ "$ZDOTDIR" != "${dir}" ]; then OSTIA_ZDOTDIR_ORIG="$ZDOTDIR"; ZDOTDIR="${dir}"; fi`,
      '',
    ].join('\n'),
    '.zshrc': [
      '# Ostia shell integration (generated). Load the real .zshrc, add our hooks, then',
      '# restore ZDOTDIR so nested/child zsh invocations see a normal environment.',
      '# With the Ostia prompt, powerlevel10k must not start its instant prompt: its prompt never',
      '# draws, so it would hold the shell output and delete its own caches at exit.',
      '[ "$OSTIA_PROMPT" = ostia ] && typeset -g POWERLEVEL9K_INSTANT_PROMPT=off',
      '[ "$HISTFILE" = "$ZDOTDIR/.zsh_history" ] && HISTFILE="${OSTIA_ZDOTDIR_ORIG:-$HOME}/.zsh_history"',
      '[ -n "$OSTIA_ZDOTDIR_ORIG" ] && [ -f "$OSTIA_ZDOTDIR_ORIG/.zshrc" ] && source "$OSTIA_ZDOTDIR_ORIG/.zshrc"',
      `source "${zshInit}"`,
      '[[ "$HISTFILE" == "$ZDOTDIR"/* ]] && HISTFILE="${OSTIA_ZDOTDIR_ORIG:-$HOME}${HISTFILE#$ZDOTDIR}"',
      'ZDOTDIR="$OSTIA_ZDOTDIR_ORIG"',
      'unset OSTIA_ZDOTDIR_ORIG',
      '',
    ].join('\n'),
    bashrc: [
      '# Ostia shell integration (generated). Load the real ~/.bashrc, then add our hooks.',
      ...READ_MARK_NONCE,
      '[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"',
      `source "${bashInit}"`,
      '',
    ].join('\n'),
  }
}

function shellIntegrationDigest(files: (dir: string) => ShellIntegrationFiles): string {
  const hash = createHash('sha256')
  for (const [name, text] of Object.entries(files(DIGEST_PLACEHOLDER)).sort()) {
    hash.update(JSON.stringify({ name, size: text.length }))
    hash.update(text)
  }
  return hash.digest('hex').slice(0, 32)
}

export function writeShellIntegration(
  root: string,
  files: (dir: string) => ShellIntegrationFiles = shellIntegrationFiles,
): string {
  const dir = join(root, shellIntegrationDigest(files))
  const contents = files(dir)
  return installGenerated(root, dir, Object.keys(contents), (staging) => {
    for (const [name, text] of Object.entries(contents)) {
      writeFileSync(join(staging, name), text, 'utf8')
    }
  })
}

const SHELLS_DIR = join(INTEGRATION_DIR, 'shells')

let cachedDir: string | null = null
let cachedNames: string[] = []

export function shellIntegrationDir(): string {
  if (cachedDir !== null && hasFiles(cachedDir, cachedNames)) return cachedDir
  cachedDir = writeShellIntegration(SHELLS_DIR)
  cachedNames = Object.keys(shellIntegrationFiles(cachedDir))
  return cachedDir
}

const OLD_GENERATIONS_KEPT = 3

const SHELL_CACHE = /^\.zcompdump/

function ownsShellEntry(name: string): boolean {
  return Object.hasOwn(shellIntegrationFiles(''), name) || SHELL_CACHE.test(name)
}

function ownsAgentEntry(name: string): boolean {
  return name === 'claude-plugin' || name === 'codex'
}

export function sweepOldIntegration(
  shellsRoot: string = SHELLS_DIR,
  agentsRoot: string = AGENT_PLUGINS_DIR,
): string[] {
  const shells: string[] = []
  try {
    shells.push(shellIntegrationDir())
  } catch {}
  const agents = [...(built ? [built.dir] : []), ...inUse.values()]
  return [
    ...sweepOldGenerations(shellsRoot, shells, OLD_GENERATIONS_KEPT, ownsShellEntry),
    ...sweepOldGenerations(agentsRoot, agents, OLD_GENERATIONS_KEPT, ownsAgentEntry),
  ]
}

export interface OstiaPromptOption {
  separator: PromptSeparator
  sameLine: boolean
}

function promptEnv(option: OstiaPromptOption | null): Record<string, string> {
  if (!option || !isPromptSeparator(option.separator)) return {}
  return {
    OSTIA_PROMPT: 'ostia',
    OSTIA_PROMPT_SEPARATOR: option.separator,
    OSTIA_PROMPT_LINES: option.sameLine === true ? '1' : '2',
  }
}

function historyEnv(histFile: string | null): Record<string, string> {
  return histFile ? { OSTIA_HISTFILE: histFile } : {}
}

function markNonceEnv(markNonceFile: string | null): Record<string, string> {
  return markNonceFile ? { [MARK_NONCE_FILE]: markNonceFile } : {}
}

export function sendsMarkNonce(shellPath: string): boolean {
  const name = basename(shellPath).toLowerCase()
  return name === 'zsh' || name === 'bash'
}

export interface ShellIntegrationSpawn {
  args: string[]
  env: Record<string, string>
  agentDir: string | null
  notLoaded?: string
}

export function integrationFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string') return code
  return err instanceof Error ? err.message : String(err)
}

export function shellIntegrationSpawnOptions(
  shellPath: string,
  baseEnv: NodeJS.ProcessEnv,
  ostiaPrompt: OstiaPromptOption | null = null,
  histFile: string | null = null,
  markNonceFile: string | null = null,
): ShellIntegrationSpawn {
  const name = basename(shellPath).toLowerCase()

  if (name !== 'zsh' && name !== 'bash') return { args: [], env: {}, agentDir: null }

  let dir: string
  let agentDir: string
  try {
    dir = shellIntegrationDir()
    agentDir = currentAgentDir()
  } catch (err) {
    return { args: [], env: {}, agentDir: null, notLoaded: integrationFailure(err) }
  }
  const env = {
    ...appEnv({ AGENT_DIR: agentDir }),
    ...promptEnv(ostiaPrompt),
    ...historyEnv(histFile),
    ...markNonceEnv(markNonceFile),
  }
  if (name === 'zsh') {
    return {
      args: [],
      env: { ZDOTDIR: dir, OSTIA_ZDOTDIR_ORIG: baseEnv.ZDOTDIR || baseEnv.HOME || '', ...env },
      agentDir,
    }
  }
  return { args: ['--rcfile', join(dir, 'bashrc')], env, agentDir }
}

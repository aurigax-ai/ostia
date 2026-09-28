import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { privateTmpDir } from './privateTmp'

const INTEGRATION_DIR = privateTmpDir('pine-shell-integration')

const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`

const ZSH_INIT =
  `# Pine shell integration for zsh (generated — safe to delete; regenerated on launch).
# Emits OSC 133 prompt/command marks + OSC 7 cwd reports so Pine can render command blocks
# and follow ` +
  '"cd"' +
  ` without polling /proc. See docs/ARCHITECTURE.md §2 "Shell integration".
if [ -n "$PINE_SHELL_INTEGRATION" ]; then return; fi
PINE_SHELL_INTEGRATION=1

__pine_osc7() {
  print -Pn "\\e]7;file://%m%d\\e\\\\"
}

__pine_mark_a() { print -Pn "\\e]133;A\\e\\\\" }
__pine_mark_c() { print -Pn "\\e]133;C\\e\\\\" }
__pine_mark_d() { print -Pn "\\e]133;D;$1\\e\\\\" }

typeset -g __pine_b_mark=$'%{\\e]133;B\\e\\\\%}'
typeset -g __pine_cmd_running=0

__pine_precmd() {
  local ec=$?
  if (( __pine_cmd_running )); then
    __pine_mark_d "$ec"
    __pine_cmd_running=0
  fi
  __pine_osc7
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
# and follow cd without polling /proc. See docs/ARCHITECTURE.md §2 "Shell integration".
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

__pine_preexec() {
  [ -n "$COMP_LINE" ] && return
  if [ "$__pine_interactive_mode" != "on" ]; then
    return
  fi
  __pine_interactive_mode=""
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __pine_executing=1
  printf '\\e]133;C\\e\\\\'
}

# Bash 5.1+ lets PROMPT_COMMAND be an array, and distros (e.g. /etc/bash.bashrc) often
# append to it. Capture whatever was already there and run it FROM INSIDE our own function
# below, instead of joining it onto PROMPT_COMMAND with a ';'. That matters: bash does not
# fire the DEBUG trap for commands inside a function body, but it DOES fire it for each
# top-level ';'-joined statement — so a naive join makes the user's own prompt commands
# look like a real preexec (a false "command executed" mark right after every prompt).
__pine_orig_prompt_command=("\${PROMPT_COMMAND[@]}")

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
  # Append the (zero-width) prompt-end mark AFTER the user's PROMPT_COMMAND has run — prompt
  # frameworks (starship, powerline, git-prompt) rebuild PS1 there, which would otherwise wipe
  # an earlier mark. Single-quoted so bash stores it byte-exact (see BASH_B_MARK doc above).
  case "$PS1" in
    *'${BASH_B_MARK}') ;;
    *) PS1="\${PS1}"'${BASH_B_MARK}' ;;
  esac
  __pine_interactive_mode="on"
}

PROMPT_COMMAND="__pine_prompt_command"
trap '__pine_preexec' DEBUG

# \`pine\` CLI (Slice 5): resolves the control-socket client via the absolute path
# injected as $PINE_CLI (a packaged app would install the bin on PATH instead).
if [ -n "$PINE_CLI" ]; then
  pine() { ELECTRON_RUN_AS_NODE=1 "$PINE_NODE" "$PINE_CLI" "$@"; }
fi
`

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

  const zshInit = join(INTEGRATION_DIR, 'init.zsh')
  const bashInit = join(INTEGRATION_DIR, 'init.bash')
  writeFileSync(zshInit, ZSH_INIT, 'utf8')
  writeFileSync(bashInit, BASH_INIT, 'utf8')

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

export function shellIntegrationSpawnOptions(
  shellPath: string,
  baseEnv: NodeJS.ProcessEnv,
): { args: string[]; env: Record<string, string> } {
  const name = basename(shellPath).toLowerCase()

  if (name === 'zsh') {
    const { zshRc: _unused } = ensureFiles()
    return {
      args: [],
      env: {
        ZDOTDIR: INTEGRATION_DIR,
        PINE_ZDOTDIR_ORIG: baseEnv.ZDOTDIR || baseEnv.HOME || '',
      },
    }
  }

  if (name === 'bash') {
    const { bashRc } = ensureFiles()
    return { args: ['--rcfile', bashRc], env: {} }
  }

  return { args: [], env: {} }
}

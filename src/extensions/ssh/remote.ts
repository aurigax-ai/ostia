import { gzipSync } from 'node:zlib'

const ZSH_INIT = `typeset -g __pine_b_mark=$'%{\\e]133;B\\e\\\\%}'
typeset -gi __pine_cmd_running=0
__pine_osc7() { print -Pn '\\e]7;file://%M%d\\e\\\\' }
__pine_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  print -rn -- $'\\e]633;E;'"$s"$'\\e\\\\'
}
__pine_precmd() {
  local ec=$?
  if (( __pine_cmd_running )); then
    print -n "\\e]133;D;$ec\\e\\\\"
    __pine_cmd_running=0
  fi
  __pine_osc7
  print -n '\\e]133;A\\e\\\\'
  case "$PROMPT" in
    *"$__pine_b_mark") ;;
    *) PROMPT="\${PROMPT}\${__pine_b_mark}" ;;
  esac
}
__pine_preexec() {
  __pine_cmd_running=1
  __pine_mark_e "$1"
  print -n '\\e]133;C\\e\\\\'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __pine_precmd
add-zsh-hook preexec __pine_preexec
add-zsh-hook chpwd __pine_osc7
`

const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`

const BASH_INIT = `__pine_executing=0
__pine_interactive_mode=
__pine_osc7() { printf '\\e]7;file://%s%s\\e\\\\' "$HOSTNAME" "$PWD"; }
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
  [ "$__pine_interactive_mode" = on ] || return
  __pine_interactive_mode=
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __pine_executing=1
  local line
  line=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  line=\${line#*[[:digit:]][* ] }
  case "$line" in
    *"$BASH_COMMAND"*) __pine_mark_e "$line" ;;
  esac
  printf '\\e]133;C\\e\\\\'
}
__pine_orig_prompt_command=("\${PROMPT_COMMAND[@]}")
__pine_prompt_command() {
  local ec=$?
  if [ "$__pine_executing" = 1 ]; then
    printf '\\e]133;D;%s\\e\\\\' "$ec"
    __pine_executing=0
  fi
  __pine_osc7
  printf '\\e]133;A\\e\\\\'
  local cmd
  for cmd in "\${__pine_orig_prompt_command[@]}"; do
    [ -n "$cmd" ] && eval "$cmd"
  done
  case "$PS1" in
    *'${BASH_B_MARK}') ;;
    *) PS1="\${PS1}"'${BASH_B_MARK}' ;;
  esac
  __pine_interactive_mode=on
}
unset PROMPT_COMMAND
PROMPT_COMMAND=__pine_prompt_command
trap '__pine_preexec' DEBUG
`

const ZSH_RECLAIM =
  'if [ "$ZDOTDIR" != "$PINE_SSH_DIR" ]; then PINE_ZDOTDIR_ORIG="$ZDOTDIR"; ZDOTDIR="$PINE_SSH_DIR"; fi'

const ZSH_FILES: Record<string, string> = {
  '.zshenv': `[ -f "$PINE_ZDOTDIR_ORIG/.zshenv" ] && source "$PINE_ZDOTDIR_ORIG/.zshenv"
${ZSH_RECLAIM}
`,
  '.zprofile': `[ -f "$PINE_ZDOTDIR_ORIG/.zprofile" ] && source "$PINE_ZDOTDIR_ORIG/.zprofile"
${ZSH_RECLAIM}
`,
  '.zshrc': `__pine_init=$(<"$PINE_SSH_DIR/init.zsh")
rm -rf -- "$PINE_SSH_DIR"
ZDOTDIR=$PINE_ZDOTDIR_ORIG
unset PINE_SSH_DIR PINE_ZDOTDIR_ORIG
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
eval "$__pine_init"
unset __pine_init
`,
  'init.zsh': ZSH_INIT,
}

const BASH_FILES: Record<string, string> = {
  bashrc: `__pine_init=$(<"$PINE_SSH_DIR/init.bash")
rm -rf -- "$PINE_SSH_DIR"
unset PINE_SSH_DIR
[ -r /etc/profile ] && . /etc/profile
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi
eval "$__pine_init"
unset __pine_init
`,
  'init.bash': BASH_INIT,
}

const HEREDOC_END = 'PINE_EOF'

function writeFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `cat >"$d/${name}" <<'${HEREDOC_END}' &&\n${text}${HEREDOC_END}\n`)
    .join('')
}

export const REMOTE_BOOTSTRAP = `__pine_ssh() {
d=$(mktemp -d "\${TMPDIR:-/tmp}/pine-ssh.XXXXXX" 2>/dev/null) || return 0
PINE_SSH_DIR=$d
case "\${SHELL##*/}" in
zsh)
${writeFiles(ZSH_FILES)}{ PINE_ZDOTDIR_ORIG=\${ZDOTDIR:-$HOME}; ZDOTDIR=$d; export PINE_SSH_DIR PINE_ZDOTDIR_ORIG ZDOTDIR; exec "$SHELL" -l -i; } ;;
bash)
${writeFiles(BASH_FILES)}{ export PINE_SSH_DIR; exec "$SHELL" --rcfile "$d/bashrc" -i; } ;;
esac
rm -rf -- "$d"
}
__pine_ssh
`

function packed(text: string): string {
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64')
}

export const REMOTE_COMMAND = `exec sh -c 'p=${packed(REMOTE_BOOTSTRAP)}; s=$( (printf %s "$p" | base64 -d || printf %s "$p" | base64 -D) 2>/dev/null | gzip -dc 2>/dev/null); [ -n "$s" ] && eval "$s"; exec "$SHELL" -l'`

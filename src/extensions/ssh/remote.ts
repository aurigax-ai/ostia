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
__pine_first=
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
  __pine_first=\${line#"\${line%%[! ]*}"}
  __pine_first=\${__pine_first%%[!0-9]*}
  __pine_line=\${line#*[[:digit:]][* ] }
  case "$__pine_line" in
    *"$BASH_COMMAND"*) __pine_mark_e "$__pine_line" ;;
    *) __pine_first= ;;
  esac
  printf '\\e]133;C\\e\\\\'
}
__pine_mark_whole() {
  [ -n "$__pine_first" ] || return 0
  local f=$__pine_first l p n nl=$'\\n' e
  __pine_first=
  l=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  l=\${l#"\${l%%[! ]*}"}
  l=\${l%%[!0-9]*}
  [ "$l" -gt "$f" ] 2>/dev/null || return 0
  e=$l
  l=$(LC_ALL=C HISTTIMEFORMAT= builtin history $((e - f + 1)))
  printf -v p '%5d' "$f"
  case "$l" in
    "$p"[*\\ ]" $__pine_line$nl"*) l=\${l#"$p"[* ] } ;;
    *) return 0 ;;
  esac
  for ((n = f + 1; n <= e; n++)); do
    printf -v p '%5d' "$n"
    case "$l" in
      *"$nl$p"[*\\ ]" "*) l=\${l/"$nl$p"[* ] /$nl} ;;
      *) return 0 ;;
    esac
  done
  __pine_mark_e "$l"
}
__pine_orig_prompt_command=("\${PROMPT_COMMAND[@]}")
__pine_prompt_command() {
  local ec=$?
  if [ "$__pine_executing" = 1 ]; then
    __pine_mark_whole
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
  'if [ "$ZDOTDIR" != "$OSTIA_DIR" ]; then OSTIA_ZDOT="$ZDOTDIR"; ZDOTDIR="$OSTIA_DIR"; fi'

const ZSH_FILES: Record<string, string> = {
  '.zshenv': `[ -f "$OSTIA_ZDOT/.zshenv" ] && source "$OSTIA_ZDOT/.zshenv"
${ZSH_RECLAIM}
`,
  '.zprofile': `[ -f "$OSTIA_ZDOT/.zprofile" ] && source "$OSTIA_ZDOT/.zprofile"
${ZSH_RECLAIM}
`,
  '.zshrc': `__pine_init=$(<"$OSTIA_DIR/init.zsh")
rm -rf -- "$OSTIA_DIR"
ZDOTDIR=$OSTIA_ZDOT
unset OSTIA_DIR OSTIA_ZDOT
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
eval "$__pine_init"
unset __pine_init
`,
  'init.zsh': ZSH_INIT,
}

const BASH_FILES: Record<string, string> = {
  bashrc: `__pine_init=$(<"$OSTIA_DIR/init.bash")
rm -rf -- "$OSTIA_DIR"
unset OSTIA_DIR
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

const HEREDOC_END = 'OSTIA_EOF'

function writeFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `cat >"$d/${name}" <<'${HEREDOC_END}' &&\n${text}${HEREDOC_END}\n`)
    .join('')
}

export const REMOTE_BOOTSTRAP = `__pine_ssh() {
d=$(mktemp -d "\${TMPDIR:-/tmp}/pine-ssh.XXXXXX" 2>/dev/null) || return 0
OSTIA_DIR=$d
case "\${SHELL##*/}" in
zsh)
${writeFiles(ZSH_FILES)}{ OSTIA_ZDOT=\${ZDOTDIR:-$HOME}; ZDOTDIR=$d; export OSTIA_DIR OSTIA_ZDOT ZDOTDIR; exec "$SHELL" -l -i; } ;;
bash)
${writeFiles(BASH_FILES)}{ export OSTIA_DIR; exec "$SHELL" --rcfile "$d/bashrc" -i; } ;;
esac
rm -rf -- "$d"
}
__pine_ssh
`

function packed(text: string): string {
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64')
}

export const REMOTE_COMMAND = `exec sh -c 'p=${packed(REMOTE_BOOTSTRAP)}; s=$( (printf %s "$p" | base64 -d || printf %s "$p" | base64 -D) 2>/dev/null | gzip -dc 2>/dev/null); [ -n "$s" ] && eval "$s"; exec "$SHELL" -l'`

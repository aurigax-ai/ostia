import { gzipSync } from 'node:zlib'

const ZSH_INIT = `typeset -g __ostia_b_mark=$'%{\\e]133;B\\e\\\\%}'
typeset -gi __ostia_cmd_running=0
__ostia_osc7() { print -Pn '\\e]7;file://%M%d\\e\\\\' }
__ostia_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  print -rn -- $'\\e]633;E;'"$s"$'\\e\\\\'
}
__ostia_precmd() {
  local ec=$?
  if (( __ostia_cmd_running )); then
    print -n "\\e]133;D;$ec\\e\\\\"
    __ostia_cmd_running=0
  fi
  __ostia_osc7
  print -n '\\e]133;A\\e\\\\'
  case "$PROMPT" in
    *"$__ostia_b_mark") ;;
    *) PROMPT="\${PROMPT}\${__ostia_b_mark}" ;;
  esac
}
__ostia_preexec() {
  __ostia_cmd_running=1
  __ostia_mark_e "$1"
  print -n '\\e]133;C\\e\\\\'
}
autoload -Uz add-zsh-hook
add-zsh-hook precmd __ostia_precmd
add-zsh-hook preexec __ostia_preexec
add-zsh-hook chpwd __ostia_osc7
`

const BASH_B_MARK = String.raw`\[\e]133;B\e\\\]`

const BASH_INIT = `__ostia_executing=0
__ostia_first=
__ostia_interactive_mode=
__ostia_osc7() { printf '\\e]7;file://%s%s\\e\\\\' "$HOSTNAME" "$PWD"; }
__ostia_mark_e() {
  local s=$1
  s=\${s//\\\\/\\\\\\\\}
  s=\${s//;/\\\\x3b}
  s=\${s//$'\\n'/\\\\x0a}
  s=\${s//[[:cntrl:]]/}
  printf '\\e]633;E;%s\\e\\\\' "$s"
}
__ostia_preexec() {
  [ -n "$COMP_LINE" ] && return
  [ "$__ostia_interactive_mode" = on ] || return
  __ostia_interactive_mode=
  [ "$BASH_COMMAND" = "$PROMPT_COMMAND" ] && return
  __ostia_executing=1
  local line
  line=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  __ostia_first=\${line#"\${line%%[! ]*}"}
  __ostia_first=\${__ostia_first%%[!0-9]*}
  __ostia_line=\${line#*[[:digit:]][* ] }
  case "$__ostia_line" in
    *"$BASH_COMMAND"*) __ostia_mark_e "$__ostia_line" ;;
    *) __ostia_first= ;;
  esac
  printf '\\e]133;C\\e\\\\'
}
__ostia_mark_whole() {
  [ -n "$__ostia_first" ] || return 0
  local f=$__ostia_first l p n nl=$'\\n' e
  __ostia_first=
  l=$(LC_ALL=C HISTTIMEFORMAT= builtin history 1)
  l=\${l#"\${l%%[! ]*}"}
  l=\${l%%[!0-9]*}
  [ "$l" -gt "$f" ] 2>/dev/null || return 0
  e=$l
  l=$(LC_ALL=C HISTTIMEFORMAT= builtin history $((e - f + 1)))
  printf -v p '%5d' "$f"
  case "$l" in
    "$p"[*\\ ]" $__ostia_line$nl"*) l=\${l#"$p"[* ] } ;;
    *) return 0 ;;
  esac
  for ((n = f + 1; n <= e; n++)); do
    printf -v p '%5d' "$n"
    case "$l" in
      *"$nl$p"[*\\ ]" "*) l=\${l/"$nl$p"[* ] /$nl} ;;
      *) return 0 ;;
    esac
  done
  __ostia_mark_e "$l"
}
__ostia_orig_prompt_command=("\${PROMPT_COMMAND[@]}")
__ostia_prompt_command() {
  local ec=$?
  if [ "$__ostia_executing" = 1 ]; then
    __ostia_mark_whole
    printf '\\e]133;D;%s\\e\\\\' "$ec"
    __ostia_executing=0
  fi
  __ostia_osc7
  printf '\\e]133;A\\e\\\\'
  local cmd
  for cmd in "\${__ostia_orig_prompt_command[@]}"; do
    [ -n "$cmd" ] && eval "$cmd"
  done
  case "$PS1" in
    *'${BASH_B_MARK}') ;;
    *) PS1="\${PS1}"'${BASH_B_MARK}' ;;
  esac
  __ostia_interactive_mode=on
}
unset PROMPT_COMMAND
PROMPT_COMMAND=__ostia_prompt_command
trap '__ostia_preexec' DEBUG
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
  '.zshrc': `__ostia_init=$(<"$OSTIA_DIR/init.zsh")
rm -rf -- "$OSTIA_DIR"
ZDOTDIR=$OSTIA_ZDOT
unset OSTIA_DIR OSTIA_ZDOT
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"
eval "$__ostia_init"
unset __ostia_init
`,
  'init.zsh': ZSH_INIT,
}

const BASH_FILES: Record<string, string> = {
  bashrc: `__ostia_init=$(<"$OSTIA_DIR/init.bash")
rm -rf -- "$OSTIA_DIR"
unset OSTIA_DIR
[ -r /etc/profile ] && . /etc/profile
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
fi
eval "$__ostia_init"
unset __ostia_init
`,
  'init.bash': BASH_INIT,
}

const HEREDOC_END = 'OSTIA_EOF'

function writeFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([name, text]) => `cat >"$d/${name}" <<'${HEREDOC_END}' &&\n${text}${HEREDOC_END}\n`)
    .join('')
}

export const REMOTE_BOOTSTRAP = `__ostia_ssh() {
d=$(mktemp -d "\${TMPDIR:-/tmp}/ostia-ssh.XXXXXX" 2>/dev/null) || return 0
OSTIA_DIR=$d
case "\${SHELL##*/}" in
zsh)
${writeFiles(ZSH_FILES)}{ OSTIA_ZDOT=\${ZDOTDIR:-$HOME}; ZDOTDIR=$d; export OSTIA_DIR OSTIA_ZDOT ZDOTDIR; exec "$SHELL" -l -i; } ;;
bash)
${writeFiles(BASH_FILES)}{ export OSTIA_DIR; exec "$SHELL" --rcfile "$d/bashrc" -i; } ;;
esac
rm -rf -- "$d"
}
__ostia_ssh
`

function packed(text: string): string {
  return gzipSync(Buffer.from(text, 'utf8'), { level: 9 }).toString('base64')
}

export const REMOTE_COMMAND = `exec sh -c 'p=${packed(REMOTE_BOOTSTRAP)}; s=$( (printf %s "$p" | base64 -d || printf %s "$p" | base64 -D) 2>/dev/null | gzip -dc 2>/dev/null); [ -n "$s" ] && eval "$s"; exec "$SHELL" -l'`

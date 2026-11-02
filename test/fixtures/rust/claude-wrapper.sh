
# Run claude with the Ostia plugins (CLI skill, extension skills and hooks, resume token,
# attention hooks, bus row display) and on the Claude account Ostia picks for this start.
# `command claude` skips both.
if [ -n "${OSTIA_CLI}" ]; then
  __ostia_claude() {
    local IFS=$'\037'
    if [ -z "${OSTIA_NO_CLAUDE_HOOKS}" ] && [ -n "${OSTIA_AGENT_DIR}" ] && [ -d "${OSTIA_AGENT_DIR}/claude-plugin" ] && [ -d "${OSTIA_AGENT_DIR}/claude-fold" ]; then
      OSTIA_CLAUDE_ARGS="$*" command claude --plugin-dir "${OSTIA_AGENT_DIR}/claude-plugin" --plugin-dir "${OSTIA_AGENT_DIR}/claude-fold" "$@"
    elif [ -z "${OSTIA_NO_CLAUDE_HOOKS}" ]; then
      OSTIA_CLAUDE_ARGS="$*" command claude "$@"
    else
      command claude "$@"
    fi
  }
  claude() {
    local IFS=$'\037' account= answer= memory=
    if [ -z "${CLAUDE_CONFIG_DIR-}" ] && [ -n "${OSTIA_SOCKET}" ]; then
      answer=$(ELECTRON_RUN_AS_NODE=1 "${OSTIA_NODE}" "${OSTIA_CLI}" claude-account start 2>/dev/null)
      account=${answer%%$'\n'*}
      memory=${answer#"$account"}
      memory=${memory#$'\n'}
    fi
    if [ -n "$account" ]; then
      CLAUDE_CONFIG_DIR="$account" CLAUDE_CODE_REMOTE_MEMORY_DIR="$memory" __ostia_claude "$@"
    else
      __ostia_claude "$@"
    fi
  }
fi

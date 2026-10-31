import { NODE_TMUX_SOCKET } from '../../../shared/remote/remoteNode'
import { type ConnectPlan, planRemote } from '../plan'
import { remoteWord } from './bundle'

const PANE_PATTERN = /^[0-9a-f]{8}$/

const ATTACH_OPTIONS = [
  '-t',
  '-o',
  'ConnectTimeout=8',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
]

export interface AttachMessages {
  disconnected: string
  failed: string
}

const RECONNECT_LOOP = [
  's=1; connected=0; lost=$1; failed=$2; shift 2',
  'while :; do t=$(date +%s); "$@"; c=$?',
  '[ "$c" = 255 ] || exit "$c"',
  '[ $(($(date +%s) - t)) -gt 10 ] && connected=1 && s=1',
  'if [ "$connected" = 0 ]; then printf "\\r\\n%s\\r\\n" "$failed"; read -r _; exit 255; fi',
  'printf "\\r\\n%s\\r\\n" "$lost"; sleep "$s"; s=$((s * 2))',
  '[ "$s" -gt 60 ] && s=60',
  'done',
].join('; ')

export function attachArgv(plan: ConnectPlan, pane: string, messages: AttachMessages): string[] {
  if (!PANE_PATTERN.test(pane)) throw new Error('bad pane id')
  const attach = remoteWord(
    `exec tmux -S "$HOME/${NODE_TMUX_SOCKET}" set-option -t "=${pane}:" detach-on-destroy on \\; attach -t "=${pane}"`,
  )
  return [
    'sh',
    '-c',
    RECONNECT_LOOP,
    'ostia-remote',
    messages.disconnected,
    messages.failed,
    ...planRemote(plan, attach, ATTACH_OPTIONS),
  ]
}

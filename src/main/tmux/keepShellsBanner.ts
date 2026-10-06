import { TMUX_MIN_VERSION } from '../../shared/keepShells'

export const TMUX_MISSING = `tmux ${TMUX_MIN_VERSION} or newer is not installed`
export const SANDBOX_NOT_KEPT = "this workspace's sandbox was started without tmux"

function oneLine(text: string): string {
  return Array.from(text, (c) => (c < ' ' || c === '\x7f' ? ' ' : c))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function keepShellsNotice(reason: string): string {
  return [
    `\x1b[2m Keep shells: ${oneLine(reason)}.`,
    ' This shell will not survive a restart.\x1b[0m',
    '',
  ].join('\r\n')
}

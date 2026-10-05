import { TMUX_MIN_VERSION } from '../../shared/keepShells'

export const TMUX_MISSING = `tmux ${TMUX_MIN_VERSION} or newer is not installed`

export function keepShellsBanner(reason: string): string {
  return [
    `\r\n\x1b[38;2;239;89;111m Keep shells: ${reason}\x1b[0m\r\n`,
    ' No shell was started. Install tmux, or turn off Keep shells running in Settings.\r\n',
  ].join('')
}

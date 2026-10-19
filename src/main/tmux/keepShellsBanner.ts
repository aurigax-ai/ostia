import { fmt } from '../../shared/app/dict'
import { TMUX_MIN_VERSION } from '../../shared/terminal/keepShells'
import type { PaneBannerText } from '../terminal/paneBanner'

export const tmuxMissing = (t: PaneBannerText): string =>
  fmt(t.tmuxMissing, { version: TMUX_MIN_VERSION })

function oneLine(text: string): string {
  return Array.from(text, (c) => (c < ' ' || c === '\x7f' ? ' ' : c))
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
}

export function keepShellsNotice(t: PaneBannerText, reason: string): string {
  return `\x1b[2m ${fmt(t.keepShells, { reason: oneLine(reason) })}\r\n ${t.keepShellsLost}\x1b[0m\r\n`
}

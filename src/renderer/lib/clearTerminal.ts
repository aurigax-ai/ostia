import type { Terminal } from '@xterm/xterm'

export const FORM_FEED = '\x0c'

export function clearKeepingScrollback(term: Terminal, atPrompt: boolean): Promise<boolean> {
  const buffer = term.buffer.active
  if (buffer.type === 'alternate') return Promise.resolve(false)
  const pushed = buffer.cursorY + 1
  return new Promise((resolve) => {
    term.write(`\x1b[${term.rows};1H${'\n'.repeat(pushed)}\x1b[H`, () => {
      term.scrollToBottom()
      if (atPrompt) term.input(FORM_FEED, true)
      resolve(true)
    })
  })
}

const ESC = '\\x1b'
const ST = `(?:\\x07|${ESC}\\\\)`

const REPLIES = [
  `${ESC}\\[[IO]`,
  `${ESC}\\[[?>=]?[\\d;]*c`,
  `${ESC}\\[\\??[\\d;]*n`,
  `${ESC}\\[\\?\\d+;\\d+(?:;\\d+)?R`,
  `${ESC}\\[(?!1;[2-8]R)\\d+;\\d+R`,
  `${ESC}\\[\\??\\d+;\\d+\\$y`,
  `${ESC}\\[\\d+(?:;\\d+)+t`,
  `${ESC}\\[\\?\\d+u`,
  `${ESC}\\][\\d;]+;rgb:[^\\x07\\x1b]*${ST}`,
  `${ESC}P[^\\x1b]*${ESC}\\\\`,
]

const TERMINAL_REPLIES = new RegExp(`^(?:${REPLIES.join('|')})+$`)

export function isTerminalReply(data: string): boolean {
  return TERMINAL_REPLIES.test(data)
}

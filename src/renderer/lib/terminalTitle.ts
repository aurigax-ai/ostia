export const TERMINAL_TITLE_MAX = 120

const CONTROL_CHARS = /\p{Cc}/gu

export function terminalTitle(raw: string): string | null {
  const title = raw.replace(CONTROL_CHARS, '').trim()
  if (!title) return null
  return title.length > TERMINAL_TITLE_MAX ? `${title.slice(0, TERMINAL_TITLE_MAX - 1)}…` : title
}

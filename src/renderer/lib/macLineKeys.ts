interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export const KILL_LINE = '\x15'
export const LINE_START = '\x01'
export const LINE_END = '\x05'
export const WORD_BACK = '\x1bb'
export const WORD_FORWARD = '\x1bf'

const CMD_KEYS: Readonly<Record<string, string>> = {
  Backspace: KILL_LINE,
  ArrowLeft: LINE_START,
  ArrowRight: LINE_END,
}

const OPTION_KEYS: Readonly<Record<string, string>> = {
  ArrowLeft: WORD_BACK,
  ArrowRight: WORD_FORWARD,
}

export function macLineEditKey(e: KeyLike, mac: boolean, optionIsMeta = false): string | null {
  if (!mac || e.ctrlKey || e.shiftKey || e.metaKey === e.altKey) return null
  if (e.metaKey) return Object.hasOwn(CMD_KEYS, e.key) ? CMD_KEYS[e.key] : null
  if (optionIsMeta) return null
  return Object.hasOwn(OPTION_KEYS, e.key) ? OPTION_KEYS[e.key] : null
}

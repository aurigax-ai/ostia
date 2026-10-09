import type { TerminalDisposable as IDisposable, OstiaTerminal as Terminal } from './ostiaTerminal'

export const OSC52_MAX_PAYLOAD = 1024 * 1024

const TARGETS = /^[cpqs0-7]*$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function decodeOsc52(data: string): string | null {
  const sep = data.indexOf(';')
  if (sep === -1 || !TARGETS.test(data.slice(0, sep))) return null
  const payload = data.slice(sep + 1)
  if (payload.length > OSC52_MAX_PAYLOAD || !BASE64.test(payload)) return null
  try {
    const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text === '' ? null : text
  } catch {
    return null
  }
}

export interface Osc52Options {
  enabled: () => boolean
  replaying: () => boolean
  write: (text: string) => Promise<void>
}

export function registerOsc52(term: Pick<Terminal, 'parser'>, opts: Osc52Options): IDisposable {
  return term.parser.registerOscHandler(52, (data) => {
    if (opts.replaying() || !opts.enabled()) return true
    const text = decodeOsc52(data)
    if (text !== null) opts.write(text).catch(() => undefined)
    return true
  })
}

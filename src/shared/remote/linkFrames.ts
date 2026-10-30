export const LINK_FRAME_MAX = 1024 * 1024
export const LINK_HEARTBEAT_MS = 15_000
export const LINK_DEAD_MS = 45_000

interface MailFrame {
  t: 'mail'
  id: string
  from: string
  to: string
  text: string
}

export type LinkFrame =
  | { t: 'hello'; version: string }
  | { t: 'hello-ok'; version: string }
  | { t: 'incompatible'; version: string }
  | MailFrame
  | { t: 'stored'; id: string }
  | { t: 'refused'; id: string; reason: string }
  | { t: 'hb' }

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

export function parseFrame(line: string): LinkFrame | null {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  switch (raw.t) {
    case 'hb':
      return { t: 'hb' }
    case 'hello':
    case 'hello-ok':
    case 'incompatible':
      return text(raw.version, 64) ? { t: raw.t, version: raw.version } : null
    case 'stored':
      return text(raw.id, 100) ? { t: 'stored', id: raw.id } : null
    case 'refused':
      return text(raw.id, 100) && text(raw.reason, 64)
        ? { t: 'refused', id: raw.id, reason: raw.reason }
        : null
    case 'mail':
      return text(raw.id, 100) &&
        text(raw.from, 100) &&
        text(raw.to, 100) &&
        text(raw.text, LINK_FRAME_MAX)
        ? { t: 'mail', id: raw.id, from: raw.from, to: raw.to, text: raw.text }
        : null
    default:
      return null
  }
}

export function frameLine(frame: LinkFrame): string {
  return `${JSON.stringify(frame)}\n`
}

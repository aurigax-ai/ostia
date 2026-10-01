export interface PickBox {
  x: number
  y: number
  width: number
  height: number
}

export interface PickTheme {
  accent: string
  surface: string
  fg: string
}

export interface RawPick {
  url: string
  title: string
  selector: string
  label: string
  html: string
  box: PickBox
  viewport: { width: number; height: number }
  styles: Record<string, string>
  role: string
  name: string
}

export interface PickLogEntry {
  level: string
  text: string
  ts: number
}

export interface PickFailedRequest {
  url: string
  method: string
  status?: number
  error?: string
  ts: number
}

export interface PickCapture {
  id: string
  url: string
  title: string
  selector: string
  label: string
  html: string
  htmlTruncated: boolean
  box: PickBox
  styles: Record<string, string>
  role: string
  name: string
  consoleErrors: PickLogEntry[]
  failedRequests: PickFailedRequest[]
  screenshotPath: string | null
  capturedAt: string
}

export type PickError =
  | 'cancelled'
  | 'timeout'
  | 'navigated'
  | 'busy'
  | 'no-browser-pane'
  | 'browser-not-ready'
  | 'eval-failed'

export type PickOutcome = { ok: true; capture: PickCapture } | { ok: false; error: PickError }

export interface PickSendRequest {
  captureId: string
  sourcePaneId: string
  targetPaneId: string
  note: string
}

export type PickSendResult =
  | { ok: true; path: string }
  | { ok: false; error: 'capture-expired' | 'not-found' | 'write-failed' }

export interface PickState {
  paneId: string
  active: boolean
  byAgent: boolean
}

export const PICK_HTML_MAX = 2048
export const PICK_TEXT_MAX = 300
export const PICK_URL_MAX = 500
export const PICK_NOTE_MAX = 4000
export const PICK_LOG_MAX = 20
export const PICK_STYLE_VALUE_MAX = 200

export const PICK_STYLE_PROPS = [
  'display',
  'position',
  'box-sizing',
  'width',
  'height',
  'margin',
  'padding',
  'border',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'opacity',
  'visibility',
  'overflow',
  'z-index',
] as const

export function clip(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function finite(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

function normalizeBox(box: Partial<PickBox> | undefined): PickBox {
  return {
    x: finite(box?.x),
    y: finite(box?.y),
    width: finite(box?.width),
    height: finite(box?.height),
  }
}

function normalizeStyles(styles: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!styles || typeof styles !== 'object') return out
  const source = styles as Record<string, unknown>
  for (const prop of PICK_STYLE_PROPS) {
    const value = source[prop]
    if (typeof value === 'string' && value) out[prop] = clip(value, PICK_STYLE_VALUE_MAX)
  }
  return out
}

export interface CaptureExtras {
  id: string
  consoleErrors: readonly PickLogEntry[]
  failedRequests: readonly PickFailedRequest[]
  screenshotPath: string | null
  capturedAt: Date
}

export function normalizeCapture(raw: Partial<RawPick>, extras: CaptureExtras): PickCapture {
  const html = typeof raw.html === 'string' ? raw.html : ''
  return {
    id: extras.id,
    url: clip(raw.url, PICK_URL_MAX),
    title: clip(raw.title, PICK_TEXT_MAX),
    selector: clip(raw.selector, PICK_TEXT_MAX * 4),
    label: clip(raw.label, PICK_TEXT_MAX),
    html: html.length > PICK_HTML_MAX ? html.slice(0, PICK_HTML_MAX) : html,
    htmlTruncated: html.length > PICK_HTML_MAX,
    box: normalizeBox(raw.box),
    styles: normalizeStyles(raw.styles),
    role: clip(raw.role, 60),
    name: clip(raw.name, PICK_TEXT_MAX),
    consoleErrors: extras.consoleErrors.slice(-PICK_LOG_MAX).map((e) => ({
      level: clip(e.level, 20),
      text: clip(e.text, PICK_TEXT_MAX * 2),
      ts: e.ts,
    })),
    failedRequests: extras.failedRequests.slice(-PICK_LOG_MAX).map((r) => ({
      url: clip(r.url, PICK_URL_MAX),
      method: clip(r.method, 16),
      ...(r.status !== undefined ? { status: r.status } : {}),
      ...(r.error !== undefined ? { error: clip(r.error, PICK_TEXT_MAX) } : {}),
      ts: r.ts,
    })),
    screenshotPath: extras.screenshotPath,
    capturedAt: extras.capturedAt.toISOString(),
  }
}

export function screenshotRect(
  box: PickBox,
  viewport: { width: number; height: number },
  zoom: number,
): PickBox | null {
  const left = Math.max(0, box.x)
  const top = Math.max(0, box.y)
  const right = Math.min(viewport.width, box.x + box.width)
  const bottom = Math.min(viewport.height, box.y + box.height)
  if (right - left < 1 || bottom - top < 1) return null
  const z = zoom > 0 ? zoom : 1
  return {
    x: Math.floor(left * z),
    y: Math.floor(top * z),
    width: Math.ceil((right - left) * z),
    height: Math.ceil((bottom - top) * z),
  }
}

function fence(text: string, lang = ''): string {
  let ticks = '```'
  while (text.includes(ticks)) ticks += '`'
  return `${ticks}${lang}\n${text}\n${ticks}`
}

function inlineCode(text: string): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.includes('`') ? `\`\` ${flat} \`\`` : `\`${flat}\``
}

function time(ts: number): string {
  return new Date(ts).toISOString()
}

export function renderPickReport(capture: PickCapture, note: string): string {
  const lines: string[] = []
  const trimmedNote = clip(note.trim(), PICK_NOTE_MAX)
  lines.push(`# Captured element: ${capture.label || capture.selector}`, '')
  lines.push('## Note', '', trimmedNote || '(no note)', '')
  lines.push('## Element', '')
  lines.push(`- Page: ${capture.title ? `${capture.title} — ` : ''}${capture.url}`)
  lines.push(`- Selector: ${inlineCode(capture.selector)}`)
  lines.push(`- Role / name: ${capture.role || '-'} / ${capture.name || '-'}`)
  const b = capture.box
  lines.push(`- Box: x ${b.x}, y ${b.y}, ${b.width} × ${b.height} (CSS px, viewport)`)
  lines.push(`- Screenshot: ${capture.screenshotPath ?? '(not captured: element off screen)'}`)
  lines.push(`- Captured: ${capture.capturedAt}`, '')
  const styleEntries = Object.entries(capture.styles)
  if (styleEntries.length > 0) {
    lines.push('## Computed style', '')
    for (const [k, v] of styleEntries) lines.push(`- ${k}: ${v}`)
    lines.push('')
  }
  lines.push(
    `## HTML${capture.htmlTruncated ? ' (truncated)' : ''}`,
    '',
    fence(capture.html, 'html'),
    '',
  )
  lines.push('## Console errors', '')
  if (capture.consoleErrors.length === 0) lines.push('None recorded.')
  else for (const e of capture.consoleErrors) lines.push(`- ${time(e.ts)} ${inlineCode(e.text)}`)
  lines.push('', '## Failed network requests', '')
  if (capture.failedRequests.length === 0) lines.push('None recorded.')
  else
    for (const r of capture.failedRequests) {
      const why = r.status !== undefined ? `HTTP ${r.status}` : (r.error ?? 'failed')
      lines.push(`- ${time(r.ts)} ${r.method} ${inlineCode(r.url)} → ${why}`)
    }
  lines.push('')
  return lines.join('\n')
}

export interface PickBusMessage {
  kind: 'capture'
  report: string
  url: string
  selector: string
  note: string
}

export function pickBusMessage(capture: PickCapture, note: string, report: string): string {
  const message: PickBusMessage = {
    kind: 'capture',
    report,
    url: capture.url,
    selector: capture.selector,
    note: clip(note.trim(), PICK_NOTE_MAX),
  }
  return JSON.stringify(message)
}

export function reportReference(path: string): string {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `
}

export const REPORT_SLUG_MAX = 48

export function urlSlug(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  return `${parsed.host}${parsed.pathname}`
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, REPORT_SLUG_MAX)
    .replace(/^-+|-+$/g, '')
}

export function pickReportName(n: number, url: string): string {
  const slug = urlSlug(url)
  return slug ? `capture-${n}-${slug}.md` : `capture-${n}.md`
}

export function nextPickReportNumber(names: readonly string[]): number {
  let highest = 0
  for (const name of names) {
    const match = /^capture-(\d+)(?:-[a-z0-9-]*)?\.md$/.exec(name)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

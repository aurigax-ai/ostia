import { existsSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import log from 'electron-log/node'

export const LOG_FILE_NAME = 'main.log'
export const LOG_MAX_BYTES = 1024 * 1024
export const LOG_KEEP_FILES = 3
export const LOG_FIELD_MAX_CHARS = 4000

export type LogValue = string | number | boolean | null | undefined
export type LogFields = Record<string, LogValue>

export interface AppLog {
  readonly file: string
  info: (event: string, fields?: LogFields) => void
  warn: (event: string, fields?: LogFields) => void
  error: (event: string, fields?: LogFields) => void
}

const REDACTED = '[redacted]'

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [
    /\b([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|api[_-]?key|auth|credential|cookie)[A-Za-z0-9_-]*)(["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&,;"']+)/gi,
    `$1$2${REDACTED}`,
  ],
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, REDACTED],
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(${text.length - max} more)` : text
}

function renderValue(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value)
  const safe = clip(redactSecrets(value), LOG_FIELD_MAX_CHARS)
  return /^[A-Za-z0-9._:/@+-]+$/.test(safe) ? safe : JSON.stringify(safe)
}

export function formatEntry(event: string, fields: LogFields = {}): string {
  const parts = [event]
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    parts.push(`${key}=${renderValue(value)}`)
  }
  return parts.join(' ')
}

export function rotatedName(file: string, index: number): string {
  const { dir, name, ext } = parse(file)
  return join(dir, `${name}.${index}${ext}`)
}

export function rotateLogFiles(file: string, keep: number = LOG_KEEP_FILES): void {
  const archives = keep - 1
  if (archives < 1) {
    rmSync(file, { force: true })
    return
  }
  rmSync(rotatedName(file, archives), { force: true })
  for (let i = archives - 1; i >= 1; i--) {
    const from = rotatedName(file, i)
    if (existsSync(from)) renameSync(from, rotatedName(file, i + 1))
  }
  if (existsSync(file)) renameSync(file, rotatedName(file, 1))
}

let instances = 0

export function createAppLog(
  file: string,
  opts: { maxBytes?: number; keep?: number } = {},
): AppLog {
  instances += 1
  const logger = log.create({ logId: `ostia-app-log-${instances}` })
  logger.transports.console.level = false
  const transport = logger.transports.file
  transport.level = 'info'
  transport.resolvePathFn = () => file
  transport.maxSize = opts.maxBytes ?? LOG_MAX_BYTES
  transport.writeOptions = { flag: 'a', mode: 0o600, encoding: 'utf8' }
  transport.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  transport.archiveLogFn = (oldFile) => {
    try {
      rotateLogFiles(oldFile.toString(), opts.keep ?? LOG_KEEP_FILES)
    } catch {
      oldFile.clear()
    }
  }
  const write =
    (level: 'info' | 'warn' | 'error') =>
    (event: string, fields?: LogFields): void => {
      try {
        logger[level](formatEntry(event, fields))
      } catch {}
    }
  return { file, info: write('info'), warn: write('warn'), error: write('error') }
}

export function logDirOf(appLog: AppLog): string {
  return dirname(appLog.file)
}

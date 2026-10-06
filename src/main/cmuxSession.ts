import { readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { ipcMain } from 'electron'
import { CMUX_SESSION_FILE, type CmuxSessionRead, parseCmuxSession } from '../shared/cmuxSession'

export const CMUX_SESSION_MAX_BYTES = 32 * 1024 * 1024

export function cmuxSessionPath(home: string): string {
  return join(home, CMUX_SESSION_FILE)
}

function errorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function readCmuxSession(raw: unknown, home: string): CmuxSessionRead {
  if (raw !== undefined && raw !== null && (typeof raw !== 'string' || !isAbsolute(raw))) {
    return { ok: false, error: 'bad-path' }
  }
  const path = typeof raw === 'string' ? raw : cmuxSessionPath(home)
  let real: string
  try {
    real = realpathSync(path)
  } catch (err) {
    return { ok: false, error: errorCode(err) === 'ENOENT' ? 'not-found' : 'unreadable', path }
  }
  let realHome: string
  try {
    realHome = realpathSync(home)
  } catch {
    realHome = home
  }
  if (!inside(real, realHome)) return { ok: false, error: 'outside-home', path }
  let body: string
  try {
    const stat = statSync(real)
    if (!stat.isFile()) return { ok: false, error: 'not-found', path }
    if (stat.size > CMUX_SESSION_MAX_BYTES) return { ok: false, error: 'too-large', path }
    body = readFileSync(real, 'utf8')
  } catch {
    return { ok: false, error: 'unreadable', path }
  }
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { ok: false, error: 'invalid', path }
  }
  const parsed = parseCmuxSession(json)
  return 'session' in parsed
    ? { ok: true, path, session: parsed.session }
    : { ok: false, error: parsed.error, path }
}

export function registerCmuxSessionIpc(home: string = homedir()): void {
  ipcMain.handle('workspace:read-cmux', (_e, raw: unknown) => readCmuxSession(raw, home))
}

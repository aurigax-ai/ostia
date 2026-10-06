import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CMUX_SESSION_MAX_BYTES, cmuxSessionPath, readCmuxSession } from './cmuxSession'

const FIXTURE = resolve(__dirname, '../../test/fixtures/cmux/session-com.cmuxterm.app.json')

let root: string
let home: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-cmux-test-'))
  home = join(root, 'home')
  mkdirSync(home)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function place(path: string, body?: string): void {
  mkdirSync(dirname(path), { recursive: true })
  if (body === undefined) copyFileSync(FIXTURE, path)
  else writeFileSync(path, body)
}

describe('readCmuxSession', () => {
  it('reads cmux’s own session file when no path is given', () => {
    place(cmuxSessionPath(home))

    const read = readCmuxSession(undefined, home)

    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.path).toBe(
      join(home, 'Library/Application Support/cmux/session-com.cmuxterm.app.json'),
    )
    expect(read.session.windows.map((w) => w.workspaces.length)).toEqual([5, 1])
  })

  it('reads a session file the human points at inside the home folder', () => {
    const backup = join(home, 'backups', 'session.json')
    place(backup)

    const read = readCmuxSession(backup, home)

    expect(read.ok && read.path).toBe(backup)
  })

  it('says not-found when cmux never saved a session', () => {
    expect(readCmuxSession(undefined, home)).toEqual({
      ok: false,
      error: 'not-found',
      path: cmuxSessionPath(home),
    })
  })

  it('refuses a relative path and anything that is not a string', () => {
    expect(readCmuxSession('session.json', home)).toEqual({ ok: false, error: 'bad-path' })
    expect(readCmuxSession(42, home)).toEqual({ ok: false, error: 'bad-path' })
  })

  it('refuses a file outside the home folder, also when reached through a symlink', () => {
    const outside = join(root, 'elsewhere', 'session.json')
    place(outside)
    const link = join(home, 'link.json')
    symlinkSync(outside, link)

    expect(readCmuxSession(outside, home)).toMatchObject({ ok: false, error: 'outside-home' })
    expect(readCmuxSession(link, home)).toMatchObject({ ok: false, error: 'outside-home' })
  })

  it('refuses a folder, a huge file, broken JSON and JSON that is not a cmux session', () => {
    const folder = join(home, 'folder')
    mkdirSync(folder)
    const huge = join(home, 'huge.json')
    place(huge, '{}')
    truncateSync(huge, CMUX_SESSION_MAX_BYTES + 1)
    const broken = join(home, 'broken.json')
    place(broken, '{"version": 1, "windows": [')
    const foreign = join(home, 'foreign.json')
    place(foreign, JSON.stringify({ v: 1, workspaces: [] }))
    const future = join(home, 'future.json')
    place(future, JSON.stringify({ version: 2, windows: [] }))

    expect(readCmuxSession(folder, home)).toMatchObject({ error: 'not-found' })
    expect(readCmuxSession(huge, home)).toMatchObject({ error: 'too-large' })
    expect(readCmuxSession(broken, home)).toMatchObject({ error: 'invalid' })
    expect(readCmuxSession(foreign, home)).toMatchObject({ error: 'invalid' })
    expect(readCmuxSession(future, home)).toMatchObject({ error: 'unsupported-version' })
  })
})

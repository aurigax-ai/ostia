import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptedProfileFolders,
  acceptProfile,
  accountEmail,
  createProfile,
  credentialsPresent,
  removeProfile,
  sweepPendingProfiles,
} from './accountProfiles'

const WORK = 'a'.repeat(16)
const STALE = 'c'.repeat(16)

let base: string
let root: string
let home: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-profiles-'))
  root = join(base, 'claude-accounts')
  home = join(base, 'dot-claude')
  mkdirSync(home)
  writeFileSync(join(home, 'settings.json'), '{}')
  mkdirSync(join(home, 'skills'))
})

afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('createProfile', () => {
  it('makes a 0700 folder that shares projects and the files the default has, but never links settings.json', () => {
    const dir = createProfile(root, WORK, home)
    expect(dir).toBe(join(root, WORK))
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readlinkSync(join(dir, 'projects'))).toBe(join(home, 'projects'))
    expect(existsSync(join(dir, 'settings.json'))).toBe(false)
    expect(readlinkSync(join(dir, 'skills'))).toBe(join(home, 'skills'))
    expect(existsSync(join(dir, 'history.jsonl'))).toBe(false)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })

  it('creates projects in the default when it is missing, so a session started here is found there', () => {
    createProfile(root, WORK, home)
    expect(statSync(join(home, 'projects')).isDirectory()).toBe(true)
  })
})

describe('removeProfile', () => {
  it('deletes the profile and never what its links point to', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(join(dir, '.credentials.json'), 'x')
    mkdirSync(join(home, 'projects', 'p'))
    writeFileSync(join(home, 'projects', 'p', 's.jsonl'), 'session')
    await removeProfile(root, WORK)
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(home, 'projects', 'p', 's.jsonl'), 'utf8')).toBe('session')
    expect(readFileSync(join(home, 'settings.json'), 'utf8')).toBe('{}')
  })
})

describe('sweepPendingProfiles', () => {
  const OLD = Date.now() + 60 * 60 * 1000
  const NONE: ReadonlySet<string> = new Set()
  const NO_LOGIN = async () => false

  it('removes only folders still marked pending and older than the wait', async () => {
    createProfile(root, WORK, home)
    createProfile(root, STALE, home)
    await acceptProfile(root, WORK)
    await sweepPendingProfiles(root, 30 * 60 * 1000, Date.now(), NONE, NO_LOGIN)
    expect(existsSync(join(root, STALE))).toBe(true)
    await sweepPendingProfiles(root, 30 * 60 * 1000, OLD, NONE, NO_LOGIN)
    expect(existsSync(join(root, WORK))).toBe(true)
    expect(existsSync(join(root, STALE))).toBe(false)
  })

  it('never removes a folder without the marker, a stray name or anything else', async () => {
    createProfile(root, WORK, home)
    await acceptProfile(root, WORK)
    mkdirSync(join(root, 'c'.repeat(16)))
    mkdirSync(join(root, 'not-a-profile'))
    await sweepPendingProfiles(root, 0, OLD, NONE, NO_LOGIN)
    expect(existsSync(join(root, WORK))).toBe(true)
    expect(existsSync(join(root, 'c'.repeat(16)))).toBe(true)
    expect(existsSync(join(root, 'not-a-profile'))).toBe(true)
  })

  it('keeps and accepts a pending folder that is listed or holds a login', async () => {
    createProfile(root, WORK, home)
    createProfile(root, STALE, home)
    await sweepPendingProfiles(root, 0, OLD, new Set([WORK]), async (dir) => dir.endsWith(STALE))
    expect(await acceptedProfileFolders(root)).toEqual([WORK, STALE].sort())
  })

  it('does nothing when the folder does not exist', async () => {
    await expect(
      sweepPendingProfiles(join(base, 'missing'), 0, OLD, NONE, NO_LOGIN),
    ).resolves.toBeUndefined()
  })
})

describe('acceptedProfileFolders', () => {
  it('lists profile folders that are not pending', async () => {
    createProfile(root, WORK, home)
    createProfile(root, STALE, home)
    await acceptProfile(root, WORK)
    mkdirSync(join(root, 'not-a-profile'))
    expect(await acceptedProfileFolders(root)).toEqual([WORK])
  })
})

describe('accountEmail', () => {
  it('reads the address of the login recorded in the profile’s config', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', accountUuid: 'u' } }),
    )
    expect(await accountEmail(dir)).toBe('me@example.com')
  })

  it.each([
    ['no config', null],
    ['no login', '{"projects":{}}'],
    ['a damaged file', '{'],
    ['an empty address', '{"oauthAccount":{"emailAddress":""}}'],
  ])('answers null for %s', async (_name, text) => {
    const dir = createProfile(root, WORK, home)
    if (text !== null) writeFileSync(join(dir, '.claude.json'), text)
    expect(await accountEmail(dir)).toBeNull()
  })

  it('reads a config that is a link a dotfile manager made', async () => {
    const dir = createProfile(root, WORK, home)
    const elsewhere = join(base, 'elsewhere.json')
    writeFileSync(elsewhere, '{"oauthAccount":{"emailAddress":"me@example.com"}}')
    symlinkSync(elsewhere, join(dir, '.claude.json'))
    expect(await accountEmail(dir)).toBe('me@example.com')
  })
})

describe('credentialsPresent', () => {
  it('looks for the credential file on Linux and trusts the keychain on macOS', () => {
    const dir = createProfile(root, WORK, home)
    expect(credentialsPresent(dir, 'linux')).toBe(false)
    expect(credentialsPresent(dir, 'darwin')).toBe(true)
    writeFileSync(join(dir, '.credentials.json'), 'x')
    expect(credentialsPresent(dir, 'linux')).toBe(true)
  })
})

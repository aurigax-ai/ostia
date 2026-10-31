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
import { lock } from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acceptedProfileFolders,
  acceptProfile,
  accountEmail,
  createProfile,
  credentialsPresent,
  credentialsStamp,
  loginState,
  removeProfile,
  sweepPendingProfiles,
  usageToken,
  writeLogin,
} from './accountProfiles'
import type { OAuthProfile, OAuthTokens } from './signIn/anthropicOAuth'

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

const TOKENS: OAuthTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: 5_000,
  scopes: ['user:inference'],
}
const PROFILE: OAuthProfile = {
  accountUuid: 'uuid-1',
  emailAddress: 'work@example.com',
  displayName: 'Work',
  organizationUuid: 'org-1',
  organizationName: 'Org',
  subscriptionType: 'max',
  rateLimitTier: 'tier-1',
}
const onLinuxOrWindows = it.skipIf(process.platform === 'darwin')

describe('writeLogin', () => {
  onLinuxOrWindows('writes the login 0600 into the profile and records the account', async () => {
    const dir = createProfile(root, WORK, home)
    expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(true)
    const file = join(dir, '.credentials.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      claudeAiOauth: {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        expiresAt: 5_000,
        scopes: ['user:inference'],
        subscriptionType: 'max',
        rateLimitTier: 'tier-1',
      },
    })
    expect(credentialsPresent(dir)).toBe(true)
    expect(await accountEmail(dir)).toBe('work@example.com')
    const config = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'))
    expect(config.hasCompletedOnboarding).toBe(true)
    expect(config.oauthAccount.accountUuid).toBe('uuid-1')
    expect(statSync(join(dir, '.claude.json')).mode & 0o777).toBe(0o600)
  })

  onLinuxOrWindows('keeps what the profile already holds beside the login', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ mcpOAuth: { server: 1 } }))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects: { '/a': { x: 1 } } }))
    expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')).mcpOAuth).toEqual({
      server: 1,
    })
    expect(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')).projects).toEqual({
      '/a': { x: 1 },
    })
  })

  onLinuxOrWindows('refuses to replace a credentials file it cannot read as JSON', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(join(dir, '.credentials.json'), 'not json')
    expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(false)
    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe('not json')
  })

  onLinuxOrWindows(
    'refuses a credentials file that is a symlink and leaves its target alone',
    async () => {
      const dir = createProfile(root, WORK, home)
      const target = join(base, 'elsewhere.json')
      writeFileSync(target, '{"keep":true}')
      symlinkSync(target, join(dir, '.credentials.json'))
      expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(false)
      expect(readFileSync(target, 'utf8')).toBe('{"keep":true}')
    },
  )

  onLinuxOrWindows('writes no login when the account cannot be recorded first', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(join(dir, '.claude.json'), 'not json')
    expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(false)
    expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
  })

  onLinuxOrWindows(
    'honours a lock another holder has, and writes once it is released',
    async () => {
      const dir = createProfile(root, WORK, home)
      const release = await lock(join(dir, '.storage-write'), { realpath: false })
      const fast = { retries: 2, minTimeout: 10, maxTimeout: 10 }
      expect(await writeLogin(dir, TOKENS, PROFILE, fast)).toBe(false)
      expect(existsSync(join(dir, '.credentials.json'))).toBe(false)
      const waiting = writeLogin(dir, TOKENS, PROFILE, {
        retries: 20,
        minTimeout: 20,
        maxTimeout: 20,
      })
      setTimeout(() => void release(), 60)
      expect(await waiting).toBe(true)
      expect(existsSync(join(dir, '.credentials.json'))).toBe(true)
    },
  )

  onLinuxOrWindows('leaves no lock behind', async () => {
    const dir = createProfile(root, WORK, home)
    await writeLogin(dir, TOKENS, PROFILE)
    expect(existsSync(join(dir, '.storage-write.lock'))).toBe(false)
  })
})

describe('loginState', () => {
  const NOW = 10_000
  let count = 0
  const write = (oauth: unknown): string => {
    count += 1
    const dir = createProfile(root, String(count).padStart(16, '0'), home)
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
    return dir
  }

  it('is signed in with a refresh token that has not lapsed', async () => {
    expect(await loginState(write({ refreshToken: 'r' }), NOW, 'linux')).toBe('signed-in')
    expect(
      await loginState(write({ refreshToken: 'r', refreshTokenExpiresAt: NOW + 1 }), NOW, 'linux'),
    ).toBe('signed-in')
  })

  it('is signed out without a refresh token, with a lapsed one, or without the file', async () => {
    expect(await loginState(write({ accessToken: 'a' }), NOW, 'linux')).toBe('signed-out')
    expect(
      await loginState(write({ refreshToken: 'r', refreshTokenExpiresAt: NOW }), NOW, 'linux'),
    ).toBe('signed-out')
    expect(await loginState(join(root, STALE), NOW, 'linux')).toBe('signed-out')
  })

  it('is signed out for a file that is not JSON', async () => {
    const dir = createProfile(root, WORK, home)
    writeFileSync(join(dir, '.credentials.json'), 'x')
    expect(await loginState(dir, NOW, 'linux')).toBe('signed-out')
  })

  it('cannot tell on macOS, where the login is in the Keychain', async () => {
    expect(await loginState(join(root, STALE), NOW, 'darwin')).toBe('signed-in')
  })
})

describe('usageToken', () => {
  const NOW = 1_000_000
  let made = 0
  const write = (oauth: unknown): string => {
    made += 1
    const dir = createProfile(root, `u${String(made).padStart(15, '0')}`.replace('u', 'f'), home)
    writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }))
    return dir
  }

  it('gives the access token and the file stamp while the token has more than a minute left', async () => {
    const dir = write({ accessToken: 'tok', refreshToken: 'r', expiresAt: NOW + 120_000 })
    const token = await usageToken(dir, NOW, 'linux')
    expect(token?.accessToken).toBe('tok')
    expect(token?.stamp).toBe(await credentialsStamp(dir))
  })

  it('gives nothing for a token that expired or is about to, so Claude refreshes it, never Ostia', async () => {
    expect(
      await usageToken(write({ accessToken: 'tok', expiresAt: NOW + 30_000 }), NOW, 'linux'),
    ).toBeNull()
  })

  it('gives nothing without a usable token, without the file, or on macOS', async () => {
    expect(
      await usageToken(write({ accessToken: 'a b', expiresAt: NOW * 2 }), NOW, 'linux'),
    ).toBeNull()
    expect(await usageToken(join(root, STALE), NOW, 'linux')).toBeNull()
    const dir = write({ accessToken: 'tok', expiresAt: NOW * 2 })
    expect(await usageToken(dir, NOW, 'darwin')).toBeNull()
  })

  it('stamps a new value once Claude rewrites the file', async () => {
    const dir = write({ accessToken: 'tok', expiresAt: NOW * 2 })
    const before = await credentialsStamp(dir)
    writeFileSync(
      join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'longer-token', expiresAt: NOW * 3 } }),
    )
    expect(await credentialsStamp(dir)).not.toBe(before)
  })
})

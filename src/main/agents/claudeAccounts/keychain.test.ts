import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeProfile, writeLogin } from './accountProfiles'
import {
  forgetKeychain,
  keychainAccount,
  keychainService,
  readKeychain,
  writeKeychain,
} from './keychain'
import type { OAuthProfile, OAuthTokens } from './signIn/anthropicOAuth'

const FAKE_SECURITY = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const store = process.env.FAKE_KEYCHAIN
const args = process.argv.slice(2)
const flag = (list, name) => list[list.indexOf(name) + 1]
const file = (service) => path.join(store, Buffer.from(service).toString('hex'))
fs.appendFileSync(path.join(store, '.argv'), JSON.stringify(args) + '\\n')
if (args[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8').trim()
  const parts = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  fs.writeFileSync(file(parts[1]), Buffer.from(parts[2], 'hex'))
} else if (args[0] === 'find-generic-password') {
  const target = file(flag(args, '-s'))
  if (!fs.existsSync(target)) process.exit(44)
  process.stdout.write(fs.readFileSync(target, 'utf8') + '\\n')
} else if (args[0] === 'delete-generic-password') {
  const target = file(flag(args, '-s'))
  if (!fs.existsSync(target)) process.exit(44)
  fs.unlinkSync(target)
}
`

const TOKENS: OAuthTokens = {
  accessToken: 'sk-ant-oat01-access',
  refreshToken: 'sk-ant-ort01-refresh',
  expiresAt: 9_999_999_999_999,
  scopes: ['user:inference'],
}
const PROFILE: OAuthProfile = {
  accountUuid: 'acct-1',
  emailAddress: 'me@example.com',
  displayName: 'Me',
  organizationUuid: 'org-1',
  organizationName: 'Org',
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_5x',
}

describe('keychain', () => {
  let work: string
  let store: string
  let oldPath: string | undefined

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'ostia-keychain-'))
    store = join(work, 'store')
    mkdirSync(store)
    const bin = join(work, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'security'), FAKE_SECURITY)
    chmodSync(join(bin, 'security'), 0o755)
    oldPath = process.env.PATH
    process.env.PATH = `${bin}:${oldPath}`
    process.env.FAKE_KEYCHAIN = store
    process.env.USER = 'tester'
  })

  afterEach(() => {
    process.env.PATH = oldPath
    delete process.env.FAKE_KEYCHAIN
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    rmSync(work, { recursive: true, force: true })
  })

  it('names the item the way Claude Code does for a config folder', () => {
    const dir = '/data/claude-accounts/abc'
    const digest = createHash('sha256').update(dir).digest('hex').slice(0, 8)
    expect(keychainService(dir)).toBe(`Claude Code-credentials-${digest}`)
    expect(keychainAccount({ USER: 'tester' })).toBe('tester')
    expect(keychainAccount({ USER: 'bad user!' })).toBe('claude-code-user')
  })

  it('writes through stdin, never putting the token in the arguments', async () => {
    expect(await writeKeychain('/p/one', { claudeAiOauth: { accessToken: 'secret-token' } })).toBe(
      true,
    )
    expect(await readKeychain('/p/one')).toEqual({ claudeAiOauth: { accessToken: 'secret-token' } })
    const argv = readFileSync(join(store, '.argv'), 'utf8')
    expect(argv).not.toContain('secret-token')
    expect(argv).not.toContain(Buffer.from('secret-token').toString('hex'))
  })

  it('reads an absent item as empty and forgets an item', async () => {
    expect(await readKeychain('/p/two')).toEqual({})
    await writeKeychain('/p/two', { a: 1 })
    await forgetKeychain('/p/two')
    expect(await readKeychain('/p/two')).toEqual({})
  })

  it('writes the sign-in login into the profile item on macOS and keeps other keys', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const dir = join(work, 'profile')
    mkdirSync(dir)
    await writeKeychain(dir, { mcpOAuth: { server: 1 } })
    expect(await writeLogin(dir, TOKENS, PROFILE)).toBe(true)
    const item = await readKeychain(dir)
    expect(item).toMatchObject({
      mcpOAuth: { server: 1 },
      claudeAiOauth: { accessToken: TOKENS.accessToken, refreshToken: TOKENS.refreshToken },
    })
    expect(readdirSync(dir)).not.toContain('.credentials.json')
  })

  it('forgets the profile item when the profile is removed on macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const root = join(work, 'accounts')
    mkdirSync(join(root, 'p1'), { recursive: true })
    await writeKeychain(join(root, 'p1'), { a: 1 })
    await removeProfile(root, 'p1')
    expect(await readKeychain(join(root, 'p1'))).toEqual({})
  })
})

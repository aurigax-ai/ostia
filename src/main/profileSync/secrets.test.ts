import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FAKE } from '../../../test/fixtures/secrets/samples'
import { createCredentialStore } from '../credentials'
import { ProfileSync } from './engine'
import { FolderMethod } from './folderMethod'
import { SECRETS_FILE } from './profile'
import { openBundle } from './secretCrypto'
import {
  type SecretEntry,
  type SecretSource,
  type SecretSourceName,
  SecretSync,
  loginsSource,
} from './secrets'

const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'staple orange lantern'

const roots: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-sync-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface MemorySource extends SecretSource {
  data: Map<string, SecretEntry>
  failNextWrite: boolean
}

function memorySource(name: SecretSourceName, clock: { ms: number }): MemorySource {
  const source: MemorySource = {
    name,
    data: new Map(),
    failNextWrite: false,
    read: () => new Map(source.data),
    write: (changes) => {
      if (source.failNextWrite) {
        source.failNextWrite = false
        throw new Error('disk full')
      }
      for (const [key, value] of changes) {
        if (value === null) source.data.delete(key)
        else source.data.set(key, { value, at: clock.ms })
      }
    },
    describe: (key) => `${name}: ${key}`,
  }
  return source
}

const protect = {
  encrypt: (plain: string) => `kept:${Buffer.from(plain).toString('base64')}`,
  decrypt: (kept: string) => Buffer.from(kept.slice('kept:'.length), 'base64').toString(),
}

interface Machine {
  userData: string
  sync: ProfileSync
  secrets: SecretSync
  clock: { ms: number }
  vault: MemorySource
  extensions: MemorySource
  assistant: MemorySource
  mcp: MemorySource
  logins: ReturnType<typeof createCredentialStore>
  restart: () => Machine
}

function machine(target: string, existing?: { userData: string; configDir: string }): Machine {
  const root = existing ? null : temp()
  const userData = existing?.userData ?? join(root as string, 'data')
  const configDir = existing?.configDir ?? join(root as string, 'config')
  mkdirSync(userData, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const clock = { ms: Date.UTC(2026, 9, 6, 12) }
  const vault = memorySource('vault', clock)
  const extensions = memorySource('extensions', clock)
  const assistant = memorySource('assistant', clock)
  const mcp = memorySource('mcp', clock)
  let stored: {
    id: string
    origin: string
    username: string
    secret: string
    updatedAt: number
  }[] = []
  let ids = 0
  const logins = createCredentialStore({
    load: () => structuredClone(stored),
    save: (list) => {
      stored = structuredClone(list)
    },
    canEncrypt: () => true,
    encrypt: (plain) => protect.encrypt(plain),
    decrypt: (kept) => protect.decrypt(kept),
    now: () => clock.ms,
    newId: () => `id-${++ids}`,
  })
  const method = () => new FolderMethod(target, [userData, configDir])
  const secrets = new SecretSync({
    userData,
    protect,
    sources: () => [vault, extensions, assistant, mcp, loginsSource(logins)],
    readRemote: async () => (await method().read()).files.get(SECRETS_FILE),
  })
  const sync = new ProfileSync({
    userData,
    configDir,
    now: () => new Date(clock.ms),
    method,
    targetLabel: () => target,
    installedExtensions: () => [],
    builtinIds: () => [],
    installExtension: async () => false,
    detectSecrets: async () => [],
    secrets,
  })
  const self: Machine = {
    userData,
    sync,
    secrets,
    clock,
    vault,
    extensions,
    assistant,
    mcp,
    logins,
    restart: () => {
      const next = machine(target, { userData, configDir })
      for (const name of ['vault', 'extensions', 'assistant', 'mcp'] as const) {
        next[name].data = self[name].data
      }
      return next
    },
  }
  return self
}

const entry = (value: string, at = 1): SecretEntry => ({ value, at })

async function setUp(a: Machine): Promise<string> {
  const res = await a.secrets.setup(PASSWORD, PASSWORD)
  if (!res.ok) throw new Error(res.error)
  await a.sync.run()
  return res.recoveryKey
}

async function bundleEntries(target: string, password: string): Promise<Map<string, string>> {
  const text = readFileSync(join(target, SECRETS_FILE), 'utf8')
  const bundle = openBundle(text)
  if (!bundle) throw new Error('no bundle')
  const opened = await bundle.openWithPassword(password)
  if (opened === null) throw new Error('wrong password')
  const parsed = JSON.parse(opened) as { entries: Record<string, { value: string }> }
  return new Map(Object.entries(parsed.entries).map(([k, v]) => [k, v.value]))
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
}

async function loginClash(): Promise<{ target: string; a: Machine; b: Machine; id: string }> {
  const target = temp()
  const a = machine(target)
  const b = machine(target)
  a.logins.save({ origin: 'https://example.com', username: 'me', password: 'first-password' })
  await setUp(a)
  await a.secrets.setLogins(true)
  await a.sync.run()
  await b.secrets.unlock(PASSWORD)
  await b.secrets.setLogins(true)
  await b.sync.run()
  a.clock.ms += 1000
  a.logins.save({ origin: 'https://example.com', username: 'me', password: 'from-a-pass' })
  b.clock.ms += 2000
  b.logins.save({ origin: 'https://example.com', username: 'me', password: 'from-b-pass' })
  await a.sync.run()
  const res = await b.sync.run()
  const id = res.status.conflicts.find((c) => c.kind === 'secret')?.id ?? ''
  return { target, a, b, id }
}

describe('secret sync', () => {
  it('PSY-C28 sends no secret while secret sync is off', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('GITHUB_TOKEN', entry(FAKE.githubClassic))
    a.extensions.data.set('["trellis","token"]', entry('ext-secret-value'))
    a.assistant.data.set('["anthropic","key"]', entry(FAKE.anthropic))
    a.logins.save({ origin: 'https://example.com', username: 'me', password: 'hunter2hunter2' })
    await a.sync.run()
    await b.sync.run()
    expect(existsSync(join(target, SECRETS_FILE))).toBe(false)
    const everything = filesUnder(target)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    expect(everything).not.toContain(FAKE.githubClassic)
    expect(everything).not.toContain('hunter2hunter2')
    expect(b.vault.data.size + b.extensions.data.size + b.assistant.data.size).toBe(0)
    expect(b.logins.list()).toEqual([])
  })

  it('PSY-C29 reads no secret file placed in the target while secret sync is off', async () => {
    const target = temp()
    const a = machine(target)
    await setUp(a)
    a.vault.data.set('GITHUB_TOKEN', entry(FAKE.githubClassic))
    await a.sync.run()
    writeFileSync(join(target, 'assist-keys.json'), JSON.stringify({ x: { key: 'v' } }))
    writeFileSync(join(target, 'vault.json'), JSON.stringify({ K: 'v' }))
    const b = machine(target)
    const res = await b.sync.run()
    expect(b.vault.data.size + b.assistant.data.size).toBe(0)
    expect(res.status.secrets.state).toBe('off')
  })

  it('PSY-C33 leaves browser logins out while their checkbox is off', async () => {
    const target = temp()
    const a = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    a.extensions.data.set('["e","k"]', entry('ext-value'))
    a.assistant.data.set('["p","key"]', entry('assist-value'))
    a.mcp.data.set('["srv","token"]', entry('mcp-value'))
    a.logins.save({ origin: 'https://example.com', username: 'me', password: 'hunter2hunter2' })
    await setUp(a)
    const names = [...(await bundleEntries(target, PASSWORD)).keys()].map((k) => k.split('\0')[0])
    expect(new Set(names)).toEqual(new Set(['vault', 'extensions', 'assistant', 'mcp']))
  })

  it('PSY-C34 lets another machine fill a synced login once logins are on', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.logins.save({ origin: 'https://example.com', username: 'me', password: 'hunter2hunter2' })
    await setUp(a)
    await a.secrets.setLogins(true)
    await a.sync.run()
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    await b.secrets.setLogins(true)
    await b.sync.run()
    expect(b.logins.forOrigin('https://example.com/login')).toMatchObject([
      { username: 'me', password: 'hunter2hunter2' },
    ])
  })

  it('PSY-C35 never puts gateway devices, certificates or sign-in tokens in the bundle', async () => {
    const target = temp()
    const a = machine(target)
    writeFileSync(join(a.userData, 'gateway-devices.json'), JSON.stringify({ d: 'device-token-1' }))
    writeFileSync(join(a.userData, 'gateway-cert.pem'), 'CERT-MATERIAL')
    a.vault.data.set('K', entry('vault-value'))
    await setUp(a)
    const entries = await bundleEntries(target, PASSWORD)
    const text = [...entries].join('\n')
    expect(text).not.toContain('device-token-1')
    expect(text).not.toContain('CERT-MATERIAL')
    for (const key of entries.keys()) {
      expect(['vault', 'extensions', 'assistant', 'mcp', 'logins']).toContain(key.split('\0')[0])
    }
  })

  it('PSY-C36 shows no secret value, entry name or key in the target', async () => {
    const target = temp()
    const a = machine(target)
    a.vault.data.set('MY_SECRET_NAME', entry(FAKE.githubClassic))
    a.extensions.data.set('["trellis","api-token"]', entry('ext-secret-value'))
    await setUp(a)
    const everything = filesUnder(target)
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n')
    expect(existsSync(join(target, SECRETS_FILE))).toBe(true)
    for (const word of [FAKE.githubClassic, 'MY_SECRET_NAME', 'api-token', 'ext-secret-value']) {
      expect(everything).not.toContain(word)
    }
  })

  it('PSY-C37 changes nothing when the bundle is damaged or of an unknown format', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    await setUp(a)
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    const path = join(target, SECRETS_FILE)
    const good = readFileSync(path, 'utf8')
    const bundle = JSON.parse(good)
    const data = Buffer.from(bundle.data, 'base64')
    data[0] ^= 1
    writeFileSync(path, JSON.stringify({ ...bundle, data: data.toString('base64') }))
    const damaged = await b.sync.run()
    expect(b.vault.data.size).toBe(0)
    expect(damaged.status.secrets.state).toBe('damaged')
    writeFileSync(path, JSON.stringify({ ...bundle, header: { ...bundle.header, format: 9 } }))
    const unknown = await b.sync.run()
    expect(b.vault.data.size).toBe(0)
    expect(unknown.status.secrets.state).toBe('damaged')
  })

  it('PSY-C38 needs the new password on other machines after a change', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    await setUp(a)
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    await b.sync.run()
    expect((await a.secrets.changePassword(NEW_PASSWORD, NEW_PASSWORD)).ok).toBe(true)
    await a.sync.run()
    const res = await b.sync.run()
    expect(res.status.secrets.state).toBe('locked')
    expect(await b.secrets.unlock(PASSWORD)).toEqual({ ok: false, error: 'wrong-password' })
    expect((await b.secrets.unlock(NEW_PASSWORD)).ok).toBe(true)
  })

  it('PSY-C39 does not ask again after a restart', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    await setUp(a)
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    await b.sync.run()
    a.vault.data.set('K', entry('vault-value'))
    await a.sync.run()
    const again = b.restart()
    const res = await again.sync.run()
    expect(res.status.secrets.state).toBe('unlocked')
    expect(again.vault.data.get('K')?.value).toBe('vault-value')
  })

  it('PSY-C40 syncs the profile but no secret before the machine unlocks', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    writeFileSync(join(a.userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'x' } }))
    await setUp(a)
    await a.sync.run()
    b.vault.data.set('B_ONLY', entry('b-value'))
    await b.secrets.enable()
    const res = await b.sync.run()
    expect(res.status.secrets.state).toBe('locked')
    expect(b.vault.data.has('K')).toBe(false)
    expect(JSON.parse(readFileSync(join(b.userData, 'settings.json'), 'utf8'))).toEqual({
      appearance: { theme: 'x' },
    })
    expect([...(await bundleEntries(target, PASSWORD)).keys()].join()).not.toContain('B_ONLY')
  })

  it('PSY-C41 never writes the master password anywhere', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    await setUp(a)
    await b.secrets.unlock(PASSWORD)
    await b.sync.run()
    await a.secrets.changePassword(NEW_PASSWORD, NEW_PASSWORD)
    await a.sync.run()
    const files = [...filesUnder(a.userData), ...filesUnder(b.userData), ...filesUnder(target)]
    expect(files.length).toBeGreaterThan(0)
    for (const path of files) {
      const text = readFileSync(path, 'utf8')
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain(NEW_PASSWORD)
      expect(text).not.toContain(Buffer.from(PASSWORD).toString('base64'))
    }
  })

  it('PSY-C42 shows a recovery key once, and both it and the password unlock elsewhere', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    const c = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    const recoveryKey = await setUp(a)
    expect(recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$/)
    const status = JSON.stringify(a.sync.status())
    expect(status).not.toContain(recoveryKey)
    expect(filesUnder(a.userData).some((p) => readFileSync(p, 'utf8').includes(recoveryKey))).toBe(
      false,
    )
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    await b.sync.run()
    expect(b.vault.data.get('K')?.value).toBe('vault-value')
    expect((await c.secrets.recover(recoveryKey, NEW_PASSWORD, NEW_PASSWORD)).ok).toBe(true)
    await c.sync.run()
    expect(c.vault.data.get('K')?.value).toBe('vault-value')
  })

  it('PSY-C43 refuses a short or mistyped password and pushes nothing', async () => {
    const target = temp()
    const a = machine(target)
    expect(await a.secrets.setup('short', 'short')).toEqual({ ok: false, error: 'too-short' })
    expect(await a.secrets.setup(PASSWORD, `${PASSWORD}x`)).toEqual({
      ok: false,
      error: 'mismatch',
    })
    await a.sync.run()
    expect(existsSync(join(target, SECRETS_FILE))).toBe(false)
  })

  it('PSY-C44 sets a new password with the recovery key and retires the old one', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    const recoveryKey = await setUp(a)
    expect(await b.secrets.recover('AAAA-AAAA', NEW_PASSWORD, NEW_PASSWORD)).toEqual({
      ok: false,
      error: 'wrong-recovery-key',
    })
    expect(
      (await b.secrets.recover(recoveryKey.toLowerCase(), NEW_PASSWORD, NEW_PASSWORD)).ok,
    ).toBe(true)
    await b.sync.run()
    expect(b.vault.data.get('K')?.value).toBe('vault-value')
    const c = machine(target)
    expect(await c.secrets.unlock(PASSWORD)).toEqual({ ok: false, error: 'wrong-password' })
    expect((await c.secrets.unlock(NEW_PASSWORD)).ok).toBe(true)
  })

  it('PSY-C45 carries secrets added on different machines to both', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    await setUp(a)
    await b.secrets.unlock(PASSWORD)
    await b.sync.run()
    a.vault.data.set('FROM_A', entry('a-value', 5))
    b.extensions.data.set('["trellis","token"]', entry('b-value', 6))
    await a.sync.run()
    await b.sync.run()
    await a.sync.run()
    expect(a.extensions.data.get('["trellis","token"]')?.value).toBe('b-value')
    expect(b.vault.data.get('FROM_A')?.value).toBe('a-value')
  })

  it('PSY-C46 keeps the newest login and lists it without the password', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.logins.save({ origin: 'https://example.com', username: 'me', password: 'first-password' })
    await setUp(a)
    await a.secrets.setLogins(true)
    await a.sync.run()
    await b.secrets.unlock(PASSWORD)
    await b.secrets.setLogins(true)
    await b.sync.run()
    a.clock.ms += 1000
    a.logins.save({ origin: 'https://example.com', username: 'me', password: 'from-a-pass' })
    b.clock.ms += 2000
    b.logins.save({ origin: 'https://example.com', username: 'me', password: 'from-b-pass' })
    await a.sync.run()
    const res = await b.sync.run()
    await a.sync.run()
    expect(a.logins.forOrigin('https://example.com')[0]?.password).toBe('from-b-pass')
    expect(b.logins.forOrigin('https://example.com')[0]?.password).toBe('from-b-pass')
    const listed = res.status.conflicts.filter((c) => c.kind === 'secret')
    expect(listed).toEqual([
      expect.objectContaining({ key: 'https://example.com (me)', local: null, remote: null }),
    ])
    expect(JSON.stringify(res.status)).not.toMatch(/from-a-pass|from-b-pass|first-password/)
  })

  it('PSY-C47 converges without duplicates after a run stopped halfway', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    await setUp(a)
    await b.secrets.unlock(PASSWORD)
    await b.sync.run()
    a.vault.data.set('K', entry('vault-value', 5))
    await a.sync.run()
    b.vault.failNextWrite = true
    await expect(b.sync.run()).rejects.toThrow('disk full')
    await b.sync.run()
    await a.sync.run()
    expect([...b.vault.data.keys()]).toEqual(['K'])
    expect([...a.vault.data.keys()]).toEqual(['K'])
    expect([...(await bundleEntries(target, PASSWORD)).keys()]).toEqual(['vault\0K'])
  })

  it('PSY-C48 decrypts and changes nothing on a wrong password, and can be retried', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    await setUp(a)
    await b.secrets.enable()
    expect(await b.secrets.unlock('not the password')).toEqual({
      ok: false,
      error: 'wrong-password',
    })
    const res = await b.sync.run()
    expect(res.status.secrets.state).toBe('locked')
    expect(b.vault.data.size).toBe(0)
    expect((await b.secrets.unlock(PASSWORD)).ok).toBe(true)
    await b.sync.run()
    expect(b.vault.data.get('K')?.value).toBe('vault-value')
  })

  it('PSY-C49 keeps local secrets and the synced bundle when turned off', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('K', entry('vault-value'))
    await setUp(a)
    await b.secrets.unlock(PASSWORD)
    await b.sync.run()
    await b.secrets.disable()
    const res = await b.sync.run()
    expect(res.status.secrets.state).toBe('off')
    expect(b.vault.data.get('K')?.value).toBe('vault-value')
    expect(existsSync(join(target, SECRETS_FILE))).toBe(true)
    expect((await bundleEntries(target, PASSWORD)).get('vault\0K')).toBe('vault-value')
  })

  it('PSY-C50 replaces the bundle with this machine’s secrets on reset', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.vault.data.set('FROM_A', entry('a-value'))
    await setUp(a)
    await b.secrets.unlock(PASSWORD)
    await b.sync.run()
    b.vault.data.delete('FROM_A')
    b.vault.data.set('FROM_B', entry('b-value'))
    const reset = await b.secrets.reset(NEW_PASSWORD, NEW_PASSWORD)
    expect(reset.ok).toBe(true)
    await b.sync.run()
    expect([...(await bundleEntries(target, NEW_PASSWORD)).keys()]).toEqual(['vault\0FROM_B'])
    const res = await a.sync.run()
    expect(res.status.secrets.state).toBe('locked')
    expect((await a.secrets.unlock(NEW_PASSWORD)).ok).toBe(true)
    await a.sync.run()
    expect(a.vault.data.get('FROM_B')?.value).toBe('b-value')
  })

  it('PSY-C51 reveals both values of one conflict only when asked', async () => {
    const { b, id } = await loginClash()
    expect(id).not.toBe('')
    expect(await b.secrets.reveal(id)).toEqual({
      ok: true,
      local: 'from-b-pass',
      remote: 'from-a-pass',
      winner: 'local',
    })
    expect(JSON.stringify(b.sync.status())).not.toMatch(/from-a-pass|from-b-pass/)
  })

  it('PSY-C52 applies and pushes the other secret when the human picks it', async () => {
    const { a, b, id } = await loginClash()
    b.clock.ms += 1000
    const status = await b.sync.resolve(id)
    expect(b.logins.forOrigin('https://example.com')[0]?.password).toBe('from-a-pass')
    expect(status.conflicts.filter((c) => c.kind === 'secret')).toEqual([])
    await a.sync.run()
    expect(a.logins.forOrigin('https://example.com')[0]?.password).toBe('from-a-pass')
  })

  it('PSY-C53 keeps the losing secret only encrypted, and reveals it after a restart', async () => {
    const { target, b, id } = await loginClash()
    for (const path of [...filesUnder(b.userData), ...filesUnder(target)]) {
      expect(readFileSync(path, 'utf8')).not.toContain('from-a-pass')
    }
    const again = b.restart()
    expect(await again.secrets.reveal(id)).toMatchObject({ ok: true, remote: 'from-a-pass' })
  })

  it('PSY-C54 returns and changes nothing for an unknown or resolved conflict', async () => {
    const { b, id } = await loginClash()
    expect(await b.secrets.reveal('secret:vault\0NOPE')).toEqual({ ok: false })
    await b.sync.resolve('secret:vault\0NOPE')
    expect(b.logins.forOrigin('https://example.com')[0]?.password).toBe('from-b-pass')
    await b.sync.resolve(id)
    expect(await b.secrets.reveal(id)).toEqual({ ok: false })
    await b.sync.resolve(id)
    expect(b.logins.forOrigin('https://example.com')[0]?.password).toBe('from-a-pass')
  })
})

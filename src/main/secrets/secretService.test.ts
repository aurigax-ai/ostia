import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ApprovalOutcome } from '../../shared/approvals'
import { SecretService } from './secretService'

const home = mkdtempSync(join(tmpdir(), 'pine-secrets-home-'))
mkdirSync(join(home, '.ssh'))
writeFileSync(join(home, '.ssh', 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\nKEYDATA\n')
writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'ssh-ed25519 AAAA')
writeFileSync(join(home, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA')

afterAll(() => rmSync(home, { recursive: true, force: true }))

function setup(opts: { outcome?: ApprovalOutcome; granted?: string[] } = {}) {
  const asks: { name: string; reason: string }[] = []
  const service = new SecretService({
    home: () => home,
    env: () => ({ GITHUB_TOKEN: 'ghp_real', PATH: '/usr/bin', DB_PASSWORD: 'hunter2' }),
    ghToken: () => null,
    vault: {
      list: () => [{ key: 'API_KEY', scope: 'global' as const }],
      get: (key) => (key === 'API_KEY' ? 'vault-value' : null),
    },
    logins: () => [{ id: 'c1', origin: 'https://app.example.com', username: 'me' }],
    grantedIds: () => opts.granted ?? [],
    ask: async ({ name, reason }) => {
      asks.push({ name, reason })
      return opts.outcome ?? 'once'
    },
  })
  return { service, asks }
}

describe('SecretService', () => {
  it('SBX-C67 lists host SSH keys and token-like env vars as Host, and the vault as Pine', () => {
    const { service } = setup()
    const list = service.list('ws')
    expect(list).toContainEqual(
      expect.objectContaining({ name: 'id_ed25519', source: 'host', kind: 'ssh-key' }),
    )
    expect(list).toContainEqual(expect.objectContaining({ name: 'GITHUB_TOKEN', source: 'host' }))
    expect(list).toContainEqual(expect.objectContaining({ name: 'DB_PASSWORD', source: 'host' }))
    expect(list).toContainEqual(expect.objectContaining({ name: 'API_KEY', source: 'pine' }))
    expect(list.map((s) => s.name)).not.toContain('PATH')
    expect(list.map((s) => s.name)).not.toContain('id_ed25519.pub')
    expect(list.map((s) => s.name)).not.toContain('known_hosts')
  })

  it('SBX-C68 marks host secrets read-only so nothing offers to edit or delete them', () => {
    const { service } = setup()
    for (const secret of service.list('ws')) {
      expect(secret.editable).toBe(secret.source === 'pine')
    }
  })

  it('SBX-C74 hands over a value once after the human allows it, and asks again next time', async () => {
    const { service, asks } = setup({ outcome: 'once' })
    await expect(service.get('ws', 'pane', 'DB_PASSWORD', 'run migrations')).resolves.toEqual({
      ok: true,
      value: 'hunter2',
    })
    await service.get('ws', 'pane', 'DB_PASSWORD', 'again')
    expect(asks.map((a) => a.reason)).toEqual(['run migrations', 'again'])
  })

  it('SBX-C75 lists names and labels only, never a value', () => {
    const { service } = setup()
    const text = JSON.stringify(service.list('ws'))
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('ghp_real')
    expect(text).not.toContain('KEYDATA')
    expect(text).not.toContain('vault-value')
  })

  it('SBX-C76 returns no value when the human denies or the card times out', async () => {
    for (const outcome of ['deny', 'timeout'] as const) {
      const { service } = setup({ outcome })
      const res = await service.get('ws', 'pane', 'DB_PASSWORD', '')
      expect(res).toEqual({ ok: false, error: 'denied' })
      expect(JSON.stringify(res)).not.toContain('hunter2')
    }
  })

  it('SBX-C77 fails for an unknown name without asking', async () => {
    const { service, asks } = setup()
    await expect(service.get('ws', 'pane', 'NOPE', '')).resolves.toEqual({
      ok: false,
      error: 'unknown-secret',
    })
    expect(asks).toEqual([])
  })

  it('SBX-C93 refuses to hand over a browser login as a value', async () => {
    const { service, asks } = setup()
    const login = service.list('ws').find((s) => s.source === 'browser')
    expect(login).toBeDefined()
    await expect(service.get('ws', 'pane', login?.name ?? '', '')).resolves.toEqual({
      ok: false,
      error: 'browser-secret',
    })
    expect(service.canInject(login?.id ?? '')).toBe(false)
    expect(asks).toEqual([])
  })

  it('SBX-C94 lists a browser login by origin and username only', () => {
    const { service } = setup()
    const login = service.list('ws').find((s) => s.source === 'browser')
    expect(login).toEqual({
      id: 'browser:c1',
      name: 'me@https://app.example.com',
      source: 'browser',
      kind: 'login',
      editable: false,
    })
  })
})

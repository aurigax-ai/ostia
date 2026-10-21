import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { syncProfileFromDefault } from './accountSync'

let base: string
let home: string
let defaultHome: string
let profile: string

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ostia-account-sync-'))
  home = join(base, 'home')
  defaultHome = join(home, '.claude')
  profile = join(base, 'profile')
  mkdirSync(defaultHome, { recursive: true })
  mkdirSync(profile)
  vi.stubEnv('HOME', home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(base, { recursive: true, force: true })
})

describe('syncProfileFromDefault', () => {
  it('copies the default settings.json as a real file, only one way', async () => {
    writeFileSync(join(defaultHome, 'settings.json'), '{"theme":"dark"}')
    await syncProfileFromDefault(profile, defaultHome)
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(statSync(join(profile, 'settings.json')).mode & 0o777).toBe(0o600)
    writeFileSync(join(profile, 'settings.json'), '{"theme":"light"}')
    await syncProfileFromDefault(profile, defaultHome)
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(readFileSync(join(defaultHome, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('follows a settings.json that a dotfile manager made a link, and keeps the copy current', async () => {
    const managed = join(base, 'dotfiles')
    mkdirSync(managed)
    writeFileSync(join(managed, 'settings.json'), '{"theme":"dark"}')
    symlinkSync(join(managed, 'settings.json'), join(defaultHome, 'settings.json'))
    writeFileSync(join(profile, 'settings.json'), '{"theme":"old"}')
    await syncProfileFromDefault(profile, defaultHome)
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('keeps the profile’s copy when the default cannot be read for another reason than being absent', async () => {
    symlinkSync(join(defaultHome, 'settings.json'), join(defaultHome, 'settings.json'))
    writeFileSync(join(profile, 'settings.json'), '{"theme":"kept"}')
    await syncProfileFromDefault(profile, defaultHome)
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('{"theme":"kept"}')
  })

  it('removes the profile’s copy when the default has no settings.json', async () => {
    writeFileSync(join(profile, 'settings.json'), '{}')
    await syncProfileFromDefault(profile, defaultHome)
    expect(() => statSync(join(profile, 'settings.json'))).toThrow()
  })

  it('copies the user-scope MCP servers into the profile’s config and keeps the rest of it', async () => {
    const servers = { docs: { command: 'docs-mcp', args: ['--x'] } }
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: servers, other: 1 }))
    writeFileSync(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'w@example.com' }, projects: { '/p': {} } }),
    )
    await syncProfileFromDefault(profile, defaultHome)
    expect(readJson(join(profile, '.claude.json'))).toEqual({
      oauthAccount: { emailAddress: 'w@example.com' },
      projects: { '/p': {} },
      mcpServers: servers,
    })
    expect(readJson(join(home, '.claude.json')).other).toBe(1)
  })

  it('drops the profile’s servers when the default has none', async () => {
    writeFileSync(join(home, '.claude.json'), '{}')
    writeFileSync(
      join(profile, '.claude.json'),
      JSON.stringify({ mcpServers: { old: {} }, keep: 1 }),
    )
    await syncProfileFromDefault(profile, defaultHome)
    expect(readJson(join(profile, '.claude.json'))).toEqual({ keep: 1 })
  })

  it('never creates the profile’s config before its first login', async () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: {} } }))
    await syncProfileFromDefault(profile, defaultHome)
    expect(() => statSync(join(profile, '.claude.json'))).toThrow()
  })

  it('leaves the profile’s servers alone when the default config cannot be read', async () => {
    writeFileSync(join(home, '.claude.json'), '{')
    writeFileSync(join(profile, '.claude.json'), '{"a":1,"mcpServers":{"x":{}}}')
    await expect(syncProfileFromDefault(profile, defaultHome)).resolves.toBeUndefined()
    expect(readJson(join(profile, '.claude.json'))).toEqual({ a: 1, mcpServers: { x: {} } })
  })
})

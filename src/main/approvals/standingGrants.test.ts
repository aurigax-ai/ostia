import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'ostia-standing-grants-'))
const settingsFile = join(userData, 'settings.json')

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

const store = await import('./capabilityStore')

function saved(): { capabilities?: { grants?: string[] }; locale?: string } {
  return JSON.parse(readFileSync(settingsFile, 'utf8'))
}

describe('standing grants', () => {
  it('always allow writes the grant, keeps other settings and reaches every pane at once', () => {
    writeFileSync(settingsFile, JSON.stringify({ locale: 'en' }))
    store.initCaps('pane-a')
    store.setCaps('ext-a', ['read-board'])

    expect(store.addStandingGrants(['send-other-pane'])).toBe(true)

    expect(saved()).toEqual({ locale: 'en', capabilities: { grants: ['send-other-pane'] } })
    expect(store.hasCap('pane-a', 'send-other-pane')).toBe(true)
    store.initCaps('pane-b')
    expect(store.hasCap('pane-b', 'send-other-pane')).toBe(true)
    expect(store.hasCap('ext-a', 'send-other-pane')).toBe(false)
  })

  it('refuses to save a grant for a capability that always asks', () => {
    writeFileSync(settingsFile, JSON.stringify({ capabilities: { grants: [] } }))
    store.refreshCapabilitySettings()

    expect(store.addStandingGrants(['shell', 'destructive'])).toBe(false)
    expect(store.addStandingGrants(['credentials'])).toBe(false)

    expect(saved().capabilities?.grants).toEqual([])
    store.initCaps('pane-c')
    expect(store.hasCap('pane-c', 'shell')).toBe(false)
  })

  it('remove revokes the grant from every pane at once', () => {
    writeFileSync(settingsFile, JSON.stringify({}))
    store.refreshCapabilitySettings()
    store.initCaps('pane-d')
    store.addStandingGrants(['send-other-pane', 'browse'])
    expect(store.hasCap('pane-d', 'browse')).toBe(true)

    expect(store.removeStandingGrant('browse')).toBe(true)

    expect(saved().capabilities?.grants).toEqual(['send-other-pane'])
    expect(store.hasCap('pane-d', 'browse')).toBe(false)
    expect(store.hasCap('pane-d', 'send-other-pane')).toBe(true)
    expect(store.hasCap('pane-d', 'drive-self')).toBe(true)
  })

  it('applies a hand edit of settings.json without a restart', () => {
    writeFileSync(settingsFile, JSON.stringify({}))
    store.refreshCapabilitySettings()
    store.initCaps('pane-e')

    writeFileSync(settingsFile, JSON.stringify({ capabilities: { grants: ['kill-pane'] } }))
    store.refreshCapabilitySettings()

    expect(store.hasCap('pane-e', 'kill-pane')).toBe(true)
  })

  it('reads the agent reach from settings.json, defaulting to project, and applies a hand edit', () => {
    writeFileSync(settingsFile, JSON.stringify({}))
    store.refreshCapabilitySettings()
    expect(store.loadReachMode()).toBe('project')

    writeFileSync(settingsFile, JSON.stringify({ capabilities: { reach: 'group' } }))
    store.refreshCapabilitySettings()
    expect(store.loadReachMode()).toBe('group')

    writeFileSync(settingsFile, JSON.stringify({ capabilities: { reach: 'everything' } }))
    store.refreshCapabilitySettings()
    expect(store.loadReachMode()).toBe('project')
  })

  it('writes the agent reach Settings picks, keeps the grants, and refuses an unknown mode', () => {
    writeFileSync(settingsFile, JSON.stringify({ capabilities: { grants: ['browse'] } }))
    store.refreshCapabilitySettings()

    expect(store.setReachMode('workspace')).toBe(true)
    expect(saved().capabilities).toEqual({ grants: ['browse'], reach: 'workspace' })
    expect(store.loadReachMode()).toBe('workspace')

    expect(store.setReachMode('everything')).toBe(false)
    expect(saved().capabilities).toEqual({ grants: ['browse'], reach: 'workspace' })
  })

  it('never overwrites a settings.json it cannot parse', () => {
    writeFileSync(settingsFile, '{ broken')

    expect(store.addStandingGrants(['browse'])).toBe(false)
    expect(readFileSync(settingsFile, 'utf8')).toBe('{ broken')
  })

  it('is reached only from the approval card and Settings, never a socket method', () => {
    const root = join(__dirname, '..', '..')
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join(root, f))
    const callers = sources
      .filter((f) =>
        /addStandingGrants|removeStandingGrant|setReachMode/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => relative(root, f))
      .sort()
    expect(callers).toEqual(['main/approvals/approvals.ts', 'main/approvals/capabilityStore.ts'])
    const approvals = readFileSync(join(root, 'main/approvals/approvals.ts'), 'utf8')
    expect(approvals).not.toMatch(/registerControlMethod|registerTargetableMethod/)
  })
})

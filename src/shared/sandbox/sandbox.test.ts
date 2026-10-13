import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SANDBOX_GLOBALS,
  DEFAULT_SWITCHES,
  emptyWorkspaceSandbox,
  parseSandboxGlobals,
  parseSwitches,
  parseWorkspaceSandbox,
  resolveSandbox,
  sameWorkspaceSandbox,
} from './sandbox'

describe('parseWorkspaceSandbox', () => {
  it('keeps the filesystem, domain and socket lists and the switch overrides it was given', () => {
    const parsed = parseWorkspaceSandbox({
      enabled: true,
      allowRead: ['~/notes'],
      allowWrite: ['~/builds'],
      denyRead: ['~/notes/private'],
      denyWrite: ['~/builds/release'],
      domains: ['example.com'],
      deniedDomains: ['telemetry.example.com'],
      allowSockets: ['/var/run/tool.sock'],
      switches: { unixSockets: false },
    })
    expect(parsed).toEqual({
      enabled: true,
      allowRead: ['~/notes'],
      allowWrite: ['~/builds'],
      denyRead: ['~/notes/private'],
      denyWrite: ['~/builds/release'],
      domains: ['example.com'],
      deniedDomains: ['telemetry.example.com'],
      allowSockets: ['/var/run/tool.sock'],
      controls: {},
      switches: { unixSockets: false },
    })
  })

  it('leaves out empty lists and switches, so an untouched workspace equals an empty one', () => {
    const parsed = parseWorkspaceSandbox({
      enabled: false,
      allowWrite: [],
      denyRead: [],
      switches: {},
    })
    expect(parsed).toEqual(emptyWorkspaceSandbox())
    expect(parsed && sameWorkspaceSandbox(parsed, emptyWorkspaceSandbox())).toBe(true)
  })

  it('refuses a list that is not strings or a switch that is not a boolean', () => {
    expect(parseWorkspaceSandbox({ enabled: true, allowWrite: [1] })).toBeNull()
    expect(parseWorkspaceSandbox({ enabled: true, denyRead: 'x' })).toBeNull()
    expect(parseWorkspaceSandbox({ enabled: true, switches: { unixSockets: 'no' } })).toBeNull()
  })
})

describe('parseSwitches', () => {
  it('keeps only the known switches and drops anything else', () => {
    expect(parseSwitches({ gitConfig: true, turnOffSandbox: true })).toEqual({ gitConfig: true })
    expect(parseSwitches(undefined)).toEqual({})
    expect(parseSwitches([])).toBeNull()
    expect(parseSwitches({ strictDomains: 1 })).toBeNull()
  })
})

describe('parseSandboxGlobals', () => {
  it('starts with no extra limits: sockets allowed, git config protected, unlisted domains asked', () => {
    const globals = parseSandboxGlobals({})
    expect(globals.switches).toEqual(DEFAULT_SWITCHES)
    expect(globals.allowWrite).toEqual([])
    expect(globals.denyRead).toEqual([])
    expect(globals.denyWrite).toEqual([])
    expect(globals.deniedDomains).toEqual([])
    expect(globals.allowSockets).toEqual([])
  })

  it('falls back to the default for a switch of the wrong type instead of dropping the rest', () => {
    const globals = parseSandboxGlobals({ switches: { unixSockets: 'off' }, allowWrite: ['~/out'] })
    expect(globals.switches).toEqual(DEFAULT_SWITCHES)
    expect(globals.allowWrite).toEqual(['~/out'])
  })
})

describe('resolveSandbox', () => {
  it('adds the workspace lists to the global ones and lets a workspace switch override the global', () => {
    const globals = parseSandboxGlobals({
      allowWrite: ['~/shared-out'],
      denyRead: ['~/.cargo/credentials.toml'],
      deniedDomains: ['telemetry.example.com'],
      switches: { unixSockets: false, strictDomains: true },
    })
    const resolved = resolveSandbox(globals, {
      ...emptyWorkspaceSandbox(),
      allowWrite: ['~/builds'],
      denyRead: ['~/notes/private'],
      denyWrite: ['~/builds/release'],
      deniedDomains: ['ads.example.com'],
      switches: { unixSockets: true },
    })
    expect(resolved.allowWrite).toEqual(['~/shared-out', '~/builds'])
    expect(resolved.denyRead).toEqual(['~/.cargo/credentials.toml', '~/notes/private'])
    expect(resolved.denyWrite).toEqual(['~/builds/release'])
    expect(resolved.deniedDomains).toEqual(['telemetry.example.com', 'ads.example.com'])
    expect(resolved.switches).toEqual({ unixSockets: true, gitConfig: false, strictDomains: true })
  })

  it('resolves globals written before these settings existed', () => {
    const resolved = resolveSandbox(DEFAULT_SANDBOX_GLOBALS, emptyWorkspaceSandbox())
    expect(resolved.switches).toEqual(DEFAULT_SWITCHES)
    expect(resolved.allowWrite).toEqual([])
    expect(resolved.allowSockets).toEqual([])
  })
})

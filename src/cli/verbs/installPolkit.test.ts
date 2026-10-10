import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POLKIT_POLICY_FILE } from '../../shared/permissions/scriptTokens'
import { cliResources, runInstallPolkit } from './installPolkit'

describe('ostia install-polkit', () => {
  let root = ''
  let resources = ''
  let actionsDir = ''
  let out: string[] = []
  let err: string[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'install-polkit-'))
    resources = join(root, 'resources')
    actionsDir = join(root, 'usr', 'share', 'polkit-1', 'actions')
    mkdirSync(join(resources, 'polkit'), { recursive: true })
    writeFileSync(join(resources, 'polkit', POLKIT_POLICY_FILE), '<policyconfig/>')
    out = []
    err = []
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function run(argv: string[] = [], over: { uid?: number; platform?: NodeJS.Platform } = {}) {
    return runInstallPolkit(argv, {
      platform: over.platform ?? 'linux',
      uid: 'uid' in over ? over.uid : 0,
      resources,
      actionsDir,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    })
  }

  it('copies the bundled action where polkit reads it, readable by everyone', () => {
    expect(run()).toBe(0)
    const dest = join(actionsDir, POLKIT_POLICY_FILE)
    expect(readFileSync(dest, 'utf8')).toBe('<policyconfig/>')
    expect(statSync(dest).mode & 0o777).toBe(0o644)
    expect(out[0]).toContain(`installed ${dest}`)
  })

  it('needs root and writes nothing without it', () => {
    expect(run([], { uid: 1000 })).toBe(1)
    expect(err[0]).toContain('sudo ostia install-polkit')
    expect(() => statSync(actionsDir)).toThrow()
  })

  it('is for Linux only', () => {
    expect(run([], { platform: 'darwin' })).toBe(1)
    expect(err[0]).toContain('Touch ID')
  })

  it('says so when the bundled action is missing', () => {
    rmSync(join(resources, 'polkit'), { recursive: true })
    expect(run()).toBe(1)
    expect(err[0]).toContain('reinstall Ostia')
  })

  it('takes no arguments', () => {
    expect(run(['--force'])).toBe(2)
    expect(run(['--help'])).toBe(0)
    expect(err).toEqual(['usage: sudo ostia install-polkit', 'usage: sudo ostia install-polkit'])
  })

  it('finds the resources folder from the CLI inside the app archive', () => {
    expect(cliResources('/opt/Ostia/resources/app.asar/out/cli')).toBe('/opt/Ostia/resources')
  })
})

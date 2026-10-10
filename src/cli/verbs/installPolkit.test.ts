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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POLKIT_POLICY_FILE } from '../../shared/permissions/scriptTokens'
import { POLKIT_POLICY, runInstallPolkit } from './installPolkit'

describe('ostia install-polkit', () => {
  let root = ''
  let actionsDir = ''
  let dest = ''
  let out: string[] = []
  let err: string[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'install-polkit-'))
    actionsDir = join(root, 'usr', 'share', 'polkit-1', 'actions')
    dest = join(actionsDir, POLKIT_POLICY_FILE)
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
      actionsDir,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    })
  }

  it('writes the policy built into the CLI where polkit reads it, readable by everyone', () => {
    expect(run()).toBe(0)
    expect(readFileSync(dest, 'utf8')).toBe(POLKIT_POLICY)
    expect(statSync(dest).mode & 0o777).toBe(0o644)
    expect(out[0]).toContain(`installed ${dest}`)
  })

  it('replaces an older copy in place', () => {
    mkdirSync(actionsDir, { recursive: true })
    writeFileSync(dest, 'old and longer than the new one'.repeat(200))
    expect(run()).toBe(0)
    expect(readFileSync(dest, 'utf8')).toBe(POLKIT_POLICY)
  })

  it('refuses a target that is a symbolic link, and leaves what it points to alone', () => {
    mkdirSync(actionsDir, { recursive: true })
    const victim = join(root, 'victim')
    writeFileSync(victim, 'keep me')
    symlinkSync(victim, dest)
    expect(run()).toBe(1)
    expect(err[0]).toContain(`refused to write ${dest}`)
    expect(readFileSync(victim, 'utf8')).toBe('keep me')
  })

  it('refuses an actions folder that is a symbolic link', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    mkdirSync(join(actionsDir, '..'), { recursive: true })
    symlinkSync(elsewhere, actionsDir)
    expect(run()).toBe(1)
    expect(() => statSync(join(elsewhere, POLKIT_POLICY_FILE))).toThrow()
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

  it('takes no arguments', () => {
    expect(run(['--force'])).toBe(2)
    expect(run(['--help'])).toBe(0)
    expect(err).toEqual(['usage: sudo ostia install-polkit', 'usage: sudo ostia install-polkit'])
  })
})

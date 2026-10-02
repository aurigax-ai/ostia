import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkSandboxPath, checkSandboxPaths } from './pathChecks'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-pathchecks-')))
const home = join(root, 'home')
const dataDir = join(home, '.local/share/pine')
const runtimeDir = join(root, 'run')
const agentDir = join(runtimeDir, 'keyring')
const workDir = join(home, 'proj')
for (const dir of [
  join(home, 'notes'),
  join(home, 'builds'),
  join(home, '.claude/hooks'),
  join(workDir, '.git'),
  dataDir,
  agentDir,
]) {
  mkdirSync(dir, { recursive: true })
}
writeFileSync(join(home, '.claude/settings.json'), '{}')
writeFileSync(join(workDir, '.git/config'), '')
writeFileSync(join(home, 'weird[1].txt'), '')
symlinkSync(dataDir, join(home, 'data-link'))
symlinkSync(agentDir, join(home, 'agent-link'))

afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = {
  home,
  dataDirs: [dataDir],
  protectedDirs: [runtimeDir, agentDir],
  protectedFiles: [
    join(home, '.claude/settings.json'),
    join(home, '.claude/hooks'),
    join(workDir, '.git/config'),
  ],
}

describe('checkSandboxPath', () => {
  it('SBX-C26 refuses /, the home dir, the data dir, relative and missing paths with a reason', () => {
    expect(checkSandboxPath('allowRead', '/', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('allowRead', '~', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('allowRead', `${home}/`, env)).toEqual({
      ok: false,
      reason: 'too-broad',
    })
    expect(checkSandboxPath('allowRead', dataDir, env)).toEqual({ ok: false, reason: 'pine-data' })
    expect(checkSandboxPath('allowRead', join(dataDir, 'vault.json'), env)).toEqual({
      ok: false,
      reason: 'pine-data',
    })
    expect(checkSandboxPath('allowRead', 'notes', env)).toEqual({
      ok: false,
      reason: 'not-absolute',
    })
    expect(checkSandboxPath('allowRead', '~/missing', env)).toEqual({
      ok: false,
      reason: 'missing',
    })
    expect(checkSandboxPath('allowRead', '~/notes', env)).toEqual({ ok: true, path: '~/notes' })
    expect(checkSandboxPath('allowRead', join(home, 'notes'), env)).toEqual({
      ok: true,
      path: join(home, 'notes'),
    })
  })

  it('refuses a folder above the home folder or above the data folder as readable or writable', () => {
    expect(checkSandboxPath('allowRead', root, env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('allowWrite', root, env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('allowWrite', '~/.local/share', env)).toEqual({
      ok: false,
      reason: 'pine-data',
    })
  })

  it('refuses to open the runtime folder, an agent socket folder or anything inside or above them', () => {
    for (const kind of ['allowRead', 'allowWrite', 'allowSockets'] as const) {
      expect(checkSandboxPath(kind, runtimeDir, env)).toEqual({ ok: false, reason: 'protected' })
      expect(checkSandboxPath(kind, agentDir, env)).toEqual({ ok: false, reason: 'protected' })
    }
  })

  it('follows a symlink before deciding, so a link into a closed folder is refused too', () => {
    expect(checkSandboxPath('allowRead', '~/data-link', env)).toEqual({
      ok: false,
      reason: 'pine-data',
    })
    expect(checkSandboxPath('allowWrite', '~/agent-link', env)).toEqual({
      ok: false,
      reason: 'protected',
    })
  })

  it('refuses a writable path that is a protected agent or git file, but accepts an ordinary folder', () => {
    expect(checkSandboxPath('allowWrite', '~/.claude/settings.json', env)).toEqual({
      ok: false,
      reason: 'protected',
    })
    expect(checkSandboxPath('allowWrite', '~/.claude/hooks', env)).toEqual({
      ok: false,
      reason: 'protected',
    })
    expect(checkSandboxPath('allowWrite', join(workDir, '.git/config'), env)).toEqual({
      ok: false,
      reason: 'protected',
    })
    expect(checkSandboxPath('allowWrite', '~/builds/', env)).toEqual({ ok: true, path: '~/builds' })
  })

  it('accepts hiding or write-protecting any existing path except /, since that only narrows access', () => {
    expect(checkSandboxPath('denyRead', '/', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('denyWrite', '/', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkSandboxPath('denyRead', '~/notes', env)).toEqual({ ok: true, path: '~/notes' })
    expect(checkSandboxPath('denyRead', agentDir, env)).toEqual({ ok: true, path: agentDir })
    expect(checkSandboxPath('denyWrite', workDir, env)).toEqual({ ok: true, path: workDir })
    expect(checkSandboxPath('denyRead', '~/nothing-here', env)).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('refuses pattern characters, which the sandbox runtime would read as a glob', () => {
    expect(checkSandboxPath('denyRead', '~/weird[1].txt', env)).toEqual({
      ok: false,
      reason: 'pattern',
    })
    expect(checkSandboxPath('allowWrite', '~/builds/*', env)).toEqual({
      ok: false,
      reason: 'pattern',
    })
  })

  it('refuses a path longer than the cap', () => {
    expect(checkSandboxPath('denyRead', `/${'a'.repeat(1100)}`, env)).toEqual({
      ok: false,
      reason: 'too-long',
    })
  })
})

describe('checkSandboxPaths', () => {
  it('returns every accepted path in order, or every refusal with its value', () => {
    expect(checkSandboxPaths('allowWrite', ['~/builds', '~/notes/'], env)).toEqual({
      ok: true,
      paths: ['~/builds', '~/notes'],
    })
    expect(checkSandboxPaths('allowWrite', ['~/builds', 'rel', runtimeDir], env)).toEqual({
      ok: false,
      errors: [
        { value: 'rel', reason: 'not-absolute' },
        { value: runtimeDir, reason: 'protected' },
      ],
    })
  })
})

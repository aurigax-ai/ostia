import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkSandboxPath } from './pathChecks'
import { availableReadPresets } from './presets'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-presets-')))

afterAll(() => rmSync(root, { recursive: true, force: true }))

function machine(name: string, folders: string[], files: string[] = []) {
  const home = join(root, name, 'home')
  const dataDir = join(home, '.local/share/pine')
  const runtimeDir = join(root, name, 'run')
  for (const dir of [dataDir, runtimeDir, ...folders.map((f) => join(home, f))]) {
    mkdirSync(dir, { recursive: true })
  }
  for (const file of files) writeFileSync(join(home, file), '')
  return { home, dataDirs: [dataDir], protectedDirs: [runtimeDir], protectedFiles: [], runtimeDir }
}

describe('availableReadPresets', () => {
  it('offers nothing on a machine with none of the tools', () => {
    expect(availableReadPresets(machine('bare', []), {})).toEqual([])
  })

  it('offers only the presets whose folder exists, with only the folders that exist', () => {
    const env = machine('some', ['.bun/bin', '.local/share/uv/tools', '.deno/bin', '.nvm'])
    expect(availableReadPresets(env, {})).toEqual([
      { id: 'bun', paths: ['~/.bun'] },
      { id: 'deno', paths: ['~/.deno/bin'] },
      { id: 'uv', paths: ['~/.local/share/uv/tools'] },
      { id: 'nodeVersions', paths: ['~/.nvm'] },
    ])
  })

  it('offers a tool’s own files next to its folders, and never for the files alone', () => {
    const env = machine('asdf', ['.asdf/shims'], ['.tool-versions'])
    expect(availableReadPresets(env, {})).toEqual([
      { id: 'versionManagers', paths: ['~/.asdf', '~/.tool-versions'] },
    ])
    expect(availableReadPresets(machine('stray', [], ['.tool-versions']), {})).toEqual([])
  })

  it('adds GOPATH and GOROOT only when they are inside the home folder', () => {
    const env = machine('go', ['go/bin', 'toolchains/go1.27', 'gopath'])
    const inside = availableReadPresets(env, {
      GOROOT: join(env.home, 'toolchains/go1.27'),
      GOPATH: `${join(env.home, 'gopath')}:/opt/shared-go`,
    })
    expect(inside).toEqual([{ id: 'go', paths: ['~/go', '~/gopath', '~/toolchains/go1.27'] }])
    const outside = availableReadPresets(env, { GOROOT: '/usr/lib/go', GOPATH: '/opt/go' })
    expect(outside).toEqual([{ id: 'go', paths: ['~/go'] }])
  })

  it('never offers the home folder itself or a relative path from the environment', () => {
    const env = machine('broad', ['go'])
    const presets = availableReadPresets(env, { GOROOT: env.home, GOPATH: 'relative/go' })
    expect(presets).toEqual([{ id: 'go', paths: ['~/go'] }])
  })

  it('drops a tool folder that is a link into Pine’s data or a protected folder', () => {
    const env = machine('links', ['.volta'])
    symlinkSync(env.dataDirs[0], join(env.home, '.bun'))
    symlinkSync(env.runtimeDir, join(env.home, '.pyenv'))
    expect(availableReadPresets(env, {})).toEqual([{ id: 'volta', paths: ['~/.volta'] }])
  })

  it('offers only paths the Readable folders list accepts', () => {
    const env = machine('accepted', [
      '.bun',
      '.deno/bin',
      'go',
      '.pyenv',
      '.local/share/uv/python',
      '.local/pipx',
      '.volta',
      '.local/share/fnm',
      '.local/share/pnpm',
      '.sdkman',
      '.local/share/mise',
      '.linuxbrew/bin',
      '.local/share/claude',
    ])
    const presets = availableReadPresets(env, {})
    expect(presets.map((preset) => preset.id)).toEqual([
      'claude',
      'bun',
      'deno',
      'go',
      'pyenv',
      'uv',
      'volta',
      'nodeVersions',
      'pnpm',
      'sdkman',
      'versionManagers',
      'homebrew',
    ])
    for (const path of presets.flatMap((preset) => preset.paths)) {
      expect(checkSandboxPath('allowRead', path, env)).toEqual({ ok: true, path })
    }
  })
})

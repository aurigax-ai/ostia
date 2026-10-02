import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LanguageServerInfo } from '../shared/languageServers'
import { ServerOverrides } from './serverOverrides'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

const { chooseServerProgram } = await import('./languageServersIpc')

let tmp: string
let file: string
let program: string

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pine-lsp-override-')))
  file = join(tmp, 'language-server-programs.json')
  program = join(tmp, 'my-ls')
  writeFileSync(program, '#!/bin/sh\n')
  chmodSync(program, 0o755)
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('ServerOverrides', () => {
  it('keeps an executable file with its arguments, across a restart', () => {
    const overrides = new ServerOverrides(file)
    expect(overrides.choose('ext/ls', { path: program, args: ['--stdio', '--log=1'] })).toBeNull()
    expect(overrides.get('ext/ls')).toEqual({ path: program, args: ['--stdio', '--log=1'] })
    expect(new ServerOverrides(file).get('ext/ls')).toEqual({
      path: program,
      args: ['--stdio', '--log=1'],
    })
    expect(overrides.choose('ext/ls', null)).toBeNull()
    expect(new ServerOverrides(file).get('ext/ls')).toBeUndefined()
  })

  it('accepts a link to an executable file', () => {
    const link = join(tmp, 'linked-ls')
    symlinkSync(program, link)
    const overrides = new ServerOverrides(file)
    expect(overrides.choose('ext/ls', { path: link })).toBeNull()
    expect(overrides.get('ext/ls')).toEqual({ path: link, args: [] })
  })

  it('refuses a relative path, a missing file, a folder, a file that cannot run and a shell string', () => {
    const overrides = new ServerOverrides(file)
    const plain = join(tmp, 'notes.txt')
    writeFileSync(plain, 'x')
    chmodSync(plain, 0o644)
    mkdirSync(join(tmp, 'dir'))
    expect(overrides.choose('ext/ls', { path: 'bin/my-ls' })).toBe('not-absolute')
    expect(overrides.choose('ext/ls', { path: `${program}\nrm` })).toBe('not-absolute')
    expect(overrides.choose('ext/ls', `${program} --stdio`)).toBe('not-absolute')
    expect(overrides.choose('ext/ls', { path: join(tmp, 'absent') })).toBe('missing')
    expect(overrides.choose('ext/ls', { path: join(tmp, 'dir') })).toBe('not-file')
    expect(overrides.choose('ext/ls', { path: plain })).toBe('not-executable')
    expect(overrides.choose('ext/ls', { path: program, args: '--stdio --x' })).toBe('bad-arguments')
    expect(overrides.choose('ext/ls', { path: program, args: ['ok', 7] })).toBe('bad-arguments')
    expect(overrides.choose('ext/ls', { path: program, args: ['a\u0000b'] })).toBe('bad-arguments')
    expect(overrides.choose('not-a-key', { path: program })).toBe('unknown-server')
    expect(overrides.get('ext/ls')).toBeUndefined()
  })

  it('drops entries a hand-edited file has no right to hold', () => {
    writeFileSync(
      file,
      JSON.stringify({
        'ext/ls': { path: program, args: ['--stdio'] },
        'ext/shell': { path: 'sh -c evil', args: [] },
        'ext/args': { path: program, args: '--one --two' },
        nokey: { path: program },
        __proto__: { path: program },
      }),
    )
    const overrides = new ServerOverrides(file)
    expect(overrides.get('ext/ls')).toEqual({ path: program, args: ['--stdio'] })
    expect(overrides.get('ext/shell')).toBeUndefined()
    expect(overrides.get('ext/args')).toBeUndefined()
    expect(overrides.get('nokey')).toBeUndefined()
  })

  it('forgets every program chosen for an extension that was removed', () => {
    const overrides = new ServerOverrides(file)
    overrides.choose('ext/one', { path: program })
    overrides.choose('ext/two', { path: program })
    overrides.choose('other/one', { path: program })
    overrides.forgetExtension('ext')
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['other/one'])
  })
})

describe('chooseServerProgram', () => {
  const listed = [{ key: 'ext/ls' }] as LanguageServerInfo[]

  it('refuses a server that is not listed and never stores it', () => {
    const setOverride = vi.fn(() => null)
    const refresh = vi.fn()
    const servers = { servers: () => listed, refresh }
    expect(
      chooseServerProgram({ servers, setOverride } as never, 'ext/other', { path: program }),
    ).toEqual({ servers: listed, problem: 'unknown-server' })
    expect(chooseServerProgram({ servers, setOverride } as never, 7, null).problem).toBe(
      'unknown-server',
    )
    expect(setOverride).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
  })

  it('stores a valid choice, restarts what changed and reports a refusal without refreshing', () => {
    const overrides = new ServerOverrides(file)
    const refresh = vi.fn()
    const deps = {
      servers: { servers: () => listed, refresh },
      setOverride: (key: string, raw: unknown) => overrides.choose(key, raw),
    } as never
    expect(chooseServerProgram(deps, 'ext/ls', { path: join(tmp, 'absent') })).toEqual({
      servers: listed,
      problem: 'missing',
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(chooseServerProgram(deps, 'ext/ls', { path: program, args: [] })).toEqual({
      servers: listed,
    })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(overrides.get('ext/ls')?.path).toBe(program)
  })
})

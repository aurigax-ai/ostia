import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkReadPath } from './readPaths'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pine-readpaths-')))
const home = join(root, 'home')
const dataDir = join(home, '.local/share/pine')
mkdirSync(join(home, 'notes'), { recursive: true })
mkdirSync(dataDir, { recursive: true })

afterAll(() => rmSync(root, { recursive: true, force: true }))

const env = { home, dataDirs: [dataDir] }

describe('checkReadPath', () => {
  it('SBX-C26 refuses /, the home dir, the data dir, relative and missing paths with a reason', () => {
    expect(checkReadPath('/', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkReadPath('~', env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkReadPath(`${home}/`, env)).toEqual({ ok: false, reason: 'too-broad' })
    expect(checkReadPath(dataDir, env)).toEqual({ ok: false, reason: 'pine-data' })
    expect(checkReadPath(join(dataDir, 'vault.json'), env)).toEqual({
      ok: false,
      reason: 'pine-data',
    })
    expect(checkReadPath('notes', env)).toEqual({ ok: false, reason: 'not-absolute' })
    expect(checkReadPath('~/missing', env)).toEqual({ ok: false, reason: 'missing' })
    expect(checkReadPath('~/notes', env)).toEqual({ ok: true, path: '~/notes' })
    expect(checkReadPath(join(home, 'notes'), env)).toEqual({
      ok: true,
      path: join(home, 'notes'),
    })
  })
})

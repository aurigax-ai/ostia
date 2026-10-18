import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { forgetMailFlag, registerMailFlag, syncMailFlags } from './mailFlag'

const dir = mkdtempSync(join(tmpdir(), 'ostia-mailflag-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('mail flag files', () => {
  it('writes a 0600 file for a pane whose queued count changed, and only then', () => {
    const path = join(dir, 'a.mail')
    registerMailFlag('a', path)
    syncMailFlags(new Map())
    expect(existsSync(path)).toBe(true)
    const first = readFileSync(path, 'utf8')
    expect(first).toMatch(/^0:\d+\n$/)
    syncMailFlags(new Map())
    expect(readFileSync(path, 'utf8')).toBe(first)
    syncMailFlags(new Map([['a', 2]]))
    expect(readFileSync(path, 'utf8')).toMatch(/^2:\d+\n$/)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('leaves a pane that was not registered alone, and removes the file when the pane is forgotten', () => {
    const path = join(dir, 'b.mail')
    registerMailFlag('b', path)
    syncMailFlags(new Map([['unknown', 3]]))
    expect(readFileSync(path, 'utf8')).toMatch(/^0:/)
    forgetMailFlag('b')
    expect(existsSync(path)).toBe(false)
    syncMailFlags(new Map([['b', 1]]))
    expect(existsSync(path)).toBe(false)
  })

  it('does not fail when the folder is gone', () => {
    registerMailFlag('c', join(dir, 'missing', 'c.mail'))
    expect(() => syncMailFlags(new Map([['c', 1]]))).not.toThrow()
  })
})

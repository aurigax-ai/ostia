import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { paneToken } from './paneToken'

const root = mkdtempSync(join(tmpdir(), 'ostia-pane-token-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('paneToken', () => {
  it('KSH-C72 reads a kept pane token from its file each time, so a rotated token is used', () => {
    const file = join(root, 'token')
    writeFileSync(file, 'first\n')
    const env = { OSTIA_TOKEN_FILE: file }
    expect(paneToken(env)).toBe('first')
    writeFileSync(file, 'second')
    expect(paneToken(env)).toBe('second')
  })

  it('prefers OSTIA_TOKEN and has no token when the file is missing or empty', () => {
    const empty = join(root, 'empty')
    writeFileSync(empty, '')
    expect(paneToken({ OSTIA_TOKEN: 'direct', OSTIA_TOKEN_FILE: empty })).toBe('direct')
    expect(paneToken({ OSTIA_TOKEN_FILE: empty })).toBeUndefined()
    expect(paneToken({ OSTIA_TOKEN_FILE: join(root, 'missing') })).toBeUndefined()
    expect(paneToken({})).toBeUndefined()
  })
})

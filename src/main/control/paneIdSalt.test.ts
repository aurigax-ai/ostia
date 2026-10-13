import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPaneIdSalt } from './paneIdSalt'

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pane-id-salt-'))
  dirs.push(dir)
  return join(dir, 'pane-id-salt.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('loadPaneIdSalt', () => {
  it('creates a 32-byte salt once and returns the same one on the next launch', () => {
    const path = tempFile()
    const first = loadPaneIdSalt(path)
    const second = loadPaneIdSalt(path)

    expect(first.length).toBe(32)
    expect(second.equals(first)).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).salt).toBe(first.toString('hex'))
  })

  it('keeps the salt file private to the user', () => {
    const path = tempFile()
    loadPaneIdSalt(path)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('replaces a damaged salt file with a new salt', () => {
    const path = tempFile()
    writeFileSync(path, '{"salt":"not-hex"}')
    const salt = loadPaneIdSalt(path)

    expect(salt.length).toBe(32)
    expect(loadPaneIdSalt(path).equals(salt)).toBe(true)
  })
})

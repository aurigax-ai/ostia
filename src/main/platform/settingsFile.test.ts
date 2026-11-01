import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dir = vi.hoisted(() => ({ current: '' }))
vi.mock('electron', () => ({ app: { getPath: () => dir.current } }))

import { readSettingsFile, recoverCorruptSettings, recoveredSettingsCopy } from './settingsFile'

const file = () => join(dir.current, 'settings.json')

beforeEach(() => {
  dir.current = mkdtempSync(join(tmpdir(), 'settings-file-'))
})

afterEach(() => {
  rmSync(dir.current, { recursive: true, force: true })
})

describe('recoverCorruptSettings', () => {
  it('moves a corrupt settings.json aside with mode 0600 and writes fresh defaults', () => {
    writeFileSync(file(), '{ "terminal": ')
    recoverCorruptSettings(() => 42)
    const copy = join(dir.current, 'settings.json.corrupt-42')
    expect(readFileSync(copy, 'utf8')).toBe('{ "terminal": ')
    expect(statSync(copy).mode & 0o777).toBe(0o600)
    expect(readSettingsFile()).toEqual({})
    expect(recoveredSettingsCopy()).toBe(copy)
  })

  it('treats JSON that is not an object as corrupt', () => {
    writeFileSync(file(), '[1]')
    recoverCorruptSettings(() => 7)
    expect(readdirSync(dir.current).sort()).toEqual(['settings.json', 'settings.json.corrupt-7'])
  })

  it('leaves a valid file alone', () => {
    writeFileSync(file(), '{"locale":"en"}')
    recoverCorruptSettings(() => 1)
    expect(readdirSync(dir.current)).toEqual(['settings.json'])
    expect(readFileSync(file(), 'utf8')).toBe('{"locale":"en"}')
  })

  it('leaves a missing or empty file alone', () => {
    recoverCorruptSettings(() => 1)
    writeFileSync(file(), '  ')
    recoverCorruptSettings(() => 2)
    expect(readdirSync(dir.current)).toEqual(['settings.json'])
  })
})

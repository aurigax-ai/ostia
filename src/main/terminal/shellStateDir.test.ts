import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { privateRunDir } from '../platform/privateTmp'

describe('shell state folder', () => {
  it('lives in the app data folder on macOS, which dirhelper does not reap', () => {
    const home = mkdtempSync(join(tmpdir(), 'state-home-'))
    try {
      expect(privateRunDir('shell-state', 'darwin', {}, home)).toBe(
        join(home, '.local', 'share', 'ostia', 'run', 'shell-state'),
      )
      expect(privateRunDir('codex', 'darwin', {}, home)).toBe(
        join(home, '.local', 'share', 'ostia', 'run', 'codex'),
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

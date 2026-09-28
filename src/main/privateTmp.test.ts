import { statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { privateTmpDir } from './privateTmp'

describe('privateTmpDir', () => {
  it('creates a per-user directory only the owner can access', () => {
    const dir = privateTmpDir(`pine-test-${process.pid}`)
    const st = statSync(dir)
    expect(st.isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect(dir.endsWith(`-${process.getuid?.()}`)).toBe(true)
      expect(st.mode & 0o077).toBe(0)
    }
  })

  it('is idempotent', () => {
    const name = `pine-test-idem-${process.pid}`
    expect(privateTmpDir(name)).toBe(privateTmpDir(name))
  })
})

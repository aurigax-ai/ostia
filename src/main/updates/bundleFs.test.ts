import * as nodeFs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bundleFs } from './bundleFs'

describe('bundleFs', () => {
  it('is plain node fs outside Electron', () => {
    expect(process.versions.electron).toBeUndefined()
    expect(bundleFs.promises.rm).toBe(nodeFs.promises.rm)
  })
})

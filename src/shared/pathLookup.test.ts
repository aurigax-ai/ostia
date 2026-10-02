import { describe, it, expect } from 'vitest'
import { findOnPath } from './pathLookup'

describe('findOnPath', () => {
  const mockIsExecutable = (path: string): boolean => {
    const executablePaths = new Set(['/usr/bin/bash', '/bin/sh', '/usr/local/bin/custom'])
    return executablePaths.has(path)
  }

  it('finds program in first matching directory', () => {
    const pathEnv = '/usr/bin:/bin:/usr/local/bin'
    const result = findOnPath('bash', pathEnv, mockIsExecutable)
    expect(result).toBe('/usr/bin/bash')
  })

  it('finds program in subsequent directories', () => {
    const pathEnv = '/opt/bin:/bin:/usr/local/bin'
    const result = findOnPath('sh', pathEnv, mockIsExecutable)
    expect(result).toBe('/bin/sh')
  })

  it('finds program in last directory', () => {
    const pathEnv = '/opt/bin:/bin:/usr/local/bin'
    const result = findOnPath('custom', pathEnv, mockIsExecutable)
    expect(result).toBe('/usr/local/bin/custom')
  })

  it('returns null if program not found', () => {
    const pathEnv = '/usr/bin:/bin'
    const result = findOnPath('notfound', pathEnv, mockIsExecutable)
    expect(result).toBeNull()
  })

  it('skips empty path entries', () => {
    const pathEnv = '/usr/bin::/bin'
    const result = findOnPath('sh', pathEnv, mockIsExecutable)
    expect(result).toBe('/bin/sh')
  })

  it('handles empty PATH', () => {
    const result = findOnPath('bash', '', mockIsExecutable)
    expect(result).toBeNull()
  })

  it('respects isExecutable function', () => {
    const neverExecutable = (): boolean => false
    const pathEnv = '/usr/bin:/bin'
    const result = findOnPath('bash', pathEnv, neverExecutable)
    expect(result).toBeNull()
  })
})

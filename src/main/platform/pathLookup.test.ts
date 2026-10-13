import { describe, expect, it } from 'vitest'
import { findOnPath } from './pathLookup'

const executables = (...files: string[]) => {
  const known = new Set(files)
  return (file: string): boolean => known.has(file)
}

describe('findOnPath', () => {
  it('returns the match in the earliest PATH directory', () => {
    const isExecutable = executables('/usr/bin/sh', '/bin/sh', '/usr/local/bin/custom')
    expect(findOnPath('sh', '/opt/bin:/bin:/usr/bin', isExecutable)).toBe('/bin/sh')
    expect(findOnPath('sh', '/usr/bin:/bin', isExecutable)).toBe('/usr/bin/sh')
    expect(findOnPath('custom', '/opt/bin:/bin:/usr/local/bin', isExecutable)).toBe(
      '/usr/local/bin/custom',
    )
  })

  it('returns null when no directory holds the program', () => {
    expect(findOnPath('nope', '/usr/bin:/bin', executables('/bin/sh'))).toBeNull()
    expect(findOnPath('sh', '', executables('/bin/sh'))).toBeNull()
    expect(findOnPath('sh', '/usr/bin:/bin', () => false)).toBeNull()
  })

  it('skips empty PATH entries instead of reading them as the current folder', () => {
    expect(findOnPath('code', ':/bin:', executables('/bin/code'))).toBe('/bin/code')
    expect(findOnPath('code', ':/bin:', executables('code', '/bin/code'))).toBe('/bin/code')
    expect(findOnPath('code', '::', executables('code'))).toBeNull()
  })

  it('asks about each candidate only by its joined path', () => {
    const asked: string[] = []
    const record = (file: string): boolean => {
      asked.push(file)
      return false
    }
    findOnPath('code', '/a/:bin:/b//c', record)
    expect(asked).toEqual(['/a/code', 'bin/code', '/b/c/code'])
  })
})

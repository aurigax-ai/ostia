import { describe, expect, it } from 'vitest'
import { archiveRoot, isArchivePath, parseArchivePath } from './archivePaths'

describe('archivePaths', () => {
  it('round-trips an archive path, also when the real path holds ! and %', () => {
    const real = '/home/u/a!b%20c/report.zip'
    const root = archiveRoot(real)
    expect(root).toBe('archive:%2Fhome%2Fu%2Fa%21b%2520c%2Freport.zip!')
    expect(parseArchivePath(root)).toEqual({ archive: real, entry: '' })
    expect(parseArchivePath(`${root}/data/a!.csv`)).toEqual({ archive: real, entry: 'data/a!.csv' })
  })

  it('refuses anything that is not an absolute archive path', () => {
    for (const path of [
      'archive:',
      'archive:%2Fa.zip',
      'archive:a.zip!',
      'archive:%2Fa.zip!x',
      '/a.zip',
    ]) {
      expect(parseArchivePath(path), path).toBeNull()
    }
    expect(isArchivePath('/home/a.zip')).toBe(false)
    expect(isArchivePath(undefined)).toBe(false)
  })
})

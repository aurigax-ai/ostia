import { describe, expect, it } from 'vitest'
import {
  archiveDisplayName,
  archiveRoot,
  isArchiveName,
  isArchivePath,
  parseArchivePath,
} from './archivePaths'

describe('archivePaths', () => {
  it('round-trips an archive path, also when the real path holds ! and %', () => {
    const real = '/home/u/a!b%20c/report.zip'
    const root = archiveRoot(real)
    expect(root).toBe('archive:%2Fhome%2Fu%2Fa%21b%2520c%2Freport.zip!')
    expect(parseArchivePath(root)).toEqual({ archive: real, entry: '' })
    expect(parseArchivePath(`${root}/data/a!.csv`)).toEqual({ archive: real, entry: 'data/a!.csv' })
    expect(archiveDisplayName(`${root}/data/a.csv`)).toBe('report.zip › data/a.csv')
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

  it('knows which file names are archives it browses', () => {
    for (const name of ['a.zip', 'A.JAR', 'a.tar', 'a.tgz', 'a.tar.gz', 'a.tar.zst']) {
      expect(isArchiveName(name), name).toBe(true)
    }
    for (const name of ['a.xlsx', 'a.docx', 'a.tar.xz', 'a.7z', 'a.rar', 'zip']) {
      expect(isArchiveName(name), name).toBe(false)
    }
  })
})

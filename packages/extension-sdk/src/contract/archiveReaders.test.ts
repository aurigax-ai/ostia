import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest/extensionManifest'
import { extensionManifestSchema } from '../manifest/manifestSchema'
import {
  ARCHIVE_READERS_MAX,
  CORE_ARCHIVE_SUFFIXES,
  archiveReaderMatches,
  clashesWithCore,
  isCoreArchiveName,
  parseArchiveReaders,
} from './archiveReaders'

const XZ = {
  id: 'xz',
  displayName: 'tar.xz',
  selector: [{ filenamePattern: '*.tar.xz' }, { filenamePattern: '*.txz' }],
}

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'archives',
    name: 'Archives',
    version: '1.0.0',
    api: '4.13',
    main: 'main.js',
    contributes: { archiveReaders: [XZ] },
    ...extra,
  }
}

describe('parseArchiveReaders', () => {
  it('reads readers and leaves an extension without them alone', () => {
    expect(parseArchiveReaders([XZ], '4.13', true)).toEqual([XZ])
    expect(parseArchiveReaders(undefined, '4.0', false)).toEqual([])
  })

  it('refuses names Files already reads, by suffix in either direction or by file name', () => {
    for (const pattern of ['*.zip', '*.gz', '*.zst', 'foo.tar', '*.backup.zip', '*.TGZ', '*.jar']) {
      expect(clashesWithCore(pattern), pattern).toBe(true)
      const reader = { ...XZ, selector: [{ filenamePattern: pattern }] }
      expect(parseArchiveReaders([reader], '4.13', true), pattern).toMatch(/already reads/)
    }
    for (const pattern of ['*.tar.xz', '*.txz', '*.tar.bz2', '*.tbz', '*.7z', 'gz']) {
      expect(clashesWithCore(pattern), pattern).toBe(false)
    }
  })

  it('refuses an older api, a missing main, too many readers, bad ids and duplicates', () => {
    const cases: [unknown, string, boolean, RegExp][] = [
      [[XZ], '4.12', true, /needs api 4\.13/],
      [[XZ], '3.20', true, /needs api 4\.13/],
      [[XZ], '4.13', false, /needs a main process/],
      [Array.from({ length: ARCHIVE_READERS_MAX + 1 }, () => XZ), '4.13', true, /at most 8/],
      [[{ ...XZ, id: 'Xz' }], '4.13', true, /id must match/],
      [[{ ...XZ, displayName: '' }], '4.13', true, /displayName/],
      [[{ ...XZ, selector: [] }], '4.13', true, /selector/],
      [[{ ...XZ, selector: [{ filenamePattern: '*' }] }], '4.13', true, /filenamePattern/],
      [[XZ, XZ], '4.13', true, /duplicate id 'xz'/],
      ['nope', '4.13', true, /array/],
    ]
    for (const [raw, api, hasMain, problem] of cases) {
      expect(parseArchiveReaders(raw, api, hasMain)).toMatch(problem)
    }
  })

  it('matches by suffix without case and knows the core names', () => {
    expect(archiveReaderMatches('/a/B.TAR.XZ', XZ)).toBe(true)
    expect(archiveReaderMatches('/a/b.tar.gz', XZ)).toBe(false)
    for (const suffix of CORE_ARCHIVE_SUFFIXES) expect(isCoreArchiveName(`a${suffix}`)).toBe(true)
    expect(isCoreArchiveName('a.tar.xz')).toBe(false)
  })
})

describe('a manifest with archive readers', () => {
  it('is accepted with main and api 4.13, and refused otherwise', () => {
    const ok = parseManifest(manifest(), '/ext/archives')
    expect(ok.ok && ok.manifest.contributes.archiveReaders).toEqual([XZ])
    expect(parseManifest(manifest({ api: '4.12' }), '/ext/archives')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs api 4\.13/),
    })
    expect(parseManifest(manifest({ main: undefined }), '/ext/archives')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/needs a main process/),
    })
    for (const filenamePattern of ['*.zip', '*.gz', '*.zst', 'foo.tar']) {
      const raw = manifest({
        contributes: { archiveReaders: [{ ...XZ, selector: [{ filenamePattern }] }] },
      })
      expect(parseManifest(raw, '/ext/archives').ok, filenamePattern).toBe(false)
      expect(extensionManifestSchema.safeParse(raw).success, filenamePattern).toBe(false)
    }
    expect(extensionManifestSchema.safeParse(manifest()).success).toBe(true)
  })
})

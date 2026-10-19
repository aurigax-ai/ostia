import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest/extensionManifest'
import { extensionManifestSchema } from '../manifest/manifestSchema'
import { kindClaim, kindMatches, matchesFilenamePattern, parseFileKinds } from './fileKinds'

const inside = (path: string): boolean => !path.startsWith('..') && !path.startsWith('/')

const SHEET = {
  id: 'office.spreadsheet',
  displayName: 'Spreadsheet',
  selector: [{ filenamePattern: '*.xlsx' }, { filenamePattern: '*.tar.gz' }],
  view: { entry: 'sheet.html', priority: 'default' },
}

describe('parseFileKinds', () => {
  it('reads a kind with a view role, defaulting the priority', () => {
    const noPriority = { ...SHEET, view: { entry: 'sheet.html' } }
    expect(parseFileKinds([noPriority], 'office', inside)).toEqual([SHEET])
    expect(parseFileKinds(undefined, 'office', inside)).toEqual([])
  })

  it('refuses an id of another extension, a bad pattern, a missing view or a duplicate', () => {
    const cases: [unknown, RegExp][] = [
      [[{ ...SHEET, id: 'csv.spreadsheet' }], /id must be 'office.<name>'/],
      [[{ ...SHEET, id: 'office.a.b' }], /id/],
      [[{ ...SHEET, selector: [{ filenamePattern: '*' }] }], /filenamePattern/],
      [[{ ...SHEET, selector: [{ filenamePattern: 'a/b.xlsx' }] }], /filenamePattern/],
      [[{ ...SHEET, selector: [] }], /selector/],
      [[{ ...SHEET, view: undefined }], /view must be an object/],
      [[{ ...SHEET, view: { ...SHEET.view, priority: 'always' } }], /priority/],
      [[{ ...SHEET, view: { entry: '../x.html' } }], /view.entry/],
      [[{ ...SHEET, view: { entry: 'sheet.js' } }], /view.entry/],
      [[SHEET, SHEET], /duplicate id/],
      ['nope', /array/],
    ]
    for (const [raw, problem] of cases) {
      expect(parseFileKinds(raw, 'office', inside)).toMatch(problem)
    }
  })

  it('caps the kinds and the patterns they claim in all', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...SHEET,
        id: `office.k${String.fromCharCode(97 + (i % 26))}${Math.floor(i / 26)}`,
      }))
    expect(parseFileKinds(many(17), 'office', inside)).toMatch(/at most 16/)
    const wide = Array.from({ length: 3 }, (_, i) => ({
      ...SHEET,
      id: `office.w${i}`,
      selector: Array.from({ length: 22 }, (_, j) => ({ filenamePattern: `*.e${i}x${j}` })),
    }))
    expect(parseFileKinds(wide, 'office', inside)).toMatch(/at most 64 filename patterns/)
  })

  it('ignores the old contributes.fileViewers key', () => {
    const raw = {
      id: 'office',
      name: 'Office',
      version: '1.0.0',
      api: '5.0',
      contributes: {
        fileViewers: [{ viewType: 'office.spreadsheet', entry: 'sheet.html' }],
      },
    }
    const parsed = parseManifest(raw, '/ext/office')
    expect(parsed.ok && parsed.manifest.contributes.fileKinds).toBeUndefined()
  })

  it('goes through the manifest parser and its JSON schema alike', () => {
    const raw = {
      id: 'office',
      name: 'Office',
      version: '1.0.0',
      api: '5.0',
      contributes: { fileKinds: [SHEET] },
    }
    const parsed = parseManifest(raw, '/ext/office')
    expect(parsed.ok && parsed.manifest.contributes.fileKinds).toEqual([SHEET])
    expect(extensionManifestSchema.safeParse(raw).success).toBe(true)
    const bad = { ...raw, contributes: { fileKinds: [{ ...SHEET, selector: [] }] } }
    expect(parseManifest(bad, '/ext/office').ok).toBe(false)
    expect(extensionManifestSchema.safeParse(bad).success).toBe(false)
    const noView = { ...raw, contributes: { fileKinds: [{ ...SHEET, view: undefined }] } }
    expect(parseManifest(noView, '/ext/office').ok).toBe(false)
    expect(extensionManifestSchema.safeParse(noView).success).toBe(false)
  })
})

describe('kindClaim', () => {
  it('names the id, the role and the sorted lowercase patterns, so a widened selector is a new claim', () => {
    const kind = {
      id: 'office.spreadsheet',
      selector: [{ filenamePattern: '*.XLSX' }, { filenamePattern: '*.ods' }],
    }
    expect(kindClaim(kind)).toBe('office.spreadsheet:view:*.ods,*.xlsx')
    expect(kindClaim({ ...kind, selector: [...kind.selector].reverse() })).toBe(kindClaim(kind))
    expect(
      kindClaim({ ...kind, selector: [...kind.selector, { filenamePattern: '*.csv' }] }),
    ).not.toBe(kindClaim(kind))
  })
})

describe('matchesFilenamePattern', () => {
  it('matches base names by suffix or exactly, without case', () => {
    expect(matchesFilenamePattern('/w/Report.XLSX', '*.xlsx')).toBe(true)
    expect(matchesFilenamePattern('/w/src.tar.gz', '*.tar.gz')).toBe(true)
    expect(matchesFilenamePattern('/w/.xlsx', '*.xlsx')).toBe(false)
    expect(matchesFilenamePattern('/w/a.xlsx.txt', '*.xlsx')).toBe(false)
    expect(matchesFilenamePattern('/w/Makefile', 'makefile')).toBe(true)
    expect(matchesFilenamePattern('archive:%2Fw%2Fa.zip!/data/b.csv', '*.csv')).toBe(true)
    expect(kindMatches('/w/a.csv', { selector: [{ filenamePattern: '*.tsv' }] })).toBe(false)
  })
})

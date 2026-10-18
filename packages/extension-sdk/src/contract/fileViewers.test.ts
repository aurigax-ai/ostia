import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest/extensionManifest'
import { extensionManifestSchema } from '../manifest/manifestSchema'
import { matchesFilenamePattern, parseFileViewers, viewerMatches } from './fileViewers'

const inside = (path: string): boolean => !path.startsWith('..') && !path.startsWith('/')

const SHEET = {
  viewType: 'office.spreadsheet',
  displayName: 'Spreadsheet',
  selector: [{ filenamePattern: '*.xlsx' }, { filenamePattern: '*.tar.gz' }],
  priority: 'default',
  entry: 'sheet.html',
}

describe('parseFileViewers', () => {
  it('reads viewers in the custom-editor shape, defaulting the priority', () => {
    const { priority: _priority, ...noPriority } = SHEET
    expect(parseFileViewers([noPriority], 'office', inside)).toEqual([
      { ...SHEET, priority: 'default' },
    ])
    expect(parseFileViewers(undefined, 'office', inside)).toEqual([])
  })

  it('refuses a viewType of another extension, a bad pattern, a missing entry or a duplicate', () => {
    const cases: [unknown, RegExp][] = [
      [[{ ...SHEET, viewType: 'csv.spreadsheet' }], /viewType must be 'office.<name>'/],
      [[{ ...SHEET, viewType: 'office.a.b' }], /viewType/],
      [[{ ...SHEET, selector: [{ filenamePattern: '*' }] }], /filenamePattern/],
      [[{ ...SHEET, selector: [{ filenamePattern: 'a/b.xlsx' }] }], /filenamePattern/],
      [[{ ...SHEET, selector: [] }], /selector/],
      [[{ ...SHEET, priority: 'always' }], /priority/],
      [[{ ...SHEET, entry: '../x.html' }], /entry/],
      [[{ ...SHEET, entry: 'sheet.js' }], /entry/],
      [[SHEET, SHEET], /duplicate viewType/],
      ['nope', /array/],
    ]
    for (const [raw, problem] of cases) {
      expect(parseFileViewers(raw, 'office', inside)).toMatch(problem)
    }
  })

  it('goes through the manifest parser and its JSON schema alike', () => {
    const raw = {
      id: 'office',
      name: 'Office',
      version: '1.0.0',
      api: '5.0',
      contributes: { fileViewers: [SHEET] },
    }
    const parsed = parseManifest(raw, '/ext/office')
    expect(parsed.ok && parsed.manifest.contributes.fileViewers).toEqual([SHEET])
    expect(extensionManifestSchema.safeParse(raw).success).toBe(true)
    const bad = { ...raw, contributes: { fileViewers: [{ ...SHEET, selector: [] }] } }
    expect(parseManifest(bad, '/ext/office').ok).toBe(false)
    expect(extensionManifestSchema.safeParse(bad).success).toBe(false)
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
    expect(viewerMatches('/w/a.csv', { selector: [{ filenamePattern: '*.tsv' }] })).toBe(false)
  })
})

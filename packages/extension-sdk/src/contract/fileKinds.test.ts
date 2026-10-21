import { describe, expect, it } from 'vitest'
import { parseManifest } from '../manifest/extensionManifest'
import { extensionManifestSchema } from '../manifest/manifestSchema'
import {
  browseKindFor,
  kindClaim,
  kindMatches,
  matchesFilenamePattern,
  parseFileKinds,
} from './fileKinds'

const isInside = (path: string): boolean => !path.startsWith('..') && !path.startsWith('/')
const inside = { isInside, main: false, capabilities: [] as never[] }
const browsing = { isInside, main: true, capabilities: ['file-contents' as const] }

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
      [[{ ...SHEET, view: undefined }], /needs a view or a browse role/],
      [[{ ...SHEET, view: 'x' }], /view must be an object/],
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
      api: '7.0',
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
      api: '7.0',
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

describe('browse role', () => {
  const ZIP = {
    id: 'archives.zip',
    displayName: 'Zip archive',
    selector: [{ filenamePattern: '*.zip' }],
    browse: {},
  }

  it('reads a browse-only kind and a kind with both roles', () => {
    expect(parseFileKinds([ZIP], 'archives', browsing)).toEqual([ZIP])
    const both = { ...ZIP, view: { entry: 'zip.html' } }
    expect(parseFileKinds([both], 'archives', browsing)).toEqual([
      { ...ZIP, view: { entry: 'zip.html', priority: 'default' } },
    ])
  })

  it('needs a main process and the file-contents capability', () => {
    const problem = /browse needs a main process and the 'file-contents' capability/
    expect(parseFileKinds([ZIP], 'archives', inside)).toMatch(problem)
    expect(parseFileKinds([ZIP], 'archives', { ...browsing, main: false })).toMatch(problem)
    expect(parseFileKinds([ZIP], 'archives', { ...browsing, capabilities: [] })).toMatch(problem)
  })

  it('refuses a kind with neither role', () => {
    expect(parseFileKinds([{ ...ZIP, browse: undefined }], 'archives', browsing)).toMatch(
      /needs a view or a browse role/,
    )
  })

  it('goes through the manifest parser and the schema', () => {
    const raw = {
      id: 'archives',
      name: 'Archives',
      version: '1.0.0',
      api: '7.0',
      main: 'main.js',
      capabilities: ['file-contents'],
      contributes: { fileKinds: [ZIP] },
    }
    const parsed = parseManifest(raw, '/ext/archives')
    expect(parsed.ok && parsed.manifest.contributes.fileKinds).toEqual([ZIP])
    expect(extensionManifestSchema.safeParse(raw).success).toBe(true)
    expect(parseManifest({ ...raw, capabilities: [] }, '/ext/archives').ok).toBe(false)
  })

  it('claims the browse role apart from the view role', () => {
    const base = { id: 'archives.zip', selector: [{ filenamePattern: '*.zip' }] }
    expect(kindClaim({ ...base, browse: true })).toBe('archives.zip:browse:*.zip')
    expect(kindClaim({ ...base, view: { priority: 'default' }, browse: true })).toBe(
      'archives.zip:view:default+browse:*.zip',
    )
    expect(kindClaim({ ...base, view: { priority: 'default' } })).not.toBe(
      kindClaim({ ...base, view: { priority: 'default' }, browse: true }),
    )
  })
})

describe('browseKindFor', () => {
  const candidate = (extId: string, builtin: boolean, id: string, ...patterns: string[]) => ({
    extId,
    builtin,
    kind: { id, selector: patterns.map((filenamePattern) => ({ filenamePattern })) },
  })

  it('serves a file from one kind: built-in, then the longest pattern, then the extension id', () => {
    const gz = candidate('zz', false, 'zz.gz', '*.gz')
    const tarGz = candidate('aa', false, 'aa.tar', '*.tar.gz')
    const builtin = candidate('archives', true, 'archives.gz', '*.gz')
    expect(browseKindFor('/w/a.tar.gz', [gz, tarGz])?.kind.id).toBe('aa.tar')
    expect(browseKindFor('/w/a.tar.gz', [gz, tarGz, builtin])?.kind.id).toBe('archives.gz')
    expect(browseKindFor('/w/a.gz', [candidate('b', false, 'b.x', '*.gz'), gz])?.extId).toBe('b')
    expect(browseKindFor('/w/a.txt', [gz])).toBeNull()
  })
})

describe('kindClaim', () => {
  const kind = {
    id: 'office.spreadsheet',
    selector: [{ filenamePattern: '*.XLSX' }, { filenamePattern: '*.ods' }],
    view: { priority: 'option' as const },
  }

  it('names the id, the role, the priority and the sorted lowercase patterns', () => {
    expect(kindClaim(kind)).toBe('office.spreadsheet:view:option:*.ods,*.xlsx')
    expect(kindClaim({ ...kind, selector: [...kind.selector].reverse() })).toBe(kindClaim(kind))
  })

  it('is a new claim when the selector widens or an option view becomes the default opener', () => {
    const widened = { ...kind, selector: [...kind.selector, { filenamePattern: '*.csv' }] }
    expect(kindClaim(widened)).not.toBe(kindClaim(kind))
    expect(kindClaim({ ...kind, view: { priority: 'default' } })).not.toBe(kindClaim(kind))
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

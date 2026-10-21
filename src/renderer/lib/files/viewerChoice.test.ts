import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it } from 'vitest'
import { associationPattern, chooseViewer, viewerOptions } from './viewerChoice'

function ext(
  id: string,
  builtin: boolean,
  kinds: ExtensionInfo['fileKinds'],
  enabled = true,
): ExtensionInfo {
  return { id, builtin, enabled, fileKinds: kinds } as ExtensionInfo
}

const SHEET = {
  id: 'office.spreadsheet',
  displayName: 'Spreadsheet',
  selector: [{ filenamePattern: '*.xlsx' }],
  view: { priority: 'default' as const },
  approved: true,
}
const RIVAL = { ...SHEET, id: 'acme.grid', displayName: 'Acme' }
const TABLE = {
  id: 'csv.table',
  displayName: 'Table',
  selector: [{ filenamePattern: '*.csv' }],
  view: { priority: 'option' as const },
  approved: true,
}

const IMAGE = {
  id: 'images.image',
  displayName: 'Image',
  selector: [{ filenamePattern: '*.png' }],
  view: { priority: 'default' as const },
  approved: true,
}

const EXTENSIONS = [
  ext('images', true, [IMAGE]),
  ext('acme', false, [RIVAL]),
  ext('office', true, [SHEET]),
  ext('csv', true, [TABLE]),
  ext('off', true, [{ ...SHEET, id: 'off.sheet' }], false),
]

function choose(path: string, extra: Partial<Parameters<typeof chooseViewer>[0]> = {}) {
  return chooseViewer({
    path,
    options: viewerOptions(path, EXTENSIONS),
    associations: {},
    ownView: false,
    inArtifacts: false,
    ...extra,
  })
}

describe('viewerChoice', () => {
  it('lists enabled matching viewers, built-ins first, then by extension id', () => {
    expect(viewerOptions('/w/a.xlsx', EXTENSIONS).map((o) => o.viewType)).toEqual([
      'office.spreadsheet',
      'acme.grid',
    ])
    expect(viewerOptions('/w/a.txt', EXTENSIONS)).toEqual([])
  })

  it('leaves out a kind whose claim the human has not approved', () => {
    const waiting = ext('wide', false, [{ ...RIVAL, id: 'wide.grid', approved: false }])
    expect(viewerOptions('/w/a.xlsx', [waiting]).map((o) => o.viewType)).toEqual([])
    expect(
      chooseViewer({
        path: '/w/a.xlsx',
        options: viewerOptions('/w/a.xlsx', [waiting]),
        chosen: 'wide.grid',
        associations: {},
        ownView: false,
        inArtifacts: false,
      }).unavailable,
    ).toBe(true)
  })

  it('opens the first default viewer, never an option one outside artifacts', () => {
    expect(choose('/w/a.xlsx').viewer?.viewType).toBe('office.spreadsheet')
    expect(choose('/w/a.csv').viewer).toBeNull()
    expect(choose('/w/a.csv', { inArtifacts: true }).viewer?.viewType).toBe('csv.table')
  })

  it('opens an image in the images viewer, and in no viewer once that extension is off', () => {
    expect(choose('/w/a.png').viewer?.viewType).toBe('images.image')
    const without = EXTENSIONS.filter((extension) => extension.id !== 'images')
    expect(choose('/w/a.png', { options: viewerOptions('/w/a.png', without) })).toEqual({
      viewer: null,
      unavailable: false,
    })
  })

  it('lets the pane choice and then an association win, and keeps core views', () => {
    expect(choose('/w/a.xlsx', { chosen: 'acme.grid' }).viewer?.viewType).toBe('acme.grid')
    expect(choose('/w/a.xlsx', { chosen: 'default' })).toEqual({ viewer: null, unavailable: false })
    expect(choose('/w/a.xlsx', { associations: { '*.XLSX': 'acme.grid' } }).viewer?.viewType).toBe(
      'acme.grid',
    )
    expect(choose('/w/a.xlsx', { associations: { '*.xlsx': 'default' } }).viewer).toBeNull()
    expect(choose('/w/a.xlsx', { ownView: true }).viewer).toBeNull()
  })

  it('falls back to the own view and says so when the chosen viewer is gone', () => {
    expect(choose('/w/a.xlsx', { chosen: 'off.sheet' })).toEqual({
      viewer: null,
      unavailable: true,
    })
  })

  it('makes the association pattern from the whole suffix', () => {
    expect(associationPattern('/w/Report.XLSX')).toBe('*.xlsx')
    expect(associationPattern('/w/src.tar.gz')).toBe('*.tar.gz')
    expect(associationPattern('/w/Makefile')).toBe('Makefile')
    expect(associationPattern('/w/.env')).toBe('.env')
  })
})

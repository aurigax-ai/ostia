import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LanguageServerContribution } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import { afterEach, describe, expect, it } from 'vitest'
import type { LanguageServerSource } from '../../lsp/serverBinaries'
import { DismissedSuggestions, type SuggestionSources, suggestionFor } from './extensionSuggestions'

function server(
  extId: string,
  languages: string[],
  state: LanguageServerSource['state'],
): LanguageServerSource {
  const contribution: LanguageServerContribution = {
    id: 'srv',
    name: 'Server',
    languages,
    run: { program: 'srv', args: [] },
    rootMarkers: [],
  }
  return {
    extId,
    extName: extId,
    dir: `/ext/${extId}`,
    builtin: false,
    state,
    server: contribution,
    settingValues: {},
  }
}

function sources(extra: Partial<Record<keyof SuggestionSources, unknown>> = {}): SuggestionSources {
  return {
    servers: () => (extra.servers as LanguageServerSource[]) ?? [],
    extensions: () =>
      ((extra.extensions as object[]) ?? []).map((ext) => ({
        fileKinds: [],
        granted: [],
        ...ext,
      })) as unknown as ReturnType<SuggestionSources['extensions']>,
    listings: () =>
      ((extra.listings as object[]) ?? []).map((listing) => ({
        patterns: [],
        browsePatterns: [],
        ...listing,
      })) as unknown as ReturnType<SuggestionSources['listings']>,
    dismissed: () => (extra.dismissed as string[]) ?? [],
    official: 'official',
  }
}

describe('suggestionFor', () => {
  it('suggests the extension the compiled table names, even with no marketplace added', () => {
    expect(suggestionFor('/p/main.rs', sources())).toEqual({
      kind: 'install',
      extId: 'lsp-rust-analyzer',
      name: 'lsp-rust-analyzer',
      files: '.rs',
      feature: 'language',
      others: 0,
    })
    expect(suggestionFor('/p/go.mod', sources())).toMatchObject({
      extId: 'lsp-gopls',
      files: 'go.mod',
    })
  })

  it('names an extension from the table by the official marketplace’s listing, never another one’s', () => {
    const listings = [
      { marketplaceId: 'm1', extId: 'lsp-rust-analyzer', name: 'Squatter', languages: ['rust'] },
      {
        marketplaceId: 'official',
        extId: 'lsp-rust-analyzer',
        name: 'Rust (rust-analyzer)',
        languages: ['rust'],
      },
    ]
    expect(suggestionFor('/p/main.rs', sources({ listings }))).toMatchObject({
      kind: 'install',
      name: 'Rust (rust-analyzer)',
      others: 0,
    })
    expect(suggestionFor('/p/main.rs', sources({ listings: listings.slice(0, 1) }))).toMatchObject({
      name: 'lsp-rust-analyzer',
    })
  })

  it('suggests nothing once an enabled server claims the language', () => {
    const servers = [server('lsp-rust-analyzer', ['rust'], 'on')]
    expect(suggestionFor('/p/main.rs', sources({ servers }))).toBeNull()
    expect(suggestionFor('/p/notes.txt', sources())).toBeNull()
  })

  it('finds a third-party extension by the languages its manifest declares', () => {
    const listings = [
      { marketplaceId: 'm1', extId: 'gleam-tools', name: 'Gleam', languages: ['plaintext'] },
      { marketplaceId: 'm1', extId: 'other', name: 'Other', languages: ['plaintext'] },
      { marketplaceId: 'm1', extId: 'unrelated', name: 'Unrelated', languages: ['go'] },
    ]
    expect(suggestionFor('/p/notes.txt', sources({ listings }))).toEqual({
      kind: 'install',
      extId: 'gleam-tools',
      name: 'Gleam',
      files: '.txt',
      feature: 'language',
      others: 1,
    })
  })

  it('points at an installed extension that is switched off or waits for approval', () => {
    const servers = [server('lsp-pyright', ['python'], 'off')]
    const disabled = [
      { id: 'lsp-pyright', name: 'Python (Pyright)', enabled: false, status: 'disabled' },
    ]
    expect(suggestionFor('/p/a.py', sources({ servers, extensions: disabled }))).toEqual({
      kind: 'enable',
      extId: 'lsp-pyright',
      name: 'Python (Pyright)',
      files: '.py',
      pending: false,
      feature: 'language',
      others: 0,
    })
    const pending = [
      { id: 'lsp-pyright', name: 'Python (Pyright)', enabled: false, status: 'pending-approval' },
    ]
    expect(
      suggestionFor(
        '/p/a.py',
        sources({ servers: [server('lsp-pyright', ['python'], 'pending')], extensions: pending }),
      ),
    ).toMatchObject({ kind: 'enable', pending: true })
  })

  it('stays quiet about an enabled extension whose server the human switched off', () => {
    const servers = [server('lsp-pyright', ['python'], 'off')]
    const extensions = [
      { id: 'lsp-pyright', name: 'Python (Pyright)', enabled: true, status: 'idle' },
    ]
    expect(suggestionFor('/p/a.py', sources({ servers, extensions }))).toBeNull()
  })

  it('skips an extension the human said no to and offers the next one', () => {
    const listings = [
      { marketplaceId: 'm1', extId: 'alt-rust', name: 'Alt Rust', languages: ['rust'] },
    ]
    expect(suggestionFor('/p/main.rs', sources({ dismissed: ['lsp-rust-analyzer'] }))).toBeNull()
    expect(
      suggestionFor('/p/main.rs', sources({ dismissed: ['lsp-rust-analyzer'], listings })),
    ).toMatchObject({ extId: 'alt-rust', others: 0 })
  })
})

describe('DismissedSuggestions', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('remembers each declined extension once, across restarts, and ignores anything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-suggest-'))
    dirs.push(dir)
    const file = join(dir, 'extension-suggestions.json')
    const store = new DismissedSuggestions(file)
    store.dismiss('lsp-gopls')
    store.dismiss('lsp-gopls')
    store.dismiss('Not An Id')
    store.dismiss(42)
    expect(store.list()).toEqual(['lsp-gopls'])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ dismissed: ['lsp-gopls'] })
    expect(new DismissedSuggestions(file).list()).toEqual(['lsp-gopls'])
    writeFileSync(file, JSON.stringify({ dismissed: ['ok-id', 7, '../x'] }))
    expect(new DismissedSuggestions(file).list()).toEqual(['ok-id'])
  })

  it('saying No hides the offer for that extension, also after reopening the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ostia-suggest-'))
    dirs.push(dir)
    const store = new DismissedSuggestions(join(dir, 'extension-suggestions.json'))
    const listings = [
      { marketplaceId: 'm1', extId: 'fake-native', name: 'Fake native', languages: ['plaintext'] },
    ]
    const offers = { ...sources({ listings }), dismissed: () => store.list() }
    expect(suggestionFor('/p/notes.txt', offers)).toMatchObject({
      kind: 'install',
      extId: 'fake-native',
    })
    store.dismiss('fake-native')
    expect(suggestionFor('/p/notes.txt', offers)).toBeNull()
  })

  describe('file kinds', () => {
    const kind = (approved: boolean) => ({
      id: 'acme.grid',
      displayName: 'Grid',
      selector: [{ filenamePattern: '*.GRID' }],
      view: { priority: 'default' },
      approved,
    })
    const acme = (enabled: boolean, approved: boolean, status = 'idle') => ({
      id: 'acme',
      name: 'Acme',
      enabled,
      status,
      fileKinds: [kind(approved)],
    })

    it('offers to install an extension whose manifest has a kind for the file', () => {
      const listings = [
        { marketplaceId: 'm1', extId: 'acme', name: 'Acme', languages: [], patterns: ['*.grid'] },
        { marketplaceId: 'm1', extId: 'other', name: 'Other', languages: [], patterns: ['*.csv'] },
      ]
      expect(suggestionFor('/p/a.grid', sources({ listings }))).toEqual({
        kind: 'install',
        extId: 'acme',
        name: 'Acme',
        files: '.grid',
        feature: 'view',
        others: 0,
      })
      expect(suggestionFor('/p/a.txt', sources({ listings }))).toBeNull()
    })

    it('offers to enable an installed extension with a matching kind that is off', () => {
      expect(suggestionFor('/p/a.grid', sources({ extensions: [acme(false, true)] }))).toEqual({
        kind: 'enable',
        extId: 'acme',
        name: 'Acme',
        files: '.grid',
        pending: false,
        feature: 'view',
        others: 0,
      })
    })

    it('asks for approval when the extension is on but the kind was never approved', () => {
      expect(
        suggestionFor('/p/a.grid', sources({ extensions: [acme(true, false)] })),
      ).toMatchObject({ kind: 'enable', pending: true, feature: 'view' })
    })

    it('stays quiet when an enabled, approved kind already shows the file', () => {
      const listings = [
        { marketplaceId: 'm1', extId: 'rival', name: 'Rival', languages: [], patterns: ['*.grid'] },
      ]
      expect(
        suggestionFor('/p/a.grid', sources({ extensions: [acme(true, true)], listings })),
      ).toBeNull()
    })
  })

  describe('browse kinds', () => {
    const browse = (approved = true) => ({
      id: 'zips.zip',
      displayName: 'Zip',
      selector: [{ filenamePattern: '*.zip' }],
      browse: true,
      approved,
    })
    const zips = (enabled: boolean, extra: Record<string, unknown> = {}) => ({
      id: 'zips',
      name: 'Zips',
      enabled,
      status: 'idle',
      fileKinds: [browse()],
      granted: ['file-contents'],
      ...extra,
    })

    it('offers to install an extension whose manifest has a browse kind for the file', () => {
      const listings = [
        {
          marketplaceId: 'm1',
          extId: 'zips',
          name: 'Zips',
          languages: [],
          browsePatterns: ['*.zip'],
        },
      ]
      expect(suggestionFor('/p/a.zip', sources({ listings }))).toEqual({
        kind: 'install',
        extId: 'zips',
        name: 'Zips',
        files: '.zip',
        feature: 'browse',
        others: 0,
      })
    })

    it('offers to enable a turned-off extension with a browse kind, and asks for approval when the capability is missing', () => {
      expect(suggestionFor('/p/a.zip', sources({ extensions: [zips(false)] }))).toMatchObject({
        kind: 'enable',
        pending: false,
        feature: 'browse',
      })
      expect(
        suggestionFor('/p/a.zip', sources({ extensions: [zips(true, { granted: [] })] })),
      ).toMatchObject({ kind: 'enable', pending: true, feature: 'browse' })
    })

    it('stays quiet when an enabled, approved, granted browse kind serves the file', () => {
      expect(suggestionFor('/p/a.zip', sources({ extensions: [zips(true)] }))).toBeNull()
    })
  })
})

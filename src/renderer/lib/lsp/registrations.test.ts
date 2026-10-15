import { describe, expect, it } from 'vitest'
import {
  overlayCapabilities,
  parseRegistrations,
  parseUnregistrations,
  selectorMatches,
} from './registrations'

describe('parseRegistrations', () => {
  it('keeps registrations for supported methods and splits the selector from the options', () => {
    expect(
      parseRegistrations({
        registrations: [
          {
            id: 'a',
            method: 'textDocument/completion',
            registerOptions: {
              documentSelector: ['python', { scheme: 'file', pattern: '**/*.py' }, 7],
              triggerCharacters: ['.'],
            },
          },
          { id: 'b', method: 'textDocument/hover' },
          { id: 'c', method: 'workspace/didChangeWatchedFiles', registerOptions: {} },
          { id: 5, method: 'textDocument/hover' },
          'junk',
        ],
      }),
    ).toEqual([
      {
        id: 'a',
        method: 'textDocument/completion',
        options: { triggerCharacters: ['.'] },
        selector: [{ language: 'python' }, { scheme: 'file', pattern: '**/*.py' }, {}],
      },
      { id: 'b', method: 'textDocument/hover', options: {}, selector: null },
    ])
    expect(parseRegistrations(null)).toEqual([])
  })
})

describe('parseUnregistrations', () => {
  it('reads ids from the protocol’s misspelled key and from the corrected one', () => {
    expect(
      parseUnregistrations({ unregisterations: [{ id: 'a', method: 'm' }, { id: 4 }] }),
    ).toEqual(['a'])
    expect(parseUnregistrations({ unregistrations: [{ id: 'b', method: 'm' }] })).toEqual(['b'])
    expect(parseUnregistrations(undefined)).toEqual([])
  })
})

describe('overlayCapabilities', () => {
  it('lays registered features over the static ones and merges command lists', () => {
    const [completion, command] = parseRegistrations({
      registrations: [
        {
          id: 'a',
          method: 'textDocument/completion',
          registerOptions: { triggerCharacters: ['#'] },
        },
        { id: 'b', method: 'workspace/executeCommand', registerOptions: { commands: ['late'] } },
      ],
    })
    const base = { hoverProvider: true, executeCommandProvider: { commands: ['early'] } }
    expect(overlayCapabilities(base, [completion, command])).toEqual({
      hoverProvider: true,
      completionProvider: { triggerCharacters: ['#'] },
      executeCommandProvider: { commands: ['early', 'late'] },
    })
    expect(base.executeCommandProvider.commands).toEqual(['early'])
  })
})

describe('selectorMatches', () => {
  const document = { uri: 'file:///work/src/main.py', languageId: 'python' }

  it('matches everything without a selector and nothing with an empty one', () => {
    expect(selectorMatches(null, document)).toBe(true)
    expect(selectorMatches([], document)).toBe(false)
  })

  it('needs the language, scheme and glob of one filter to all match', () => {
    expect(selectorMatches([{ language: 'python' }], document)).toBe(true)
    expect(selectorMatches([{ language: 'go' }, { pattern: '**/*.py' }], document)).toBe(true)
    expect(selectorMatches([{ language: 'python', scheme: 'untitled' }], document)).toBe(false)
    expect(selectorMatches([{ pattern: '**/*.{ts,tsx}' }], document)).toBe(false)
    expect(selectorMatches([{ language: 'python' }], { ...document, languageId: undefined })).toBe(
      false,
    )
  })
})

import type * as Monaco from 'monaco-editor'
import { describe, expect, it } from 'vitest'
import { LARGE_FILE_CHARS, LARGE_FILE_LINES, fileFeatureOptions, isLargeModel } from './largeFile'

function sized(length: number, lines: number): Monaco.editor.ITextModel {
  return {
    getValueLength: () => length,
    getLineCount: () => lines,
  } as unknown as Monaco.editor.ITextModel
}

describe('isLargeModel', () => {
  it('flags a file over the size or the line limit', () => {
    expect(isLargeModel(sized(LARGE_FILE_CHARS, LARGE_FILE_LINES))).toBe(false)
    expect(isLargeModel(sized(LARGE_FILE_CHARS + 1, 1))).toBe(true)
    expect(isLargeModel(sized(10, LARGE_FILE_LINES + 1))).toBe(true)
  })
})

describe('fileFeatureOptions', () => {
  it('turns the costly features off for a large file and back on for any other', () => {
    expect(fileFeatureOptions(true)).toEqual({
      'semanticHighlighting.enabled': false,
      bracketPairColorization: { enabled: false },
      folding: false,
      occurrencesHighlight: 'off',
      wordBasedSuggestions: 'off',
      inlineSuggest: { enabled: false },
    })
    expect(fileFeatureOptions(false)).toEqual({
      'semanticHighlighting.enabled': true,
      bracketPairColorization: { enabled: true },
      folding: true,
      occurrencesHighlight: 'singleFile',
      wordBasedSuggestions: 'matchingDocuments',
      inlineSuggest: { enabled: true },
    })
  })
})

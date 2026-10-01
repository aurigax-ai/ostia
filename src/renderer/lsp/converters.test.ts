import { describe, expect, it, vi } from 'vitest'
import { createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const {
  toCompletion,
  toHover,
  toLocations,
  toLspPosition,
  toLspRange,
  toMarkers,
  toMonacoRange,
  toTextEdits,
} = await import('./converters')

const range = { start: { line: 1, character: 2 }, end: { line: 3, character: 4 } }
const monacoRange = { startLineNumber: 2, startColumn: 3, endLineNumber: 4, endColumn: 5 }
const fallback = { startLineNumber: 9, startColumn: 1, endLineNumber: 9, endColumn: 4 }

describe('positions and ranges', () => {
  it('converts between zero-based LSP and one-based editor coordinates', () => {
    expect(toMonacoRange(range)).toEqual(monacoRange)
    expect(toLspRange(monacoRange)).toEqual(range)
    expect(toLspPosition({ lineNumber: 5, column: 7 })).toEqual({ line: 4, character: 6 })
  })
})

describe('toMarkers', () => {
  it('maps severity, source, code and tags, and treats a missing severity as an error', () => {
    expect(
      toMarkers([
        { range, message: 'broken', severity: 1, source: 'tsc', code: 2322 },
        { range, message: 'careful', severity: 2, code: 'W1' },
        { range, message: 'fyi', severity: 3 },
        { range, message: 'hint', severity: 4, tags: [1, 2] },
        { range, message: 'unknown' },
      ]),
    ).toEqual([
      { ...monacoRange, severity: 8, message: 'broken', source: 'tsc', code: '2322' },
      { ...monacoRange, severity: 4, message: 'careful', code: 'W1' },
      { ...monacoRange, severity: 2, message: 'fyi' },
      { ...monacoRange, severity: 1, message: 'hint', tags: [1, 2] },
      { ...monacoRange, severity: 8, message: 'unknown' },
    ])
  })
})

describe('toCompletion', () => {
  it('inserts the label over the typed word when the server gives no edit', () => {
    const item = { label: 'alpha', kind: 3 as const, detail: 'fn', sortText: 'a', filterText: 'al' }
    expect(toCompletion(item, fallback)).toEqual({
      label: 'alpha',
      kind: 1,
      insertText: 'alpha',
      range: fallback,
      detail: 'fn',
      sortText: 'a',
      filterText: 'al',
      lspItem: item,
    })
  })

  it('uses the server’s text edit, its extra edits and snippet format', () => {
    const completion = toCompletion(
      {
        label: 'import',
        textEdit: { range, newText: 'imported(${1:x})' },
        insertTextFormat: 2,
        additionalTextEdits: [{ range, newText: 'use x\n' }],
        documentation: { kind: 'markdown', value: '**docs**' },
        preselect: true,
      },
      fallback,
    )
    expect(completion).toMatchObject({
      insertText: 'imported(${1:x})',
      range: monacoRange,
      insertTextRules: 4,
      additionalTextEdits: [{ range: monacoRange, text: 'use x\n' }],
      documentation: { value: '**docs**' },
      preselect: true,
    })
  })

  it('keeps separate insert and replace ranges, list defaults, label details and deprecation', () => {
    const completion = toCompletion(
      {
        label: 'old',
        labelDetails: { detail: '()', description: 'mod' },
        textEdit: { newText: 'old', insert: range, replace: range },
        tags: [1],
        documentation: 'plain',
      },
      fallback,
      { commitCharacters: ['.'], insertTextFormat: 2 },
    )
    expect(completion).toMatchObject({
      label: { label: 'old', detail: '()', description: 'mod' },
      range: { insert: monacoRange, replace: monacoRange },
      insertTextRules: 4,
      commitCharacters: ['.'],
      tags: [1],
      documentation: 'plain',
    })
  })
})

describe('toHover', () => {
  it('renders markdown, plain text, marked strings and lists', () => {
    expect(toHover({ contents: { kind: 'markdown', value: '**x**' }, range })).toEqual({
      contents: [{ value: '**x**' }],
      range: monacoRange,
    })
    expect(toHover({ contents: { kind: 'plaintext', value: 'a < b' } })).toEqual({
      contents: [{ value: '```text\na < b\n```' }],
    })
    expect(toHover({ contents: ['one', { language: 'ts', value: 'let x' }] })).toEqual({
      contents: [{ value: 'one' }, { value: '```ts\nlet x\n```' }],
    })
  })

  it('shows nothing for an empty answer', () => {
    expect(toHover(null)).toBeNull()
    expect(toHover({ contents: '' })).toBeNull()
    expect(toHover({ contents: [] })).toBeNull()
  })
})

describe('toLocations and toTextEdits', () => {
  it('accepts one location, a list, links and nothing', () => {
    expect(toLocations(null)).toEqual([])
    expect(
      toLocations({ uri: 'file:///p/a.ts', range }).map((l) => [l.uri.toString(), l.range]),
    ).toEqual([['file:///p/a.ts', monacoRange]])
    expect(
      toLocations([
        { targetUri: 'file:///p/b.ts', targetRange: range, targetSelectionRange: range },
      ]).map((l) => l.uri.toString()),
    ).toEqual(['file:///p/b.ts'])
  })

  it('turns LSP edits into editor edits', () => {
    expect(toTextEdits([{ range, newText: 'x' }])).toEqual([{ range: monacoRange, text: 'x' }])
    expect(toTextEdits(null)).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createFakeMonaco } from '../../../test/mocks/monaco'

const fake = createFakeMonaco()
vi.mock('../monaco/setup', () => ({ monaco: fake.monaco }))

const {
  markup,
  rangesOverlap,
  toCompletion,
  toDocumentSymbols,
  toHighlights,
  toFoldingRanges,
  toInlayHints,
  toSignatureHelp,
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

describe('symbols, signatures, highlights and hints', () => {
  it('keeps the hierarchy of document symbols and flattens symbol information', () => {
    expect(
      toDocumentSymbols([
        {
          name: 'Outer',
          kind: 5,
          range,
          selectionRange: range,
          children: [{ name: 'inner', kind: 6, range, selectionRange: range, detail: '()' }],
        },
      ]),
    ).toEqual([
      {
        name: 'Outer',
        detail: '',
        kind: 4,
        tags: [],
        range: monacoRange,
        selectionRange: monacoRange,
        children: [
          {
            name: 'inner',
            detail: '()',
            kind: 5,
            tags: [],
            range: monacoRange,
            selectionRange: monacoRange,
          },
        ],
      },
    ])
    expect(
      toDocumentSymbols([
        {
          name: 'old',
          kind: 12,
          deprecated: true,
          containerName: 'mod',
          location: { uri: 'file:///p/a.ts', range },
        },
      ]),
    ).toEqual([
      {
        name: 'old',
        detail: '',
        kind: 11,
        tags: [1],
        containerName: 'mod',
        range: monacoRange,
        selectionRange: monacoRange,
      },
    ])
    expect(toDocumentSymbols(null)).toEqual([])
  })

  it('maps signature help with documentation and label offsets', () => {
    expect(
      toSignatureHelp({
        signatures: [
          {
            label: 'f(a, b)',
            documentation: { kind: 'markdown', value: '**doc**' },
            parameters: [{ label: [2, 3] }, { label: 'b', documentation: 'second' }],
          },
        ],
        activeParameter: 1,
      }),
    ).toEqual({
      activeSignature: 0,
      activeParameter: 1,
      signatures: [
        {
          label: 'f(a, b)',
          documentation: { value: '**doc**' },
          parameters: [{ label: [2, 3] }, { label: 'b', documentation: 'second' }],
        },
      ],
    })
    expect(toSignatureHelp({ signatures: [] })).toBeNull()
    expect(toSignatureHelp(null)).toBeNull()
  })

  it('maps highlight kinds and inlay hints', () => {
    expect(toHighlights([{ range }, { range, kind: 3 }])).toEqual([
      { range: monacoRange, kind: 0 },
      { range: monacoRange, kind: 2 },
    ])
    expect(
      toInlayHints([
        { position: { line: 1, character: 4 }, label: ': number', kind: 1, paddingLeft: true },
        {
          position: { line: 0, character: 0 },
          label: [{ value: 'a' }, { value: ':' }],
          tooltip: 'tip',
        },
      ]),
    ).toEqual([
      { position: { lineNumber: 2, column: 5 }, label: ': number', kind: 1, paddingLeft: true },
      {
        position: { lineNumber: 1, column: 1 },
        label: [{ label: 'a' }, { label: ':' }],
        tooltip: 'tip',
      },
    ])
  })

  it('tells whether two ranges touch', () => {
    const at = (l1: number, c1: number, l2: number, c2: number) => ({
      start: { line: l1, character: c1 },
      end: { line: l2, character: c2 },
    })
    expect(rangesOverlap(at(1, 0, 1, 5), at(1, 5, 1, 9))).toBe(true)
    expect(rangesOverlap(at(1, 0, 1, 5), at(1, 6, 1, 9))).toBe(false)
    expect(rangesOverlap(at(0, 0, 3, 0), at(1, 2, 1, 3))).toBe(true)
    expect(rangesOverlap(at(2, 0, 2, 1), at(1, 0, 1, 9))).toBe(false)
  })
})

describe('toFoldingRanges', () => {
  it('maps lines to 1-based ones, keeps the kind and drops a range that folds nothing', () => {
    expect(
      toFoldingRanges([
        { startLine: 0, endLine: 4, kind: 'imports' },
        { startLine: 6, endLine: 6 },
        { startLine: 8, endLine: 9 },
      ]),
    ).toEqual([
      { start: 1, end: 5, kind: { value: 'imports' } },
      { start: 9, end: 10 },
    ])
    expect(toFoldingRanges(null)).toEqual([])
  })
})

describe('what an untrusted server cannot add', () => {
  const position = { line: 1, character: 2 }

  it('keeps only the text of an inlay hint label part', () => {
    const [hint] = toInlayHints([
      {
        position,
        label: [
          {
            value: 'x',
            command: { title: 'run', command: 'editor.action.selectAll', arguments: [1] },
            location: { uri: 'file:///etc/passwd', range },
            tooltip: 'tip',
          },
        ],
      },
    ])
    expect(hint.label).toEqual([{ label: 'x' }])
  })

  it('keeps inlay hint padding a real true or absent', () => {
    const hints = toInlayHints([
      { position, label: 'a', paddingLeft: false, paddingRight: false },
      { position, label: 'b', paddingLeft: 'yes' as unknown as boolean, kind: 0 as never },
    ])
    expect(Object.keys(hints[0]).sort()).toEqual(['label', 'position'])
    expect(hints[1]).toEqual({
      position: { lineNumber: 2, column: 3 },
      label: 'b',
      paddingLeft: true,
    })
  })

  it('shows a diagnostic code as text and never as a link', () => {
    const [marker] = toMarkers([
      { range, message: 'm', code: 'E1', codeDescription: { href: 'command:workspace.new' } },
    ])
    expect(marker.code).toBe('E1')
  })

  it('drops related information, unknown tags and a code that is not text', () => {
    const malformed = [
      { range, message: 'a', relatedInformation: [{ message: 'r' }] },
      { range, message: 'b', relatedInformation: 'x' },
      { range, message: 'c', tags: [99, -1] },
      { range, message: 'd', code: { toString: 1 } },
      { range, message: 'e', code: { a: 1 } },
    ] as unknown as Parameters<typeof toMarkers>[0]
    expect(toMarkers(malformed)).toEqual(
      ['a', 'b', 'c', 'd', 'e'].map((message) => ({ ...monacoRange, severity: 8, message })),
    )
  })

  it('reads the text of a diagnostic whose message is markup', () => {
    const diagnostics = [
      { range, message: { kind: 'markdown', value: '**m**' } },
    ] as unknown as Parameters<typeof toMarkers>[0]
    expect(toMarkers(diagnostics)[0].message).toBe('**m**')
  })

  it('treats an unknown severity as an error', () => {
    const diagnostics = [0, 99, '2'].map((severity) => ({ range, message: 'm', severity }))
    expect(
      toMarkers(diagnostics as unknown as Parameters<typeof toMarkers>[0]).map((m) => m.severity),
    ).toEqual([8, 8, 8])
  })

  it('renders plain text documentation as text, never as markdown', () => {
    const plain = { kind: 'plaintext' as const, value: '**not bold** [x](command:a)' }
    expect(markup(plain)).toBe(plain.value)
    expect(markup({ kind: 'html' as 'plaintext', value: '<b>x</b>' })).toBe('<b>x</b>')
    expect(toCompletion({ label: 'a', documentation: plain }, fallback).documentation).toBe(
      plain.value,
    )
    expect(toInlayHints([{ position, label: 'a', tooltip: plain }])[0].tooltip).toBe(plain.value)
    expect(
      toSignatureHelp({ signatures: [{ label: 'f()', documentation: plain }] })?.signatures[0]
        .documentation,
    ).toBe(plain.value)
  })

  it('never marks server markdown as trusted or lets it carry HTML', () => {
    const fromServer = { kind: 'markdown', value: 'x', isTrusted: true, supportHtml: true }
    expect(markup(fromServer as Parameters<typeof markup>[0])).toEqual({ value: 'x' })
    expect(toHover({ contents: fromServer as never })?.contents).toEqual([{ value: 'x' }])
  })

  it('opens a link at its selection range with the editor’s own Uri', () => {
    const targetRange = { start: { line: 10, character: 0 }, end: { line: 20, character: 0 } }
    const [location] = toLocations([
      { targetUri: 'file:///p/b.ts', targetRange, targetSelectionRange: range },
    ])
    expect(location.range).toEqual(monacoRange)
    expect(Object.keys(location).sort()).toEqual(['range', 'uri'])
    expect(location.uri).toBeInstanceOf(fake.monaco.Uri)
    expect(toLocations({ uri: 'file:///p/a.ts', range })[0].uri).toBeInstanceOf(fake.monaco.Uri)
  })

  it('clamps a symbol kind into the editor’s range', () => {
    const kinds = toDocumentSymbols(
      [1, 26, 0, -3, 999].map((kind) => ({
        name: 'n',
        kind: kind as never,
        range,
        selectionRange: range,
      })),
    ).map((symbol) => symbol.kind)
    expect(kinds).toEqual([0, 25, 0, 0, 25])
  })

  it('gives a folding range a kind only when the server named one', () => {
    expect(toFoldingRanges([{ startLine: 1, endLine: 5, kind: '' }])).toEqual([
      { start: 2, end: 6 },
    ])
  })
})

import type {
  CompletionItem,
  Diagnostic,
  DocumentHighlight,
  DocumentSymbol,
  Hover,
  InlayHint,
  InsertReplaceEdit,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  Range,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
} from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'

const SNIPPET_FORMAT = 2
const DEPRECATED_TAG = 1
const UNNECESSARY_TAG = 1
const DEPRECATED_DIAGNOSTIC_TAG = 2

export function toLspPosition(position: monaco.IPosition): Position {
  return { line: position.lineNumber - 1, character: position.column - 1 }
}

export function toLspRange(range: monaco.IRange): Range {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  }
}

export function toMonacoRange(range: Range): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

export function normalizeUri(uri: string): string {
  return monaco.Uri.parse(uri).toString()
}

export function markerSeverity(severity: number | undefined): monaco.MarkerSeverity {
  const S = monaco.MarkerSeverity
  if (severity === 1) return S.Error
  if (severity === 2) return S.Warning
  if (severity === 3) return S.Info
  return severity === 4 ? S.Hint : S.Error
}

function markerTags(tags: readonly number[] | undefined): monaco.MarkerTag[] {
  const out: monaco.MarkerTag[] = []
  if (tags?.includes(UNNECESSARY_TAG)) out.push(monaco.MarkerTag.Unnecessary)
  if (tags?.includes(DEPRECATED_DIAGNOSTIC_TAG)) out.push(monaco.MarkerTag.Deprecated)
  return out
}

export function toMarkers(diagnostics: readonly Diagnostic[]): monaco.editor.IMarkerData[] {
  return diagnostics.map((diagnostic) => {
    const tags = markerTags(diagnostic.tags)
    return {
      ...toMonacoRange(diagnostic.range),
      severity: markerSeverity(diagnostic.severity),
      message:
        typeof diagnostic.message === 'string'
          ? diagnostic.message
          : (diagnostic.message as MarkupContent).value,
      ...(diagnostic.source ? { source: diagnostic.source } : {}),
      ...(typeof diagnostic.code === 'string' || typeof diagnostic.code === 'number'
        ? { code: String(diagnostic.code) }
        : {}),
      ...(tags.length > 0 ? { tags } : {}),
    }
  })
}

export function completionKind(kind: number | undefined): monaco.languages.CompletionItemKind {
  const K = monaco.languages.CompletionItemKind
  const kinds: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text,
    2: K.Method,
    3: K.Function,
    4: K.Constructor,
    5: K.Field,
    6: K.Variable,
    7: K.Class,
    8: K.Interface,
    9: K.Module,
    10: K.Property,
    11: K.Unit,
    12: K.Value,
    13: K.Enum,
    14: K.Keyword,
    15: K.Snippet,
    16: K.Color,
    17: K.File,
    18: K.Reference,
    19: K.Folder,
    20: K.EnumMember,
    21: K.Constant,
    22: K.Struct,
    23: K.Event,
    24: K.Operator,
    25: K.TypeParameter,
  }
  return (kind !== undefined && kinds[kind]) || K.Text
}

export function markup(
  value: string | MarkupContent | undefined,
): string | monaco.IMarkdownString | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return value.kind === 'markdown' ? { value: value.value } : value.value
}

function completionRange(
  edit: TextEdit | InsertReplaceEdit | undefined,
  fallback: monaco.IRange,
): monaco.IRange | monaco.languages.CompletionItemRanges {
  if (!edit) return fallback
  if ('insert' in edit) {
    return { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) }
  }
  return toMonacoRange(edit.range)
}

export function toTextEdits(
  edits: readonly TextEdit[] | null | undefined,
): monaco.languages.TextEdit[] {
  return (edits ?? []).map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }))
}

export interface LspCompletion extends monaco.languages.CompletionItem {
  lspItem: CompletionItem
}

export function toCompletion(
  item: CompletionItem,
  fallback: monaco.IRange,
  defaults: { commitCharacters?: string[]; insertTextFormat?: number } = {},
): LspCompletion {
  const format = item.insertTextFormat ?? defaults.insertTextFormat
  const commitCharacters = item.commitCharacters ?? defaults.commitCharacters
  const documentation = markup(item.documentation)
  return {
    label: item.labelDetails
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label,
    kind: completionKind(item.kind),
    insertText: item.textEdit?.newText ?? item.insertText ?? item.label,
    range: completionRange(item.textEdit, fallback),
    ...(format === SNIPPET_FORMAT
      ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
      : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
    ...(item.filterText ? { filterText: item.filterText } : {}),
    ...(item.preselect ? { preselect: true } : {}),
    ...(commitCharacters ? { commitCharacters } : {}),
    ...(item.additionalTextEdits
      ? { additionalTextEdits: toTextEdits(item.additionalTextEdits) }
      : {}),
    ...(item.tags?.includes(DEPRECATED_TAG) || item.deprecated
      ? { tags: [monaco.languages.CompletionItemTag.Deprecated] }
      : {}),
    lspItem: item,
  }
}

export function hoverContents(contents: Hover['contents']): monaco.IMarkdownString[] {
  const one = (part: string | { language?: string; value: string }): string => {
    if (typeof part === 'string') return part
    return part.language ? `\`\`\`${part.language}\n${part.value}\n\`\`\`` : part.value
  }
  if (Array.isArray(contents)) return contents.map((part) => ({ value: one(part) }))
  if (typeof contents === 'string') return [{ value: contents }]
  if ('kind' in contents) {
    return [
      {
        value:
          contents.kind === 'markdown' ? contents.value : `\`\`\`text\n${contents.value}\n\`\`\``,
      },
    ]
  }
  return [{ value: one(contents) }]
}

export function toHover(hover: Hover | null | undefined): monaco.languages.Hover | null {
  if (!hover?.contents) return null
  const contents = hoverContents(hover.contents).filter((part) => part.value !== '')
  if (contents.length === 0) return null
  return { contents, ...(hover.range ? { range: toMonacoRange(hover.range) } : {}) }
}

export function toLocations(
  result: Location | Location[] | LocationLink[] | null | undefined,
): monaco.languages.Location[] {
  if (!result) return []
  const list = Array.isArray(result) ? result : [result]
  return list.map((location) =>
    'targetUri' in location
      ? {
          uri: monaco.Uri.parse(location.targetUri),
          range: toMonacoRange(location.targetSelectionRange),
        }
      : { uri: monaco.Uri.parse(location.uri), range: toMonacoRange(location.range) },
  )
}

export function symbolKind(kind: number): monaco.languages.SymbolKind {
  return Math.max(0, Math.min(25, kind - 1)) as monaco.languages.SymbolKind
}

function symbolTags(
  tags: readonly number[] | undefined,
  deprecated: boolean | undefined,
): monaco.languages.SymbolTag[] {
  return deprecated || tags?.includes(DEPRECATED_TAG) ? [monaco.languages.SymbolTag.Deprecated] : []
}

export function toDocumentSymbols(
  result: readonly (DocumentSymbol | SymbolInformation)[] | null | undefined,
): monaco.languages.DocumentSymbol[] {
  return (result ?? []).map((symbol): monaco.languages.DocumentSymbol => {
    if ('location' in symbol) {
      const range = toMonacoRange(symbol.location.range)
      return {
        name: symbol.name,
        detail: '',
        kind: symbolKind(symbol.kind),
        tags: symbolTags(symbol.tags, symbol.deprecated),
        ...(symbol.containerName ? { containerName: symbol.containerName } : {}),
        range,
        selectionRange: range,
      }
    }
    return {
      name: symbol.name,
      detail: symbol.detail ?? '',
      kind: symbolKind(symbol.kind),
      tags: symbolTags(symbol.tags, symbol.deprecated),
      range: toMonacoRange(symbol.range),
      selectionRange: toMonacoRange(symbol.selectionRange),
      ...(symbol.children ? { children: toDocumentSymbols(symbol.children) } : {}),
    }
  })
}

export function toSignatureHelp(
  help: SignatureHelp | null | undefined,
): monaco.languages.SignatureHelp | null {
  if (!help || help.signatures.length === 0) return null
  return {
    activeSignature: help.activeSignature ?? 0,
    activeParameter: help.activeParameter ?? 0,
    signatures: help.signatures.map((signature) => {
      const documentation = markup(signature.documentation)
      return {
        label: signature.label,
        ...(documentation !== undefined ? { documentation } : {}),
        ...(typeof signature.activeParameter === 'number'
          ? { activeParameter: signature.activeParameter }
          : {}),
        parameters: (signature.parameters ?? []).map((parameter) => {
          const parameterDocumentation = markup(parameter.documentation)
          return {
            label: parameter.label,
            ...(parameterDocumentation !== undefined
              ? { documentation: parameterDocumentation }
              : {}),
          }
        }),
      }
    }),
  }
}

export function toHighlights(
  list: readonly DocumentHighlight[] | null | undefined,
): monaco.languages.DocumentHighlight[] {
  return (list ?? []).map((highlight) => ({
    range: toMonacoRange(highlight.range),
    kind: Math.max(0, (highlight.kind ?? 1) - 1) as monaco.languages.DocumentHighlightKind,
  }))
}

export function toInlayHints(
  list: readonly InlayHint[] | null | undefined,
): monaco.languages.InlayHint[] {
  return (list ?? []).map((hint) => {
    const tooltip = markup(hint.tooltip)
    return {
      position: { lineNumber: hint.position.line + 1, column: hint.position.character + 1 },
      label:
        typeof hint.label === 'string'
          ? hint.label
          : hint.label.map((part) => ({ label: part.value })),
      ...(hint.kind ? { kind: hint.kind as monaco.languages.InlayHintKind } : {}),
      ...(tooltip !== undefined ? { tooltip } : {}),
      ...(hint.paddingLeft ? { paddingLeft: true } : {}),
      ...(hint.paddingRight ? { paddingRight: true } : {}),
      ...(hint.textEdits ? { textEdits: toTextEdits(hint.textEdits) } : {}),
    }
  })
}

export function rangesOverlap(a: Range, b: Range): boolean {
  const before = (x: Position, y: Position): boolean =>
    x.line < y.line || (x.line === y.line && x.character < y.character)
  return !before(a.end, b.start) && !before(b.end, a.start)
}

import type * as Monaco from 'monaco-editor'

export const LARGE_FILE_CHARS = 4 * 1024 * 1024
export const LARGE_FILE_LINES = 50_000

export function isLargeModel(model: Monaco.editor.ITextModel): boolean {
  return model.getValueLength() > LARGE_FILE_CHARS || model.getLineCount() > LARGE_FILE_LINES
}

export function fileFeatureOptions(
  large: boolean,
): Monaco.editor.IEditorOptions & Monaco.editor.IGlobalEditorOptions {
  return {
    'semanticHighlighting.enabled': !large,
    bracketPairColorization: { enabled: !large },
    folding: !large,
    occurrencesHighlight: large ? 'off' : 'singleFile',
    wordBasedSuggestions: large ? 'off' : 'matchingDocuments',
    inlineSuggest: { enabled: !large },
  }
}

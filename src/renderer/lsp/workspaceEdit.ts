import type { TextEdit, WorkspaceEdit } from 'vscode-languageserver-protocol'
import { monaco } from '../monaco/setup'
import { normalizeUri, toMonacoRange } from './converters'

export function textEditsByUri(edit: WorkspaceEdit): Map<string, TextEdit[]> | null {
  const byUri = new Map<string, TextEdit[]>()
  const add = (uri: string, edits: readonly TextEdit[]): void => {
    const key = normalizeUri(uri)
    byUri.set(key, [...(byUri.get(key) ?? []), ...edits])
  }
  for (const change of edit.documentChanges ?? []) {
    if (!('textDocument' in change)) return null
    const edits: TextEdit[] = []
    for (const e of change.edits) {
      if (!('newText' in e)) return null
      edits.push({ range: e.range, newText: e.newText })
    }
    add(change.textDocument.uri, edits)
  }
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits)
  return byUri
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const starts = lineStarts(text)
  const offset = (line: number, character: number): number => {
    if (line >= starts.length) return text.length
    const end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
    return Math.min(starts[line] + character, end)
  }
  const ordered = edits
    .map((edit, index) => ({
      start: offset(edit.range.start.line, edit.range.start.character),
      end: offset(edit.range.end.line, edit.range.end.character),
      text: edit.newText,
      index,
    }))
    .sort((a, b) => b.start - a.start || b.index - a.index)
  let out = text
  for (const edit of ordered) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  return out
}

function openModel(uri: string): monaco.editor.ITextModel | null {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri))
  return model && !model.isDisposed() ? model : null
}

export function openModelEdits(
  byUri: ReadonlyMap<string, TextEdit[]>,
): monaco.languages.WorkspaceEdit {
  const edits: monaco.languages.IWorkspaceTextEdit[] = []
  for (const [uri, list] of byUri) {
    const model = openModel(uri)
    if (!model) continue
    for (const edit of list) {
      edits.push({
        resource: model.uri,
        textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
        versionId: undefined,
      })
    }
  }
  return { edits }
}

export async function applyClosedFileEdits(
  byUri: ReadonlyMap<string, TextEdit[]>,
): Promise<boolean> {
  let applied = true
  for (const [uri, list] of byUri) {
    if (openModel(uri)) continue
    const path = monaco.Uri.parse(uri).path
    const text = await window.pine.fs.read(path)
    if (text === null || !(await window.pine.fs.write(path, applyTextEdits(text, list)))) {
      applied = false
    }
  }
  return applied
}

export async function applyWorkspaceEdit(edit: WorkspaceEdit): Promise<boolean> {
  const byUri = textEditsByUri(edit)
  if (byUri === null) return false
  for (const [uri, list] of byUri) {
    const model = openModel(uri)
    if (!model) continue
    model.pushEditOperations(
      [],
      list.map((e) => ({ range: toMonacoRange(e.range), text: e.newText })),
      () => null,
    )
  }
  return applyClosedFileEdits(byUri)
}

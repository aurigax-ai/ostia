import type * as Monaco from 'monaco-editor'

const holders = new Map<Monaco.editor.ITextModel, number>()

export function holdModel(
  model: Monaco.editor.ITextModel,
  isDirty: (model: Monaco.editor.ITextModel) => boolean,
): () => void {
  holders.set(model, (holders.get(model) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const left = (holders.get(model) ?? 1) - 1
    if (left > 0) {
      holders.set(model, left)
      return
    }
    holders.delete(model)
    if (!model.isDisposed() && !isDirty(model)) model.dispose()
  }
}

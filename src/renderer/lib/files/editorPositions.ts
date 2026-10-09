export interface EditorPosition {
  file: string
  line: number
  column: number
}

type PositionSource = () => EditorPosition | null

const sources = new Map<string, PositionSource>()

export function registerEditorPosition(paneId: string, source: PositionSource): () => void {
  sources.set(paneId, source)
  return () => {
    if (sources.get(paneId) === source) sources.delete(paneId)
  }
}

export function editorPositionOf(paneId: string): EditorPosition | null {
  return sources.get(paneId)?.() ?? null
}

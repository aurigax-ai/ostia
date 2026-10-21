import { parseRemotePath } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import { langFor } from '@/lib/monaco/language'
import { holdModel } from '@/lib/monaco/modelHolds'
import { monaco } from '@/lib/monaco/setup'
import { useEditorStatus } from '@/stores/files/editorStatusStore'

export const savedVersions = new Map<string, number>()
export const diskBase = new Map<string, string | null>()
export const diskVersions = new Map<string, string>()

export function setDiskBase(key: string, text: string | null, version: string | null = null): void {
  diskBase.set(key, text)
  if (version === null) diskVersions.delete(key)
  else diskVersions.set(key, version)
}
export async function unchangedOnDisk(key: string, filePath: string): Promise<boolean> {
  const known = diskVersions.get(key)
  return known !== undefined && (await window.ostia.fs.version(filePath)) === known
}

export const remoteVersions = new Map<string, string | null>()

export function isDirty(model: monaco.editor.ITextModel): boolean {
  return savedVersions.get(model.uri.toString()) !== model.getAlternativeVersionId()
}

export function markSaved(model: monaco.editor.ITextModel, filePath: string): void {
  savedVersions.set(model.uri.toString(), model.getAlternativeVersionId())
  useEditorStatus.getState().setDirty(filePath, false)
}

const modelPaths = new WeakMap<monaco.editor.ITextModel, string>()

export function pathOf(model: monaco.editor.ITextModel): string {
  return modelPaths.get(model) ?? model.uri.path
}

export function uriFor(filePath: string): monaco.Uri {
  const remote = parseRemotePath(filePath)
  return remote
    ? monaco.Uri.from({ scheme: 'remote', authority: remote.folderId, path: remote.path })
    : monaco.Uri.file(filePath)
}

export function createTrackedModel(filePath: string, content: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(content, langFor(filePath), uriFor(filePath))
  modelPaths.set(model, filePath)
  markSaved(model, filePath)
  model.onDidChangeContent(() => useEditorStatus.getState().setDirty(filePath, isDirty(model)))
  model.onWillDispose(() => {
    savedVersions.delete(model.uri.toString())
    diskBase.delete(model.uri.toString())
    remoteVersions.delete(model.uri.toString())
    diskVersions.delete(model.uri.toString())
    useEditorStatus.getState().setDirty(filePath, false)
  })
  return model
}

export function holdShown(
  held: { current: () => void },
  model: monaco.editor.ITextModel | null,
): void {
  const previous = held.current
  held.current = model ? holdModel(model, isDirty) : () => {}
  previous()
}

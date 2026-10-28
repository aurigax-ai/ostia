import { setFetchedEditorLanguages } from './fetchedLanguages'
import { setContributedLanguages } from './language'

type MonacoRuntime = typeof import('./monacoRuntime')

let runtime: MonacoRuntime | null = null
let loading: Promise<MonacoRuntime> | null = null

export function loadedMonaco(): MonacoRuntime | null {
  return runtime
}

export function loadMonaco(): Promise<MonacoRuntime> {
  loading ??= import('./monacoRuntime')
    .then(async (loaded) => {
      runtime = loaded
      await loaded.monacoReady
      return loaded
    })
    .catch((err: unknown) => {
      loading = null
      throw err
    })
  return loading
}

export async function loadEditorLanguages(): Promise<void> {
  const languages = await window.ostia.editorLanguages.load()
  setFetchedEditorLanguages(languages)
  setContributedLanguages(languages)
  runtime?.applyEditorLanguages(languages)
}

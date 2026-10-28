import { startLanguageServices } from '@/lib/lsp/client'
import { registerSettingsSchema } from '@/lib/settings/registerSettingsSchema'
import { currentScheme } from '@/lib/theme/colorScheme'
import { applyEditorLanguages } from './contributedLanguages'
import { fetchedEditorLanguages } from './fetchedLanguages'
import { applyMonacoScheme } from './monacoScheme'

export { monaco } from './setup'
export { applyEditorLanguages, applyMonacoScheme, registerSettingsSchema }

export const monacoReady: Promise<unknown> = (async () => {
  applyEditorLanguages(fetchedEditorLanguages())
  applyMonacoScheme(currentScheme('editor'))
  return Promise.allSettled([registerSettingsSchema(), startLanguageServices()])
})()

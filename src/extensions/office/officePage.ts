import {
  type LoadedViewerBytes,
  loadViewerBytes,
  showViewerMessage,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { OFFICE_LIMITS, officeProblemText } from './officeLimits'

export async function loadOfficeBytes(root: HTMLElement): Promise<LoadedViewerBytes | null> {
  const loaded = await loadViewerBytes({
    root,
    catalogs: { en: en.messages, 'zh-Hant': zhHant.messages },
    tooLarge: (t, _size, locale) => officeProblemText(t, 'too-large', locale),
  })
  if (loaded && loaded.bytes.byteLength > OFFICE_LIMITS.fileBytes) {
    showViewerMessage(root, officeProblemText(loaded.t, 'too-large', loaded.doc.locale))
    return null
  }
  return loaded
}

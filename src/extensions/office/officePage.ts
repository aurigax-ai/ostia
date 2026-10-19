import { type LoadedViewerBytes, loadViewerBytes } from '@aurigax-ai/ostia-extension-sdk/viewer'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { officeProblemText } from './officeLimits'

export function loadOfficeBytes(root: HTMLElement): Promise<LoadedViewerBytes | null> {
  return loadViewerBytes({
    root,
    catalogs: { en: en.messages, 'zh-Hant': zhHant.messages },
    tooLarge: (t, _size, locale) => officeProblemText(t, 'too-large', locale),
  })
}

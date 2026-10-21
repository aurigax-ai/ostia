import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  formatMegabytes,
  openViewerDocument,
  showViewerMessage,
  ViewerDocumentError,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import './typeset.css'
import { createPreview, type PreviewView } from './view'

const root = document.getElementById('root') as HTMLElement

async function main(): Promise<void> {
  const doc = await openViewerDocument().catch(() => null)
  const t = translatorFor({ en: en.messages, 'zh-Hant': zhHant.messages }, doc?.locale ?? 'en')
  if (!doc) {
    showViewerMessage(root, t('unreadable'))
    return
  }
  let view: PreviewView | null = null

  const fail = (error: unknown): void => {
    view?.destroy()
    view = null
    const problem = error instanceof ViewerDocumentError ? error.problem : 'unreadable'
    const size = error instanceof ViewerDocumentError ? (error.size ?? 0) : 0
    const messages = {
      'too-large': t('tooLarge', { size: formatMegabytes(size, doc.locale) }),
      gone: t('gone'),
      unreadable: t('unreadable'),
    }
    showViewerMessage(root, messages[problem])
  }
  const refresh = async (): Promise<void> => {
    try {
      const text = new TextDecoder().decode(await doc.bytes())
      view ??= createPreview(root, t)
      view.show(text)
    } catch (error) {
      fail(error)
    }
  }

  doc.onDidChange(() => void refresh())
  showViewerMessage(root, t('loading'))
  await refresh()
}

void main()

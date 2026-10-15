import { translatorFor } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import {
  ViewerDocumentError,
  openViewerDocument,
  runWorker,
} from '@aurigax-ai/ostia-extension-sdk/viewer'
import type { DocumentResult } from './docModel'
import { sanitizeDocument } from './documentHtml'
import en from './locales/en.json'
import zhHant from './locales/zh-Hant.json'
import { OFFICE_LIMITS, type OfficeProblem } from './officeLimits'

type Translate = (key: string, vars?: Record<string, string | number>) => string

const root = document.getElementById('root') as HTMLElement

function message(text: string): void {
  const el = document.createElement('div')
  el.className = 'message'
  el.textContent = text
  root.replaceChildren(el)
}

function problemText(t: Translate, problem: OfficeProblem, locale: string): string {
  const limit = problem === 'too-large' ? OFFICE_LIMITS.fileBytes : OFFICE_LIMITS.inflatedBytes
  return t(problem, {
    limit: new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'megabyte',
      maximumFractionDigits: 1,
    }).format(limit / 1e6),
    cells: OFFICE_LIMITS.cells.toLocaleString(locale),
  })
}

async function main(): Promise<void> {
  const doc = await openViewerDocument().catch(() => null)
  const locale = doc?.locale ?? 'en'
  const t: Translate = translatorFor({ en: en.messages, 'zh-Hant': zhHant.messages }, locale)
  if (!doc) {
    message(t('unreadable'))
    return
  }
  doc.onDidChange(() => location.reload())
  message(t('loading'))
  let bytes: Uint8Array
  try {
    bytes = await doc.bytes()
  } catch (error) {
    const problem = error instanceof ViewerDocumentError ? error.problem : 'unreadable'
    message(problem === 'too-large' ? problemText(t, 'too-large', locale) : t(problem))
    return
  }
  const copy = bytes.slice()
  const outcome = await runWorker<DocumentResult>(
    'document.worker.js',
    { bytes: copy.buffer },
    [copy.buffer],
    OFFICE_LIMITS.parseMs,
  )
  const result = outcome.ok ? outcome.value : { ok: false as const, problem: outcome.problem }
  if (!result.ok) {
    message(problemText(t, result.problem, locale))
    return
  }
  const article = document.createElement('article')
  article.append(sanitizeDocument(result.html))
  const children: Node[] = []
  if (result.imagesDropped > 0) {
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = t('imagesDropped', { count: result.imagesDropped })
    children.push(note)
  }
  if (!article.textContent?.trim() && !article.querySelector('img')) {
    message(t('documentEmpty'))
    return
  }
  root.replaceChildren(...children, article)
}

void main()

import { runWorker, showViewerMessage } from '@aurigax-ai/ostia-extension-sdk/viewer'
import type { DocumentResult } from './docModel'
import { sanitizeDocument } from './documentHtml'
import { OFFICE_LIMITS, officeProblemText } from './officeLimits'
import { loadOfficeBytes } from './officePage'
import { outlineWords } from './outlineHtml'

const root = document.getElementById('root') as HTMLElement
const presentation = document.body.dataset.viewer === 'presentation'

function note(text: string): HTMLElement {
  const el = document.createElement('p')
  el.className = 'note'
  el.textContent = text
  return el
}

async function main(): Promise<void> {
  const loaded = await loadOfficeBytes(root)
  if (!loaded) return
  const { doc, t, bytes } = loaded
  const outcome = await runWorker<DocumentResult>(
    presentation ? 'presentation.worker.js' : 'document.worker.js',
    { bytes, words: outlineWords(t) },
    [bytes],
    OFFICE_LIMITS.parseMs,
  )
  const result = outcome.ok ? outcome.value : { ok: false as const, problem: outcome.problem }
  if (!result.ok) {
    showViewerMessage(root, officeProblemText(t, result.problem, doc.locale))
    return
  }
  const article = document.createElement('article')
  article.append(sanitizeDocument(result.html))
  const children: Node[] = []
  if (result.imagesDropped > 0) {
    children.push(note(t('imagesDropped', { count: result.imagesDropped })))
  }
  if (result.slidesCut > 0) {
    children.push(note(t('slidesCut', { slides: result.slidesCut.toLocaleString(doc.locale) })))
  }
  if (result.textCut) children.push(note(t('outlineCut')))
  if (!article.textContent?.trim() && !article.querySelector('img')) {
    showViewerMessage(root, presentation ? t('presentationEmpty') : t('documentEmpty'))
    return
  }
  root.replaceChildren(...children, article)
}

void main()

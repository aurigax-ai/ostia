import { runWorker, showViewerMessage } from '@aurigax-ai/ostia-extension-sdk/viewer'
import type { DocumentResult } from './docModel'
import { sanitizeDocument } from './documentHtml'
import { OFFICE_LIMITS, officeProblemText } from './officeLimits'
import { loadOfficeBytes } from './officePage'

const root = document.getElementById('root') as HTMLElement

async function main(): Promise<void> {
  const loaded = await loadOfficeBytes(root)
  if (!loaded) return
  const { doc, t, bytes } = loaded
  const outcome = await runWorker<DocumentResult>(
    'document.worker.js',
    { bytes },
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
    const note = document.createElement('p')
    note.className = 'note'
    note.textContent = t('imagesDropped', { count: result.imagesDropped })
    children.push(note)
  }
  if (!article.textContent?.trim() && !article.querySelector('img')) {
    showViewerMessage(root, t('documentEmpty'))
    return
  }
  root.replaceChildren(...children, article)
}

void main()

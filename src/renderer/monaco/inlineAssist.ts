import { assistProvider, assistRequest } from '@/stores/assist/assistStore'
import {
  COMPLETION_NEIGHBOR_TEXT_MAX,
  COMPLETION_PREFIX_MAX,
  COMPLETION_SUFFIX_MAX,
  type CompletionAssistRequest,
} from '@shared/assist'
import type * as Monaco from 'monaco-editor'
import { isLargeModel } from './largeFile'

export const INLINE_DEBOUNCE_MS = 300
const NEIGHBORS = 2

export interface OpenDocument {
  path: string
  language: string
  text: string
}

export function buildCompletionRequest(
  doc: OpenDocument,
  offset: number,
  others: OpenDocument[],
): CompletionAssistRequest {
  const request: CompletionAssistRequest = {
    path: doc.path,
    language: doc.language,
    prefix: doc.text.slice(Math.max(0, offset - COMPLETION_PREFIX_MAX), offset),
    suffix: doc.text.slice(offset, offset + COMPLETION_SUFFIX_MAX),
  }
  const neighbors = others
    .filter((o) => o.path !== doc.path && o.text.trim())
    .sort((a, b) => Number(b.language === doc.language) - Number(a.language === doc.language))
    .slice(0, NEIGHBORS)
    .map((o) => ({ path: o.path, text: o.text.slice(0, COMPLETION_NEIGHBOR_TEXT_MAX) }))
  if (neighbors.length > 0) request.neighbors = neighbors
  return request
}

export function latestPerEditor<K extends object>() {
  const live = new WeakMap<K, AbortController>()
  return {
    begin(key: K): AbortController {
      live.get(key)?.abort()
      const controller = new AbortController()
      live.set(key, controller)
      return controller
    },
    end(key: K, controller: AbortController): void {
      if (live.get(key) === controller) live.delete(key)
    },
  }
}

function documentOf(model: Monaco.editor.ITextModel): OpenDocument {
  return { path: model.uri.path, language: model.getLanguageId(), text: model.getValue() }
}

let registered = false

export function registerInlineAssist(monaco: typeof Monaco): void {
  if (registered) return
  registered = true
  const requests = latestPerEditor<Monaco.editor.ITextModel>()
  monaco.languages.registerInlineCompletionsProvider('*', {
    debounceDelayMs: INLINE_DEBOUNCE_MS,
    displayName: 'Assistant',
    provideInlineCompletions: async (model, position, _context, token) => {
      if (!assistProvider('completion') || model.uri.scheme !== 'file') return { items: [] }
      const others = monaco.editor
        .getModels()
        .filter((m) => m !== model && m.uri.scheme === 'file' && !isLargeModel(m))
        .map(documentOf)
      const request = buildCompletionRequest(documentOf(model), model.getOffsetAt(position), others)
      const abort = requests.begin(model)
      const sub = token.onCancellationRequested(() => abort.abort())
      try {
        const res = await assistRequest('completion', request, { signal: abort.signal })
        if (!res.ok || abort.signal.aborted || token.isCancellationRequested || !res.result.text) {
          return { items: [] }
        }
        return {
          items: [
            {
              insertText: res.result.text,
              range: new monaco.Range(
                position.lineNumber,
                position.column,
                position.lineNumber,
                position.column,
              ),
            },
          ],
        }
      } finally {
        sub.dispose()
        requests.end(model, abort)
      }
    },
    disposeInlineCompletions: () => {},
  })
}

import type { IDisposable, IFunctionIdentifier, IParser } from '@xterm/xterm'

const WINDOW_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21, 22, 23])
const COLOR_QUERIES = [4, 10, 11, 12, 17, 19]

const CSI_QUERIES: {
  id: IFunctionIdentifier
  when?: (params: (number | number[])[]) => boolean
}[] = [
  { id: { final: 'n' } },
  { id: { prefix: '?', final: 'n' } },
  { id: { final: 'c' } },
  { id: { prefix: '>', final: 'c' } },
  { id: { prefix: '=', final: 'c' } },
  { id: { intermediates: '$', final: 'p' } },
  { id: { prefix: '?', intermediates: '$', final: 'p' } },
  { id: { prefix: '>', final: 'q' } },
  { id: { final: 't' }, when: (params) => WINDOW_REPORTS.has(Number(params[0] ?? 0)) },
]

export function silenceQueryReplies(term: { parser: IParser }): IDisposable {
  const handlers: IDisposable[] = [
    ...CSI_QUERIES.map(({ id, when }) =>
      term.parser.registerCsiHandler(id, (params) => (when ? when([...params]) : true)),
    ),
    ...COLOR_QUERIES.map((ident) =>
      term.parser.registerOscHandler(ident, (data) => data.split(';').includes('?')),
    ),
    term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true),
  ]
  return {
    dispose: () => {
      for (const handler of handlers) handler.dispose()
    },
  }
}

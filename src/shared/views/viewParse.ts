import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { parseLocatedJson } from '../common/jsonLocated'
import { Checker } from './viewChecker'
import {
  VIEW_ICONS,
  VIEW_PLACEMENTS,
  VIEW_SOURCES,
  VIEW_TITLE_MAX,
  VIEW_VERSION,
  type ViewParseResult,
} from './views'

const DOC_KEYS = ['$schema', 'version', 'title', 'placement', 'icon', 'description', 'root']

function parseViewValue(raw: unknown, lines = new Map<string, number>()): ViewParseResult {
  const c = new Checker(lines)
  if (!isRecord(raw)) {
    c.report('', 'a view file must be a JSON object')
    return { ok: false, problems: c.problems }
  }
  c.keys(raw, '', DOC_KEYS)
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') {
    c.report('$schema', 'must be a string')
  }
  if (raw.version !== VIEW_VERSION) c.report('version', `must be ${VIEW_VERSION}`)
  const empty = new Set<string>()
  let title = ''
  if (typeof raw.title !== 'string' || !raw.title.trim()) c.report('title', 'is required')
  else if (raw.title.length > VIEW_TITLE_MAX) {
    c.report('title', `longer than ${VIEW_TITLE_MAX} characters`)
  } else title = raw.title
  const placement = c.oneOf(raw, 'placement', '', VIEW_PLACEMENTS)
  if (raw.placement === undefined) c.report('placement', 'is required (sidebar or panel)')
  const icon = c.oneOf(raw, 'icon', '', VIEW_ICONS)
  let description: string | undefined
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string' || raw.description.length > 200) {
      c.report('description', 'must be a string of at most 200 characters')
    } else description = raw.description
  }
  const root = raw.root === undefined ? null : c.node(raw.root, 'root', 1, empty)
  if (raw.root === undefined) c.report('root', 'is required')
  if (c.problems.length > 0 || !root || !placement) return { ok: false, problems: c.problems }
  return {
    ok: true,
    doc: {
      version: VIEW_VERSION,
      title,
      placement,
      ...(icon ? { icon } : {}),
      ...(description ? { description } : {}),
      root,
      sources: VIEW_SOURCES.filter((s) => c.sources.has(s)),
      ticks: c.ticks,
    },
  }
}

export function parseViewText(text: string): ViewParseResult {
  const located = parseLocatedJson(text)
  if ('message' in located) {
    return {
      ok: false,
      problems: [
        {
          path: '(document)',
          line: located.line,
          message: `invalid JSON at column ${located.column}: ${located.message}`,
        },
      ],
    }
  }
  return parseViewValue(located.value, located.lines)
}

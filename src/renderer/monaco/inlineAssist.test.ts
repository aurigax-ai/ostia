import { COMPLETION_NEIGHBOR_TEXT_MAX, COMPLETION_PREFIX_MAX } from '@shared/assist'
import { describe, expect, it } from 'vitest'
import { buildCompletionRequest } from './inlineAssist'

describe('buildCompletionRequest', () => {
  const doc = {
    path: '/p/a.ts',
    language: 'typescript',
    text: 'const a = 1\nconst b = \nexport {}',
  }

  it('splits the document at the cursor into prefix and suffix', () => {
    const offset = doc.text.indexOf('\nexport')
    expect(buildCompletionRequest(doc, offset, [])).toEqual({
      path: '/p/a.ts',
      language: 'typescript',
      prefix: 'const a = 1\nconst b = ',
      suffix: '\nexport {}',
    })
  })

  it('keeps the tail of a long prefix', () => {
    const long = { ...doc, text: `${'x'.repeat(COMPLETION_PREFIX_MAX + 50)}END` }
    const req = buildCompletionRequest(long, long.text.length, [])
    expect(req.prefix).toHaveLength(COMPLETION_PREFIX_MAX)
    expect(req.prefix.endsWith('END')).toBe(true)
  })

  it('adds up to two other open files, same language first, never itself', () => {
    const others = [
      { path: '/p/readme.md', language: 'markdown', text: '# readme' },
      { path: '/p/a.ts', language: 'typescript', text: 'self' },
      {
        path: '/p/b.ts',
        language: 'typescript',
        text: 'y'.repeat(COMPLETION_NEIGHBOR_TEXT_MAX + 10),
      },
      { path: '/p/c.css', language: 'css', text: 'a{}' },
      { path: '/p/empty.ts', language: 'typescript', text: '  ' },
    ]
    const req = buildCompletionRequest(doc, 0, others)
    expect(req.neighbors?.map((n) => n.path)).toEqual(['/p/b.ts', '/p/readme.md'])
    expect(req.neighbors?.[0].text).toHaveLength(COMPLETION_NEIGHBOR_TEXT_MAX)
  })
})

import { describe, expect, it } from 'vitest'
import { importCandidates } from './importLines'

describe('importCandidates', () => {
  it('takes list items and plain lines, not headings, code, quotes or tables', () => {
    const text = [
      '# Project rules',
      '',
      'Conventions:',
      '- Write no code comments.',
      '* **Prefer** pnpm over npm.',
      '1. Keep diffs small.',
      '```sh',
      'pnpm install',
      '```',
      '> a quote of something',
      '| a | table |',
      '---',
      '- Write no code comments.',
    ].join('\n')
    expect(importCandidates(text)).toEqual([
      'Write no code comments.',
      'Prefer pnpm over npm.',
      'Keep diffs small.',
    ])
  })

  it('drops very long lines and caps the count', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `- Rule number ${i} here`)
    expect(importCandidates([`- ${'x'.repeat(400)}`, ...lines].join('\n'))).toHaveLength(400)
  })
})

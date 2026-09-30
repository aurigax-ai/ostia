import { describe, expect, it } from 'vitest'
import {
  CHAT_CONTEXT_TEXT_MAX,
  COMPLETION_PREFIX_MAX,
  normalizeAssistRequest,
  normalizeAssistResult,
  normalizeAssistStatus,
} from './assist'

describe('normalizeAssistRequest', () => {
  it('keeps only known typo/review tasks and needs a non-empty draft', () => {
    expect(
      normalizeAssistRequest('input', { text: 'fix teh bug', tasks: ['typos', 'rm'] }),
    ).toEqual({ text: 'fix teh bug', tasks: ['typos'] })
    expect(normalizeAssistRequest('input', { text: '  ', tasks: ['typos'] })).toBeNull()
    expect(normalizeAssistRequest('input', { text: 'x', tasks: [] })).toBeNull()
  })

  it('keeps the tail of a completion prefix, where the cursor is', () => {
    const prefix = `${'a'.repeat(COMPLETION_PREFIX_MAX)}TAIL`
    const req = normalizeAssistRequest('completion', {
      path: '/p/a.ts',
      language: 'typescript',
      prefix,
      suffix: '',
      neighbors: [{ path: '/p/b.ts', text: 'b' }, { path: 5 }],
    })
    expect(req?.prefix.endsWith('TAIL')).toBe(true)
    expect(req?.prefix.length).toBe(COMPLETION_PREFIX_MAX)
    expect(req?.neighbors).toEqual([{ path: '/p/b.ts', text: 'b' }])
  })

  it('needs a chat to end with the human and clips context text', () => {
    expect(
      normalizeAssistRequest('chat', { messages: [{ role: 'assistant', content: 'hi' }] }),
    ).toBeNull()
    expect(
      normalizeAssistRequest('chat', { messages: [{ role: 'system', content: 'x' }] }),
    ).toBeNull()
    const req = normalizeAssistRequest('chat', {
      messages: [{ role: 'user', content: 'why?' }],
      context: [{ kind: 'error', label: 'ls', text: 'e'.repeat(CHAT_CONTEXT_TEXT_MAX + 5) }],
    })
    expect(req?.context[0].text.length).toBe(CHAT_CONTEXT_TEXT_MAX)
  })

  it('keeps attached files and browser pages but drops unknown context kinds', () => {
    const req = normalizeAssistRequest('chat', {
      messages: [{ role: 'user', content: 'summarize' }],
      context: [
        { kind: 'file', label: 'README.md', text: 'hello' },
        { kind: 'browser', label: 'Docs', text: 'Docs\nhttps://example.com' },
        { kind: 'secret', label: 'x', text: 'y' },
      ],
    })
    expect(req?.context.map((c) => c.kind)).toEqual(['file', 'browser'])
  })
})

describe('normalizeAssistResult', () => {
  it('bounds a prompt review and rounds its score into 1-5', () => {
    expect(
      normalizeAssistResult('input', {
        review: { score: 9.4, notes: ['a', '', 'b', 'c', 'd', 'e', 'f'] },
      }),
    ).toEqual({ review: { score: 5, notes: ['a', 'b', 'c', 'd', 'e'] } })
  })

  it('returns an empty text for a malformed reply', () => {
    expect(normalizeAssistResult('chat', 'nope')).toEqual({ text: '' })
  })
})

describe('normalizeAssistStatus', () => {
  it('keeps known points with a boolean ready and a short label', () => {
    expect(
      normalizeAssistStatus({ chat: { ready: 'yes', label: 'x' }, shell: { ready: true } }),
    ).toEqual({ chat: { ready: false, label: 'x' } })
  })
})

import { en } from '@shared/dict'
import { REDACT_TEXTS_MAX } from '@shared/redaction'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  redactOutgoing,
  redactToolOutput,
  redactedCount,
  redactedCountLabel,
  redactionsIn,
} from './chatRedaction'

function fakeRedaction(): void {
  vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
    texts.map((text) => {
      const count = text.split('SECRET').length - 1
      return { text: text.replaceAll('SECRET', '[redacted:test]'), count, kinds: {} }
    }),
  )
}

afterEach(() => {
  vi.mocked(window.ostia.privacy.redact).mockReset()
  vi.mocked(window.ostia.privacy.redact).mockImplementation(async (texts) =>
    texts.map((text) => ({ text, count: 0, kinds: {} })),
  )
})

describe('redactOutgoing', () => {
  it('redacts the question and each context text, keeping labels and paths', async () => {
    fakeRedaction()
    const out = await redactOutgoing('why SECRET', [
      { kind: 'file', label: '.env', text: 'KEY=SECRET', path: '/p/.env' },
      { kind: 'cwd', label: 'Folder', text: '/p' },
    ])
    expect(out).toEqual({
      question: 'why [redacted:test]',
      context: [
        { kind: 'file', label: '.env', text: 'KEY=[redacted:test]', path: '/p/.env' },
        { kind: 'cwd', label: 'Folder', text: '/p' },
      ],
    })
  })

  it('sends the text as typed when main cannot be asked; main redacts it again on the way out', async () => {
    vi.mocked(window.ostia.privacy.redact).mockRejectedValue(new Error('gone'))
    expect(await redactOutgoing('why SECRET', [])).toEqual({ question: 'why SECRET', context: [] })
  })
})

describe('redactedCount', () => {
  it('adds up what would be redacted and skips empty texts', async () => {
    fakeRedaction()
    expect(await redactedCount(['', 'SECRET and SECRET', 'none', 'SECRET'])).toBe(3)
    expect(vi.mocked(window.ostia.privacy.redact).mock.calls[0][0]).toEqual([
      'SECRET and SECRET',
      'none',
      'SECRET',
    ])
  })

  it('asks nothing for an empty draft', async () => {
    expect(await redactedCount(['', ''])).toBe(0)
    expect(window.ostia.privacy.redact).not.toHaveBeenCalled()
  })

  it('splits a long list into requests main accepts', async () => {
    fakeRedaction()
    const texts = Array.from({ length: REDACT_TEXTS_MAX + 3 }, () => 'SECRET')
    expect(await redactedCount(texts)).toBe(REDACT_TEXTS_MAX + 3)
    const sizes = vi.mocked(window.ostia.privacy.redact).mock.calls.map((call) => call[0].length)
    expect(sizes).toEqual([REDACT_TEXTS_MAX, 3])
  })
})

describe('redactToolOutput', () => {
  it('redacts every string inside a structured result and keeps its shape', async () => {
    fakeRedaction()
    const output = {
      path: '/p/.env',
      lines: 2,
      items: ['a', 'TOKEN=SECRET'],
      nested: { v: 'SECRET' },
    }
    expect(await redactToolOutput(output)).toEqual({
      path: '/p/.env',
      lines: 2,
      items: ['a', 'TOKEN=[redacted:test]'],
      nested: { v: '[redacted:test]' },
    })
  })

  it('returns the same object when nothing was redacted', async () => {
    fakeRedaction()
    const output = { opened: '/p/a.ts' }
    expect(await redactToolOutput(output)).toBe(output)
    expect(await redactToolOutput(null)).toBeNull()
  })

  it('redacts a plain string result', async () => {
    fakeRedaction()
    expect(await redactToolOutput('skill body SECRET')).toBe('skill body [redacted:test]')
  })
})

describe('redactionsIn', () => {
  it('counts the redaction marks of a sent message and its context', () => {
    expect(
      redactionsIn('use [redacted:github]', [
        { kind: 'output', label: 'Output', text: '[redacted:aws] [redacted:npm]' },
      ]),
    ).toBe(3)
  })
})

describe('redactedCountLabel', () => {
  it('reads naturally for one and for many', () => {
    expect(redactedCountLabel(en, 1)).toBe('1 secret redacted')
    expect(redactedCountLabel(en, 4)).toBe('4 secrets redacted')
  })
})

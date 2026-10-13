import { describe, expect, it } from 'vitest'
import {
  QUESTION_CHOICES_MAX,
  QUESTION_CHOICE_MAX,
  QUESTION_CONTEXT_MAX,
  QUESTION_MAX,
  QUESTION_REPLY_MAX,
  QUESTION_TIMEOUT_MAX_S,
  normalizeQuestion,
  normalizeReply,
} from './questions'

function content(raw: unknown) {
  const result = normalizeQuestion(raw)
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`)
  return result.content
}

function refusal(raw: unknown): string {
  const result = normalizeQuestion(raw)
  return result.ok ? 'ok' : result.error
}

describe('normalizeQuestion', () => {
  it('reads a free-text question when no choices are given', () => {
    expect(content({ question: 'What next?' })).toEqual({
      question: 'What next?',
      context: '',
      choices: [],
      mode: 'text',
    })
  })

  it('is single choice with choices and multi only when asked', () => {
    expect(content({ question: 'q', choices: ['a', 'b'] }).mode).toBe('single')
    expect(content({ question: 'q', choices: ['a', 'b'], multi: true }).mode).toBe('multi')
  })

  it('puts the question and each choice on one line without control characters', () => {
    const parsed = content({
      question: '  Ship\n\x1b[31mit\x07?  ',
      choices: ['yes\tplease', ' no '],
    })
    expect(parsed.question).toBe('Ship [31mit?')
    expect(parsed.choices).toEqual(['yes please', 'no'])
  })

  it('keeps line breaks and tabs in the context and drops other control characters', () => {
    expect(content({ question: 'q', context: 'one\r\n\ttwo\x00\x9b' }).context).toBe('one\n\ttwo')
  })

  it('clips a long question and a long context', () => {
    const parsed = content({
      question: 'q'.repeat(QUESTION_MAX + 50),
      context: 'c'.repeat(QUESTION_CONTEXT_MAX + 50),
    })
    expect(parsed.question).toHaveLength(QUESTION_MAX)
    expect(parsed.question.endsWith('…')).toBe(true)
    expect(parsed.context).toHaveLength(QUESTION_CONTEXT_MAX)
  })

  it('refuses a missing or blank question', () => {
    expect(refusal({})).toBe('invalid-question')
    expect(refusal({ question: ' \n ' })).toBe('invalid-question')
    expect(refusal({ question: 7 })).toBe('invalid-question')
    expect(refusal(null)).toBe('invalid-question')
  })

  it('refuses too many, too long, empty, repeated or non-text choices', () => {
    const many = Array.from({ length: QUESTION_CHOICES_MAX + 1 }, (_, i) => `c${i}`)
    expect(refusal({ question: 'q', choices: many })).toBe('invalid-choices')
    expect(refusal({ question: 'q', choices: ['x'.repeat(QUESTION_CHOICE_MAX + 1)] })).toBe(
      'invalid-choices',
    )
    expect(refusal({ question: 'q', choices: ['a', ' '] })).toBe('invalid-choices')
    expect(refusal({ question: 'q', choices: ['a', 'a '] })).toBe('invalid-choices')
    expect(refusal({ question: 'q', choices: ['a', 3] })).toBe('invalid-choices')
    expect(refusal({ question: 'q', choices: 'a' })).toBe('invalid-choices')
  })

  it('refuses multi without choices', () => {
    expect(refusal({ question: 'q', multi: true })).toBe('invalid-choices')
  })

  it('accepts a timeout in range and refuses one outside it', () => {
    expect(content({ question: 'q', timeoutSeconds: 1.5 }).timeoutMs).toBe(1500)
    expect(refusal({ question: 'q', timeoutSeconds: 0 })).toBe('invalid-timeout')
    expect(refusal({ question: 'q', timeoutSeconds: QUESTION_TIMEOUT_MAX_S + 1 })).toBe(
      'invalid-timeout',
    )
    expect(refusal({ question: 'q', timeoutSeconds: '60' })).toBe('invalid-timeout')
  })

  it('refuses a context that is not text', () => {
    expect(refusal({ question: 'q', context: { a: 1 } })).toBe('invalid-context')
  })
})

describe('normalizeReply', () => {
  const single = { choices: ['a', 'b', 'c'], mode: 'single' as const }
  const multi = { choices: ['a', 'b', 'c'], mode: 'multi' as const }
  const text = { choices: [], mode: 'text' as const }

  it('accepts one choice with a comment', () => {
    expect(normalizeReply(single, { choices: [1], text: ' because ' })).toEqual({
      choices: [1],
      text: 'because',
    })
  })

  it('accepts a reply with no choice in every form', () => {
    expect(normalizeReply(single, { choices: [], text: 'neither' })?.text).toBe('neither')
    expect(normalizeReply(multi, { choices: [], text: 'neither' })?.text).toBe('neither')
    expect(normalizeReply(text, { choices: [], text: 'free' })?.text).toBe('free')
  })

  it('sorts and de-duplicates several choices', () => {
    expect(normalizeReply(multi, { choices: [2, 0, 2], text: '' })).toEqual({
      choices: [0, 2],
      text: '',
    })
  })

  it('refuses two choices for a single-choice question', () => {
    expect(normalizeReply(single, { choices: [0, 1], text: '' })).toBeNull()
  })

  it('refuses a choice the question does not have', () => {
    expect(normalizeReply(single, { choices: [3], text: '' })).toBeNull()
    expect(normalizeReply(single, { choices: [-1], text: '' })).toBeNull()
    expect(normalizeReply(single, { choices: [0.5], text: '' })).toBeNull()
    expect(normalizeReply(text, { choices: [0], text: 'x' })).toBeNull()
    expect(normalizeReply(single, { choices: ['constructor'], text: '' })).toBeNull()
  })

  it('refuses an empty answer and a malformed one', () => {
    expect(normalizeReply(single, { choices: [], text: '  ' })).toBeNull()
    expect(normalizeReply(single, null)).toBeNull()
    expect(normalizeReply(single, { choices: [0] })).toBeNull()
    expect(normalizeReply(single, { text: 'x' })).toBeNull()
  })

  it('strips control characters from the reply and clips it', () => {
    expect(normalizeReply(text, { choices: [], text: 'a\x1b\x07b\nc' })?.text).toBe('ab\nc')
    expect(
      normalizeReply(text, { choices: [], text: 'x'.repeat(QUESTION_REPLY_MAX + 9) })?.text,
    ).toHaveLength(QUESTION_REPLY_MAX)
  })
})

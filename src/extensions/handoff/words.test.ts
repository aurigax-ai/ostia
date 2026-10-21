import { describe, expect, it } from 'vitest'
import { cleanTopic, searchWords, TOPIC_MAX, WORDS_MAX } from './words'

describe('handoff words', () => {
  it('lowercases, drops shell and option characters and repeats', () => {
    expect(searchWords(['Checkout; $(rm -rf /) --retries', 'checkout'])).toEqual([
      'checkout',
      'rm',
      'rf',
      'retries',
    ])
  })

  it('keeps at most six words of at least two characters', () => {
    expect(searchWords(['a bb cc dd ee ff gg hh'])).toHaveLength(WORDS_MAX)
  })

  it('keeps issue numbers and paths', () => {
    expect(searchWords(['#1329 src/extensions/handoff'])).toEqual([
      '#1329',
      'src/extensions/handoff',
    ])
  })

  it('makes a topic one clean line', () => {
    expect(cleanTopic(['fix\nthe\u0000retry', 'loop now'])).toBe('fix the retry loop now')
    expect(cleanTopic(['x'.repeat(TOPIC_MAX + 50)])).toHaveLength(TOPIC_MAX)
  })
})

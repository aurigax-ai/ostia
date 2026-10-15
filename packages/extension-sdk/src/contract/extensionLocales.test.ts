import { describe, expect, it } from 'vitest'
import {
  EXTENSION_MESSAGES_MAX,
  EXTENSION_MESSAGE_MAX,
  formatMessage,
  localized,
  matchLocale,
  parseMessages,
  translatorFor,
} from './extensionLocales'

describe('matchLocale', () => {
  it('picks the exact tag whatever its case', () => {
    expect(matchLocale('zh-hant', ['fr', 'zh-Hant'])).toBe('zh-Hant')
  })

  it('drops trailing subtags until a catalog matches', () => {
    expect(matchLocale('zh-Hant-TW', ['zh', 'zh-Hant'])).toBe('zh-Hant')
    expect(matchLocale('pt-BR', ['pt'])).toBe('pt')
  })

  it('falls back to the first catalog of the same language', () => {
    expect(matchLocale('zh-TW', ['fr', 'zh-Hant', 'zh-Hans'])).toBe('zh-Hant')
  })

  it('matches nothing for another language or no locale', () => {
    expect(matchLocale('en', ['zh-Hant'])).toBeUndefined()
    expect(matchLocale(undefined, ['zh-Hant'])).toBeUndefined()
  })
})

describe('localized', () => {
  it('returns the matching catalog and English otherwise', () => {
    const catalogs = { en: 'hello', 'zh-Hant': '你好' }
    expect(localized(catalogs, 'zh-Hant')).toBe('你好')
    expect(localized(catalogs, 'fr')).toBe('hello')
    expect(localized(catalogs, undefined)).toBe('hello')
  })
})

describe('formatMessage', () => {
  it('fills named placeholders and leaves unknown ones as written', () => {
    expect(formatMessage('{count} of {total} {unit}', { count: 2, total: 5 })).toBe('2 of 5 {unit}')
  })

  it('never reads a placeholder from the prototype', () => {
    expect(formatMessage('{constructor} {toString}', {})).toBe('{constructor} {toString}')
  })
})

describe('parseMessages', () => {
  it('keeps strings and reports everything else', () => {
    const raw = JSON.parse(
      '{"hello":"Hello","count":3,"nested":{"a":"b"},"__proto__":"x","constructor":"y","":"z"}',
    )
    const res = parseMessages(raw)
    expect({ ...res.messages }).toEqual({ hello: 'Hello' })
    expect(res.problems).toEqual([
      'messages.count: must be a string',
      'messages.nested: must be a string',
      'messages.__proto__: not a usable key',
      'messages.constructor: not a usable key',
      'messages.: not a usable key',
    ])
    expect(Object.getPrototypeOf(res.messages)).toBeNull()
  })

  it('refuses a string past the length cap and anything past the count cap', () => {
    const long = parseMessages({ a: 'x'.repeat(EXTENSION_MESSAGE_MAX + 1) })
    expect(Object.keys(long.messages)).toEqual([])
    expect(long.problems).toEqual([`messages.a: longer than ${EXTENSION_MESSAGE_MAX} characters`])
    const many = Object.fromEntries(
      Array.from({ length: EXTENSION_MESSAGES_MAX + 5 }, (_, i) => [`k${i}`, 'v']),
    )
    const res = parseMessages(many)
    expect(Object.keys(res.messages)).toHaveLength(EXTENSION_MESSAGES_MAX)
    expect(res.problems).toEqual([`messages holds more than ${EXTENSION_MESSAGES_MAX} strings`])
  })

  it('treats a missing section as empty and a non-object as a problem', () => {
    expect(parseMessages(undefined).problems).toEqual([])
    expect(parseMessages(['a']).problems).toEqual(['messages must be an object of strings'])
  })
})

describe('translatorFor', () => {
  const catalogs = {
    en: { greeting: 'Hello, {name}', bye: 'Goodbye' },
    'zh-Hant': { greeting: '你好，{name}' },
  }

  it('uses the catalog of the locale', () => {
    expect(translatorFor(catalogs, 'zh-Hant')('greeting', { name: 'Ada' })).toBe('你好，Ada')
  })

  it('falls back per message to English, then to the key', () => {
    const t = translatorFor(catalogs, 'zh-Hant')
    expect(t('bye')).toBe('Goodbye')
    expect(t('missing')).toBe('missing')
  })

  it('uses English for a locale with no catalog', () => {
    expect(translatorFor(catalogs, 'fr')('greeting', { name: 'Ada' })).toBe('Hello, Ada')
    expect(translatorFor(catalogs, undefined)('bye')).toBe('Goodbye')
  })

  it('never resolves a key from the prototype', () => {
    expect(translatorFor(catalogs, 'en')('toString')).toBe('toString')
  })
})

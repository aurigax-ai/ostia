import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTENSION_LOCALE_FILE_MAX_BYTES } from '../../shared/extensionLocales'
import { createTranslator, readMessages } from './i18n'

describe('createTranslator', () => {
  let dir: string
  const savedDir = process.env.PINE_EXTENSION_DIR

  const write = (name: string, content: unknown): void => {
    writeFileSync(
      join(dir, 'locales', name),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pine-sdk-i18n-'))
    mkdirSync(join(dir, 'locales'))
    write('en.json', { messages: { greeting: 'Hello, {name}', bye: 'Goodbye' } })
    write('zh-Hant.json', {
      manifest: { name: '哈囉' },
      messages: { greeting: '你好，{name}' },
    })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedDir === undefined) Reflect.deleteProperty(process.env, 'PINE_EXTENSION_DIR')
    else process.env.PINE_EXTENSION_DIR = savedDir
  })

  it("answers in the caller's language", () => {
    const translate = createTranslator(dir)
    expect(translate('zh-Hant')('greeting', { name: 'Ada' })).toBe('你好，Ada')
    expect(translate('zh-Hant-TW')('greeting', { name: 'Ada' })).toBe('你好，Ada')
  })

  it('falls back to English per message, then to the key', () => {
    const t = createTranslator(dir)('zh-Hant')
    expect(t('bye')).toBe('Goodbye')
    expect(t('unknown')).toBe('unknown')
  })

  it('answers in English for a language without a catalog or a caller without a locale', () => {
    const translate = createTranslator(dir)
    expect(translate('fr')('greeting', { name: 'Ada' })).toBe('Hello, Ada')
    expect(translate(undefined)('bye')).toBe('Goodbye')
  })

  it('reads the folder Pine started the extension in when none is given', () => {
    process.env.PINE_EXTENSION_DIR = dir
    expect(createTranslator()('zh-Hant')('greeting', { name: 'Ada' })).toBe('你好，Ada')
  })

  it('reads only the messages section', () => {
    expect({ ...readMessages(dir)['zh-Hant'] }).toEqual({ greeting: '你好，{name}' })
  })

  it('skips files that are not catalogs, are too large or are not named by a language tag', () => {
    write('fr.json', '{broken')
    write('de.json', `{"messages":{"a":"${'x'.repeat(EXTENSION_LOCALE_FILE_MAX_BYTES)}"}}`)
    write('not a tag.json', { messages: { greeting: 'x' } })
    write('notes.txt', 'hello')
    const catalogs = readMessages(dir)
    expect(Object.keys(catalogs).sort()).toEqual(['de', 'en', 'fr', 'zh-Hant'])
    expect({ ...catalogs.fr }).toEqual({})
    expect({ ...catalogs.de }).toEqual({})
    expect(createTranslator(dir)('fr')('bye')).toBe('Goodbye')
  })

  it('returns keys when the extension ships no catalogs', () => {
    rmSync(join(dir, 'locales'), { recursive: true })
    expect(createTranslator(dir)('zh-Hant')('greeting')).toBe('greeting')
  })
})

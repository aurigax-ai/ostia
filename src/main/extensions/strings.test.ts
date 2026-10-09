import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, zhHant } from '../../shared/dict'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import type { LanguageSource } from './languagePacks'
import { createMainStrings } from './strings'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function pack(catalog: unknown, id = 'zh-Hant'): LanguageSource {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-main-strings-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'catalog.json'), JSON.stringify(catalog))
  return { extId: `langpack-${id}`, dir, language: { id, label: id, path: 'catalog.json' } }
}

function strings(locale: string | undefined, sources: () => LanguageSource[]) {
  const errors: string[] = []
  const dict = createMainStrings({
    locale: () => locale,
    languages: sources,
    onError: (extId, error) => errors.push(`${extId}: ${error}`),
  })
  return { dict, errors }
}

describe('createMainStrings', () => {
  it('translates native text with the language pack of the chosen locale', () => {
    const source = pack(zhHant)
    const { dict } = strings('zh-Hant', () => [source])
    expect(dict().native.quit.quit).toBe(zhHant.native.quit.quit)
    expect(dict().native.tray.unread).toBe(zhHant.native.tray.unread)
    expect(dict().native.signIn.done).toBe(
      `已登入。你可以關閉此分頁並回到 ${PRODUCT_DISPLAY_NAME}。`,
    )
    expect(dict().native.updateTitle).toBe(`更新 ${PRODUCT_DISPLAY_NAME}`)
  })

  it('keeps English for every string the pack leaves out', () => {
    const source = pack({ native: { tray: { show: 'Afficher' } } }, 'fr')
    const { dict } = strings('fr', () => [source])
    expect(dict().native.tray).toEqual({ ...en.native.tray, show: 'Afficher' })
    expect(dict().native.quit).toEqual(en.native.quit)
  })

  it('speaks English without a locale, for English and for a locale no pack provides', () => {
    const source = pack(zhHant)
    for (const locale of [undefined, 'en', 'fr']) {
      const { dict } = strings(locale, () => [source])
      expect(dict().native.tray.quit, String(locale)).toBe('Quit')
      expect(dict().native.updateTitle).toBe(`Update ${PRODUCT_DISPLAY_NAME}`)
    }
  })

  it('reports a pack it cannot read and speaks English', () => {
    const source = pack(zhHant)
    writeFileSync(join(source.dir, 'catalog.json'), '{')
    const { dict, errors } = strings('zh-Hant', () => [source])
    expect(dict().native.tray.quit).toBe('Quit')
    expect(errors).toEqual(['langpack-zh-Hant: catalog.json: not valid JSON'])
  })

  it('reads a pack once and follows the packs that are active', () => {
    const source = pack(zhHant)
    let active = [source]
    const { dict } = strings('zh-Hant', () => active)
    const first = dict()
    expect(dict()).toBe(first)
    active = []
    expect(dict().native.tray.quit).toBe('Quit')
    active = [source]
    expect(dict().native.tray.quit).toBe(zhHant.native.tray.quit)
  })
})

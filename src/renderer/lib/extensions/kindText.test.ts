import type { FileKindInfo } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { en, zhHant } from '@shared/app/dict'
import { describe, expect, it } from 'vitest'
import { kindText } from './kindText'

const base: FileKindInfo = {
  id: 'archives.zip',
  displayName: 'Zip archive',
  selector: [{ filenamePattern: '*.zip' }, { filenamePattern: '*.jar' }],
  approved: true,
}

describe('kindText', () => {
  it('says what a view shows and what a browse lists, one sentence per role', () => {
    expect(kindText(en, { ...base, view: { priority: 'default' } })).toBe(
      'Zip archive shows *.zip, *.jar files, read-only. It cannot send them anywhere.',
    )
    expect(kindText(en, { ...base, browse: true })).toBe(
      'Zip archive lists and opens what is inside *.zip, *.jar files you expand in Files.',
    )
    expect(kindText(en, { ...base, view: { priority: 'option' }, browse: true })).toMatch(
      /from Open With.*lists and opens what is inside/,
    )
  })

  it('adds who serves the patterns a browse kind does not', () => {
    const text = kindText(en, {
      ...base,
      browse: true,
      shadowed: [{ name: 'Archives', patterns: ['*.zip'] }],
    })
    expect(text).toMatch(/Not used for \*\.zip: Archives handles these files\.$/)
    expect(kindText(zhHant, { ...base, browse: true })).toContain('*.zip, *.jar')
  })
})

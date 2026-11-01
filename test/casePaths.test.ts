import { describe, expect, it } from 'vitest'
import { caseClashes } from '../scripts/casePaths.mjs'

describe('caseClashes', () => {
  it('flags module stems that differ only in case', () => {
    expect(caseClashes(['a/FileIcon.tsx', 'a/fileIcon.ts'])).toEqual([
      ['a/FileIcon.tsx', 'a/fileIcon.ts'],
    ])
  })

  it('accepts the same stem with different extensions', () => {
    expect(caseClashes(['a/foo.ts', 'a/foo.css', 'a/foo.test.ts'])).toEqual([])
  })

  it('accepts equal names in different directories', () => {
    expect(caseClashes(['a/Foo.ts', 'b/foo.ts'])).toEqual([])
  })
})

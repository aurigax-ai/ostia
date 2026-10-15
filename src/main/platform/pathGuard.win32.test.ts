import { describe, expect, it, vi } from 'vitest'

vi.mock('node:path', async () => {
  const path = await vi.importActual<typeof import('node:path')>('node:path')
  return { ...path.win32, default: path.win32 }
})

const { isInsidePath } = await import('./pathGuard')

describe('isInsidePath with Windows paths', () => {
  it.each([
    ['C:\\', 'C:\\', true],
    ['C:\\', 'C:\\a\\b', true],
    ['C:\\a\\b', 'C:\\a\\b', true],
    ['C:\\a\\b', 'C:\\a\\b\\c', true],
    ['C:\\a\\b\\', 'C:\\a\\b\\c', true],
    ['C:\\a\\b', 'C:/a/b/c', true],
    ['C:/a/b', 'C:\\a\\b\\c', true],
    ['C:\\a\\b', 'c:\\A\\B\\c', true],
    ['C:\\a\\b', 'C:\\a\\b\\..c', true],
    ['\\\\server\\share', '\\\\server\\share\\a', true],
    ['C:\\a\\b', 'C:\\a\\bc', false],
    ['C:\\a\\b', 'C:\\a', false],
    ['C:\\a\\b', 'C:\\a\\b\\..\\c', false],
    ['C:\\a\\b', 'D:\\a\\b\\c', false],
    ['C:\\a\\b', '\\\\server\\share\\a\\b', false],
    ['\\\\server\\share', '\\\\server\\other\\a', false],
    ['C:\\a\\b', 'C:a\\b\\c', false],
    ['C:\\a\\b', 'a\\b\\c', false],
  ])('isInsidePath(%j, %j) is %s', (base, path, inside) => {
    expect(isInsidePath(base, path)).toBe(inside)
  })
})

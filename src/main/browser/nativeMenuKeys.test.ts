import { describe, expect, it } from 'vitest'
import { createNativeMenuKey } from './nativeMenuKeys'

const input = (over: Record<string, unknown>) => ({
  type: 'keyDown',
  key: 'q',
  code: 'KeyQ',
  control: false,
  shift: false,
  alt: false,
  meta: true,
  ...over,
})

const menu = [
  {
    submenu: {
      items: [
        { accelerator: 'Command+Q' },
        { accelerator: 'CommandOrControl+C' },
        { accelerator: 'Cmd+,', registerAccelerator: false },
        { submenu: { items: [{ accelerator: 'Alt+Command+I' }] } },
      ],
    },
  },
]

describe('createNativeMenuKey', () => {
  const nativeKey = createNativeMenuKey(() => menu)

  it('knows the shortcuts a menu item registers, nested and written either way', () => {
    expect(nativeKey(input({}))).toBe(true)
    expect(nativeKey(input({ key: 'c', code: 'KeyC' }))).toBe(true)
    expect(nativeKey(input({ key: '˚', code: 'KeyI', alt: true }))).toBe(true)
  })

  it('ignores an accelerator the menu only displays, other chords and bare modifiers', () => {
    expect(nativeKey(input({ key: ',', code: 'Comma' }))).toBe(false)
    expect(nativeKey(input({ meta: false }))).toBe(false)
    expect(nativeKey(input({ key: 'Meta', code: 'MetaLeft' }))).toBe(false)
  })
})

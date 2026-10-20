import { describe, expect, it } from 'vitest'
import { createGuestRemap } from './guestRemap'

const create = (nativeMenuKey = (_input: unknown) => false) => createGuestRemap({ nativeMenuKey })

const key = (input: Record<string, unknown>) => ({
  type: 'keyDown',
  key: 'k',
  code: 'KeyK',
  control: false,
  shift: false,
  alt: false,
  meta: false,
  ...input,
})

describe('createGuestRemap', () => {
  it('returns the same input with the default table', () => {
    const { remap } = create()
    const input = key({ meta: true })
    expect(remap(1, input)).toBe(input)
  })

  it('rewrites the modifiers of a key by the physical key held and marks it', () => {
    const guest = create()
    guest.set({ ControlRight: 'command', AltLeft: 'control' })
    remapDown(guest, 'ControlRight')
    expect(guest.remap(1, key({ control: true }))).toMatchObject({
      control: false,
      meta: true,
      remapped: true,
    })
    remapDown(guest, 'AltLeft', 'alt')
    expect(guest.remap(1, key({ control: true, alt: true }))).toMatchObject({
      control: true,
      meta: true,
      alt: false,
    })
  })

  it('tracks each guest on its own and forgets a closed one', () => {
    const guest = create()
    guest.set({ ControlRight: 'command' })
    remapDown(guest, 'ControlRight')
    expect(guest.remap(2, key({ control: true })).meta).toBe(false)
    guest.forget(1)
    expect(guest.remap(1, key({ control: true })).meta).toBe(false)
  })

  it('stops remapping when the key is released and ignores a bad table', () => {
    const guest = create()
    guest.set({ ControlRight: 'command' })
    remapDown(guest, 'ControlRight')
    guest.remap(1, key({ type: 'keyUp', code: 'ControlRight', key: 'Control' }))
    expect(guest.remap(1, key({}))).toMatchObject({ meta: false })
    guest.set('garbage')
    remapDown(guest, 'ControlRight')
    expect(guest.remap(1, key({ control: true })).remapped).toBeUndefined()
  })

  it('ignores an event it injected: no tracking, no second remap', () => {
    const guest = create()
    guest.set({ ControlLeft: 'command', MetaLeft: 'control' })
    remapDown(guest, 'ControlLeft')
    guest.inject(1, () => {
      const injected = key({ code: 'MetaLeft', key: 'Meta', meta: true })
      expect(guest.remap(1, injected)).toBe(injected)
      expect(guest.rewrite(1, injected)).toBeNull()
    })
    expect(guest.rewrite(1, key({ control: true }))).toEqual({
      type: 'keyDown',
      keyCode: 'K',
      modifiers: ['meta'],
    })
  })
})

describe('rewrite', () => {
  it('has nothing to send with the default table or an unchanged key', () => {
    const guest = create()
    expect(guest.rewrite(1, key({ meta: true }))).toBeNull()
    guest.set({ ControlRight: 'command' })
    expect(guest.rewrite(1, key({ meta: true }))).toBeNull()
  })

  it('sends the key with the remapped modifiers and keeps Shift and repeat', () => {
    const guest = create()
    guest.set({ ControlRight: 'command', AltLeft: 'control' })
    remapDown(guest, 'ControlRight')
    expect(guest.rewrite(1, key({ control: true, shift: true, isAutoRepeat: true }))).toEqual({
      type: 'keyDown',
      keyCode: 'K',
      modifiers: ['shift', 'meta', 'isautorepeat'],
    })
    expect(guest.rewrite(1, key({ type: 'keyUp', control: true }))?.type).toBe('keyUp')
  })

  it('takes Option characters away from a key remapped to Command', () => {
    const guest = create()
    guest.set({ AltLeft: 'command' })
    remapDown(guest, 'AltLeft', 'alt')
    expect(guest.rewrite(1, key({ key: '˚', alt: true }))).toEqual({
      type: 'keyDown',
      keyCode: 'K',
      modifiers: ['meta'],
    })
  })

  it('sends the modifier press and release as the key it now stands for', () => {
    const guest = create()
    guest.set({ ControlRight: 'command' })
    expect(guest.rewrite(1, key({ code: 'ControlRight', key: 'Control', control: true }))).toEqual({
      type: 'keyDown',
      keyCode: 'Meta',
      modifiers: ['meta'],
    })
    expect(guest.rewrite(1, key({ type: 'keyUp', code: 'ControlRight', key: 'Control' }))).toEqual({
      type: 'keyUp',
      keyCode: 'Meta',
      modifiers: [],
    })
    expect(guest.rewrite(1, key({ code: 'ControlLeft', key: 'Control', control: true }))).toBeNull()
  })

  it('passes composition, dead keys and keys it cannot name through', () => {
    const guest = create()
    guest.set({ ControlRight: 'command' })
    remapDown(guest, 'ControlRight')
    expect(guest.rewrite(1, key({ control: true, isComposing: true }))).toBeNull()
    expect(guest.rewrite(1, key({ control: true, key: 'Dead' }))).toBeNull()
    expect(guest.rewrite(1, key({ control: true, code: 'Numpad1' }))).toBeNull()
  })

  it('keeps the physical key for a native menu shortcut', () => {
    const guest = create((input) => (input as { meta: boolean }).meta)
    guest.set({ MetaLeft: 'control' })
    remapDown(guest, 'MetaLeft', 'meta')
    expect(guest.rewrite(1, key({ meta: true }))).toBeNull()
  })

  it('tracks a modifier pressed while composing', () => {
    const guest = create()
    guest.set({ ControlRight: 'command' })
    guest.rewrite(
      1,
      key({ code: 'ControlRight', key: 'Control', control: true, isComposing: true }),
    )
    expect(guest.rewrite(1, key({ control: true }))?.modifiers).toEqual(['meta'])
  })
})

function remapDown(
  guest: ReturnType<typeof createGuestRemap>,
  code: string,
  flag: 'control' | 'alt' | 'meta' = 'control',
): void {
  guest.remap(1, key({ code, key: 'Modifier', [flag]: true }))
}

import { describe, expect, it } from 'vitest'
import { createGuestRemap } from './guestRemap'

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
    const { remap } = createGuestRemap()
    const input = key({ meta: true })
    expect(remap(1, input)).toBe(input)
  })

  it('rewrites the modifiers of a key by the physical key held and marks it', () => {
    const guest = createGuestRemap()
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
    const guest = createGuestRemap()
    guest.set({ ControlRight: 'command' })
    remapDown(guest, 'ControlRight')
    expect(guest.remap(2, key({ control: true })).meta).toBe(false)
    guest.forget(1)
    expect(guest.remap(1, key({ control: true })).meta).toBe(false)
  })

  it('stops remapping when the key is released and ignores a bad table', () => {
    const guest = createGuestRemap()
    guest.set({ ControlRight: 'command' })
    remapDown(guest, 'ControlRight')
    guest.remap(1, key({ type: 'keyUp', code: 'ControlRight', key: 'Control' }))
    expect(guest.remap(1, key({}))).toMatchObject({ meta: false })
    guest.set('garbage')
    remapDown(guest, 'ControlRight')
    expect(guest.remap(1, key({ control: true })).remapped).toBeUndefined()
  })
})

function remapDown(
  guest: ReturnType<typeof createGuestRemap>,
  code: string,
  flag: 'control' | 'alt' | 'meta' = 'control',
): void {
  guest.remap(1, key({ code, key: 'Modifier', [flag]: true }))
}

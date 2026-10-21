import { describe, expect, it } from 'vitest'
import {
  isIdentityRemap,
  isRetargeted,
  type ModifierRemap,
  parseModifierRemap,
  type RemapKey,
  releaseStale,
  remappedFlags,
  remappedModifierKey,
  trackModifierKey,
} from './modifierRemap'

const none = { ctrl: false, alt: false, meta: false }

describe('parseModifierRemap', () => {
  it('keeps only valid non-default entries', () => {
    expect(
      parseModifierRemap({
        ControlLeft: 'command',
        ControlRight: 'control',
        AltLeft: 'shift',
        Bogus: 'option',
        MetaRight: 'option',
      }),
    ).toEqual({ ControlLeft: 'command', MetaRight: 'option' })
  })

  it('reads anything that is not an object as the defaults', () => {
    for (const raw of [null, undefined, 'x', 3, ['ControlLeft']]) {
      expect(parseModifierRemap(raw)).toEqual({})
    }
  })

  it('knows the identity table', () => {
    expect(isIdentityRemap({})).toBe(true)
    expect(isIdentityRemap({ AltRight: 'command' })).toBe(false)
  })
})

describe('remappedFlags', () => {
  const down = (...keys: RemapKey[]) => new Set(keys)

  it('leaves every flag alone with the default table', () => {
    expect(remappedFlags({}, down('MetaLeft'), { ...none, meta: true })).toEqual({
      ...none,
      meta: true,
    })
  })

  it('maps one physical key to the chosen modifier', () => {
    const table: ModifierRemap = { MetaRight: 'control' }
    expect(remappedFlags(table, down('MetaRight'), { ...none, meta: true })).toEqual({
      ...none,
      ctrl: true,
    })
  })

  it('maps the left and right key of a pair separately', () => {
    const table: ModifierRemap = { AltRight: 'command' }
    const real = { ...none, alt: true }
    expect(remappedFlags(table, down('AltLeft'), real)).toEqual({ ...none, alt: true })
    expect(remappedFlags(table, down('AltRight'), real)).toEqual({ ...none, meta: true })
    expect(remappedFlags(table, down('AltLeft', 'AltRight'), real)).toEqual({
      ...none,
      alt: true,
      meta: true,
    })
  })

  it('swaps two keys without mapping twice', () => {
    const table: ModifierRemap = { ControlLeft: 'command', MetaLeft: 'control' }
    expect(
      remappedFlags(table, down('ControlLeft', 'MetaLeft'), { ...none, ctrl: true, meta: true }),
    ).toEqual({ ...none, ctrl: true, meta: true })
    expect(remappedFlags(table, down('ControlLeft'), { ...none, ctrl: true })).toEqual({
      ...none,
      meta: true,
    })
  })

  it('ignores a tracked key the system no longer reports held', () => {
    expect(remappedFlags({ ControlLeft: 'option' }, down('ControlLeft'), none)).toEqual(none)
  })

  it('treats a held modifier the tracker never saw as itself', () => {
    expect(remappedFlags({ ControlLeft: 'option' }, down(), { ...none, ctrl: true })).toEqual({
      ...none,
      ctrl: true,
    })
  })
})

describe('trackModifierKey and remappedModifierKey', () => {
  it('tracks only the six physical modifier codes', () => {
    const held = new Set<RemapKey>()
    trackModifierKey(held, 'ShiftLeft', true)
    trackModifierKey(held, 'KeyA', true)
    trackModifierKey(held, 'MetaRight', true)
    expect([...held]).toEqual(['MetaRight'])
    trackModifierKey(held, 'MetaRight', false)
    expect(held.size).toBe(0)
  })

  it('names the key a modifier press now stands for', () => {
    expect(remappedModifierKey({ ControlLeft: 'command' }, 'ControlLeft')).toBe('Meta')
    expect(remappedModifierKey({}, 'AltRight')).toBe('Alt')
    expect(remappedModifierKey({}, 'KeyA')).toBeNull()
  })
})

describe('isRetargeted', () => {
  it('is true only for a modifier key the table sends somewhere else', () => {
    const table: ModifierRemap = { ControlRight: 'command' }
    expect(isRetargeted(table, 'ControlRight')).toBe(true)
    expect(isRetargeted(table, 'ControlLeft')).toBe(false)
    expect(isRetargeted(table, 'KeyK')).toBe(false)
  })
})

describe('releaseStale', () => {
  it('drops the held keys of a modifier family the event no longer reports', () => {
    const down = new Set<RemapKey>(['ControlRight', 'AltLeft', 'MetaLeft'])
    releaseStale(down, { ctrl: false, alt: true, meta: true })
    expect([...down]).toEqual(['AltLeft', 'MetaLeft'])
  })
})

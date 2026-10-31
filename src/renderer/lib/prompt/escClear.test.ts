import { describe, expect, it } from 'vitest'
import { escAction } from './escClear'

const base = { vim: false, suggestion: false, clears: true, text: 'git status', armed: false }

describe('escAction', () => {
  it('arms on the first Esc over a draft', () => {
    expect(escAction(base)).toBe('arm')
  })

  it('clears on the second Esc while armed', () => {
    expect(escAction({ ...base, armed: true })).toBe('clear')
  })

  it('does nothing on an empty draft', () => {
    expect(escAction({ ...base, text: '' })).toBe('none')
    expect(escAction({ ...base, text: '', armed: true })).toBe('none')
  })

  it('does nothing when the setting only closes menus', () => {
    expect(escAction({ ...base, clears: false })).toBe('none')
    expect(escAction({ ...base, clears: false, armed: true })).toBe('none')
  })

  it('dismisses a suggestion before it arms', () => {
    expect(escAction({ ...base, suggestion: true })).toBe('dismiss')
  })

  it('leaves Esc to vim, which never clears', () => {
    expect(escAction({ ...base, vim: true, armed: true })).toBe('normal')
    expect(escAction({ ...base, vim: true, suggestion: true })).toBe('normal')
  })
})

import { describe, expect, it } from 'vitest'
import { type KeyInput, mediaKeyAction, nextVolume } from './mediaKeys'

const plain = (key: string): KeyInput => ({
  key,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
})

describe('mediaKeyAction', () => {
  it('maps the player keys', () => {
    expect(mediaKeyAction(plain(' '))).toEqual({ type: 'toggle' })
    expect(mediaKeyAction(plain('ArrowLeft'))).toEqual({ type: 'seek', seconds: -5 })
    expect(mediaKeyAction(plain('ArrowRight'))).toEqual({ type: 'seek', seconds: 5 })
    expect(mediaKeyAction(plain('ArrowUp'))).toEqual({ type: 'volume', delta: 0.1 })
    expect(mediaKeyAction(plain('ArrowDown'))).toEqual({ type: 'volume', delta: -0.1 })
    expect(mediaKeyAction(plain('m'))).toEqual({ type: 'mute' })
    expect(mediaKeyAction(plain('L'))).toEqual({ type: 'loop' })
  })

  it('leaves other keys and chords alone', () => {
    expect(mediaKeyAction(plain('a'))).toBeNull()
    expect(mediaKeyAction({ ...plain('m'), ctrlKey: true })).toBeNull()
    expect(mediaKeyAction({ ...plain('ArrowLeft'), altKey: true })).toBeNull()
    expect(mediaKeyAction({ ...plain('l'), metaKey: true })).toBeNull()
  })
})

describe('nextVolume', () => {
  it('moves by a step and stays between 0 and 1', () => {
    expect(nextVolume(0.5, 0.1)).toBe(0.6)
    expect(nextVolume(0.95, 0.1)).toBe(1)
    expect(nextVolume(0.05, -0.1)).toBe(0)
  })
})

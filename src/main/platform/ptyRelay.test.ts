import { describe, expect, it } from 'vitest'
import { needsPtyRelay, terminalInjectionOff } from './ptyRelay'

const refuses = (): string => '0\n'
const allows = (): string => '1\n'
const unreadable = (): string => {
  throw new Error('ENOENT')
}

describe('terminalInjectionOff', () => {
  it('is true only when the kernel refuses TIOCSTI', () => {
    expect(terminalInjectionOff(refuses)).toBe(true)
    expect(terminalInjectionOff(allows)).toBe(false)
    expect(terminalInjectionOff(unreadable)).toBe(false)
  })
})

describe('needsPtyRelay', () => {
  it('relays on Linux wherever keys could be injected into the pane’s terminal', () => {
    expect(needsPtyRelay(false, allows, 'linux')).toBe(true)
    expect(needsPtyRelay(false, unreadable, 'linux')).toBe(true)
    expect(needsPtyRelay(false, refuses, 'linux')).toBe(false)
  })

  it('relays when forced, whatever the kernel says', () => {
    expect(needsPtyRelay(true, refuses, 'linux')).toBe(true)
  })

  it('never relays on another platform', () => {
    expect(needsPtyRelay(true, allows, 'darwin')).toBe(false)
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { asHumanPaste, humanInputSource } from './humanInput'

function duringEvent(event: Partial<Event>, read: () => void): void {
  Object.defineProperty(window, 'event', { value: event, configurable: true })
  try {
    read()
  } finally {
    Reflect.deleteProperty(window, 'event')
  }
}

describe('humanInputSource', () => {
  const host = document.createElement('div')
  const field = document.createElement('textarea')
  host.append(field)
  const outside = document.createElement('input')
  document.body.append(host, outside)

  afterEach(() => Reflect.deleteProperty(window, 'event'))

  it('is key for a real keystroke into this terminal', () => {
    duringEvent({ isTrusted: true, type: 'keydown', target: field }, () => {
      expect(humanInputSource(host)).toBe('key')
    })
  })

  it('is nothing outside an event, such as a command that pastes into the pane', () => {
    expect(humanInputSource(host)).toBeUndefined()
  })

  it('is nothing for a keystroke the page made up', () => {
    duringEvent({ isTrusted: false, type: 'keydown', target: field }, () => {
      expect(humanInputSource(host)).toBeUndefined()
    })
  })

  it('is nothing for a keystroke in another field, such as Enter in the command palette', () => {
    duringEvent({ isTrusted: true, type: 'keydown', target: outside }, () => {
      expect(humanInputSource(host)).toBeUndefined()
    })
  })

  it('is nothing for a click or a mouse paste', () => {
    for (const type of ['click', 'mouseup', 'auxclick', 'drop']) {
      duringEvent({ isTrusted: true, type, target: field }, () => {
        expect(humanInputSource(host)).toBeUndefined()
      })
    }
  })

  it('is paste only while a human paste runs, and not after it throws', () => {
    asHumanPaste(() => expect(humanInputSource(host)).toBe('paste'))
    expect(() =>
      asHumanPaste(() => {
        throw new Error('paste failed')
      }),
    ).toThrow('paste failed')
    expect(humanInputSource(host)).toBeUndefined()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIMARY_WRITE_DELAY_MS, installPrimarySelection } from './primarySelection'

function fakeTerm(selection: string) {
  let listener: (() => void) | null = null
  return {
    term: {
      onSelectionChange: (fn: () => void) => {
        listener = fn
        return {
          dispose: () => {
            listener = null
          },
        }
      },
      hasSelection: () => selection !== '',
      getSelection: () => selection,
    },
    select: () => listener?.(),
  }
}

describe('installPrimarySelection', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('puts the settled terminal selection in the primary selection once', () => {
    const host = document.createElement('div')
    const { term, select } = fakeTerm('git status')
    const writePrimary = vi.fn()
    installPrimarySelection(host, term as never, { enabled: () => true, writePrimary })
    select()
    select()
    vi.advanceTimersByTime(PRIMARY_WRITE_DELAY_MS)
    expect(writePrimary.mock.calls).toEqual([['git status']])
  })

  it('writes nothing and blocks the middle-click paste while it is off', () => {
    const host = document.createElement('div')
    const { term, select } = fakeTerm('git status')
    const writePrimary = vi.fn()
    installPrimarySelection(host, term as never, { enabled: () => false, writePrimary })
    select()
    vi.advanceTimersByTime(PRIMARY_WRITE_DELAY_MS)
    expect(writePrimary).not.toHaveBeenCalled()
    const middle = new MouseEvent('mouseup', { button: 1, cancelable: true })
    host.dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(true)
    const left = new MouseEvent('mouseup', { button: 0, cancelable: true })
    host.dispatchEvent(left)
    expect(left.defaultPrevented).toBe(false)
  })

  it('leaves the middle click alone while it is on, and stops after removal', () => {
    const host = document.createElement('div')
    const { term, select } = fakeTerm('x')
    const writePrimary = vi.fn()
    const remove = installPrimarySelection(host, term as never, {
      enabled: () => true,
      writePrimary,
    })
    const middle = new MouseEvent('mouseup', { button: 1, cancelable: true })
    host.dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(false)
    remove()
    select()
    vi.advanceTimersByTime(PRIMARY_WRITE_DELAY_MS)
    expect(writePrimary).not.toHaveBeenCalled()
  })
})

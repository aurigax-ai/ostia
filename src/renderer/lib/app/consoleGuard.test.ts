import { describe, expect, it } from 'vitest'
import {
  allowConsoleError,
  startConsoleGuard,
  stopConsoleGuard,
  takeUnexpectedConsoleErrors,
} from '../../../../test/consoleGuard'

describe('console guard', () => {
  it('records a console.error the test did not allow', () => {
    console.error('Warning: %s was not wrapped in act(...)', 'Thing')
    expect(takeUnexpectedConsoleErrors()).toEqual(['Warning: Thing was not wrapped in act(...)'])
  })

  it('lets through an error the test allowed', () => {
    allowConsoleError(/^\[settings\] save failed/)
    console.error('[settings] save failed', new Error('disk full'))
    expect(takeUnexpectedConsoleErrors()).toEqual([])
  })

  it('still records other errors when one pattern is allowed', () => {
    allowConsoleError(/^expected/)
    console.error('expected failure')
    console.error('surprise')
    expect(takeUnexpectedConsoleErrors()).toEqual(['surprise'])
  })

  it('fails the test at its end when an unexpected error was logged', () => {
    console.error('Warning: Function components cannot be given refs.')
    expect(() => stopConsoleGuard()).toThrow(/Function components cannot be given refs/)
    startConsoleGuard()
  })
})

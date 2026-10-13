import { describe, expect, it } from 'vitest'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { describeFailure, failureHint } from './failure'

describe('describeFailure', () => {
  it('appends the hint after the machine-readable message', () => {
    const err = new ResponseError(ErrorCodes.InvalidRequest, 'denied: shell', { hint: 'Ask.' })
    expect(describeFailure(err)).toBe('denied: shell. Ask.')
    expect(failureHint(err)).toBe('Ask.')
  })

  it('prints the bare message when there is no hint', () => {
    expect(describeFailure(new Error('boom'))).toBe('boom')
    expect(failureHint(new Error('boom'))).toBeUndefined()
  })
})

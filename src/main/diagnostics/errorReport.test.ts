import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppLog } from './appLog'
import { isErrno, reportError, setErrorSink } from './errorReport'

afterEach(() => setErrorSink(null))

describe('reportError', () => {
  it('writes the scope, error name and code, never the message', () => {
    const warn = vi.fn()
    setErrorSink({ file: '', info: vi.fn(), warn, error: vi.fn() } satisfies AppLog)
    const err = Object.assign(new Error('open /home/u/secret.txt failed'), { code: 'EIO' })
    reportError('fsText', err)
    expect(warn).toHaveBeenCalledWith('unexpected-error', {
      scope: 'fsText',
      name: 'Error',
      code: 'EIO',
    })
  })

  it('tells file system errors from other errors', () => {
    expect(isErrno(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(true)
    expect(isErrno(new TypeError('x'))).toBe(false)
    expect(isErrno(Object.assign(new TypeError('x'), { code: 'ERR_INVALID_ARG_TYPE' }))).toBe(false)
    expect(isErrno('ENOENT')).toBe(false)
  })
})

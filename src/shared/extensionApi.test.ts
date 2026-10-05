import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION, apiProblem, isApiCompatible, parseApiVersion } from './extensionApi'

describe('parseApiVersion', () => {
  it('reads major.minor and refuses anything else', () => {
    expect(parseApiVersion('1.0')).toEqual({ major: 1, minor: 0 })
    expect(parseApiVersion('12.34')).toEqual({ major: 12, minor: 34 })
    for (const bad of ['1', '1.0.0', 'v1.0', '01.0', '1.x', '', 1, null, undefined]) {
      expect(parseApiVersion(bad)).toBeNull()
    }
  })
})

describe('isApiCompatible', () => {
  it('accepts the same major with an equal or older minor', () => {
    const provided = { major: 2, minor: 3 }
    expect(isApiCompatible({ major: 2, minor: 3 }, provided)).toBe(true)
    expect(isApiCompatible({ major: 2, minor: 0 }, provided)).toBe(true)
  })

  it('refuses a newer minor and any other major', () => {
    const provided = { major: 2, minor: 3 }
    expect(isApiCompatible({ major: 2, minor: 4 }, provided)).toBe(false)
    expect(isApiCompatible({ major: 1, minor: 9 }, provided)).toBe(false)
    expect(isApiCompatible({ major: 3, minor: 0 }, provided)).toBe(false)
  })
})

describe('apiProblem', () => {
  it('says nothing for a version the app provides', () => {
    expect(apiProblem(EXTENSION_API_VERSION)).toBeNull()
    expect(apiProblem('2.1', '2.3')).toBeNull()
  })

  it('names both versions when they do not fit', () => {
    expect(apiProblem('2.4', '2.3')).toBe('needs extension API 2.4; this ostia provides 2.3')
    expect(apiProblem('1.0', '2.3')).toBe('needs extension API 1.0; this ostia provides 2.3')
    expect(apiProblem('soon', '2.3')).toBe('api must be an extension API version such as 1.0')
  })
})

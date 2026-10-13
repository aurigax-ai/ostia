import { describe, expect, it } from 'vitest'
import { parseDiscreteGpu, rendererDeviceName } from './discreteGpu'

describe('rendererDeviceName', () => {
  it('takes the device out of ANGLE’s renderer string', () => {
    expect(
      rendererDeviceName(
        'ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M Graphics (DG2), OpenGL ES 3.2)',
      ),
    ).toBe('Mesa Intel(R) Arc(tm) A370M Graphics (DG2)')
  })

  it('keeps any other renderer string as it is', () => {
    expect(rendererDeviceName('llvmpipe')).toBe('llvmpipe')
  })
})

describe('parseDiscreteGpu', () => {
  it('is on only for true', () => {
    expect(parseDiscreteGpu(true)).toBe(true)
    expect(parseDiscreteGpu('true')).toBe(false)
    expect(parseDiscreteGpu(undefined)).toBe(false)
  })
})

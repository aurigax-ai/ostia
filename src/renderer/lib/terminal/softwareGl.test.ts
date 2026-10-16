import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/app/usageCounts', () => ({ countUsage: vi.fn() }))

const { drawOnGpu, forgetProbe, isSoftwareRenderer } = await import('./softwareGl')

afterEach(forgetProbe)

describe('isSoftwareRenderer', () => {
  it('treats SwiftShader, llvmpipe and a missing context as software', () => {
    expect(
      isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader)'),
    ).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 17.0.6, 256 bits)')).toBe(true)
    expect(isSoftwareRenderer(null)).toBe(true)
  })

  it('treats a hardware device as hardware', () => {
    expect(
      isSoftwareRenderer('ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M Graphics, OpenGL 4.6)'),
    ).toBe(false)
  })
})

describe('drawOnGpu', () => {
  it('draws on the GPU when it was asked for and WebGL is hardware', () => {
    expect(drawOnGpu(true, () => 'ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M)', false)).toBe(true)
  })

  it('falls back to the non-GPU renderer when WebGL is software, for either engine', () => {
    expect(drawOnGpu(true, () => 'ANGLE (Google, SwiftShader Device)', false)).toBe(false)
  })

  it('falls back when WebGL is unavailable', () => {
    expect(drawOnGpu(true, () => null, false)).toBe(false)
  })

  it('never probes when the GPU was not asked for', () => {
    const probe = vi.fn(() => 'ANGLE (Intel, Arc)')
    expect(drawOnGpu(false, probe, false)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })

  it('keeps software WebGL when the launch flag allows it', () => {
    const probe = vi.fn(() => 'SwiftShader')
    expect(drawOnGpu(true, probe, true)).toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes once per page', () => {
    const probe = vi.fn(() => 'SwiftShader')
    drawOnGpu(true, probe, false)
    drawOnGpu(true, probe, false)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

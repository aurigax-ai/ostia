import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {} }))

const { gpuFacts } = await import('./gpuReport')

describe('gpuFacts', () => {
  it('names the renderer, the active device and the feature states without user content', () => {
    const facts = gpuFacts(
      { webgl: 'enabled', gpu_compositing: 'enabled', rasterization: 'disabled_software' },
      {
        gpuDevice: [
          { active: false, vendorId: 0x8086, deviceId: 0xa7a0 },
          { active: true, vendorId: 0x8086, deviceId: 0x56a5 },
        ],
        auxAttributes: { glRenderer: 'ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M)' },
      },
    )
    expect(facts).toMatchObject({
      glRenderer: 'ANGLE (Intel, Mesa Intel(R) Arc(tm) A370M)',
      devices: '8086:a7a0 *8086:56a5',
      webgl: 'enabled',
      rasterization: 'disabled_software',
    })
  })

  it('reports empty fields when Chromium has no GPU information', () => {
    expect(gpuFacts({}, {})).toMatchObject({ glRenderer: '', devices: '', webgl: '' })
  })
})

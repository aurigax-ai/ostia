import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  once: vi.fn(),
  on: vi.fn(),
  whenReady: vi.fn(async () => {}),
  getGPUInfo: vi.fn(async () => ({})),
  getGPUFeatureStatus: vi.fn(() => ({ gpu_compositing: 'enabled' })),
}))

vi.mock('electron', () => ({ app: electron }))

const { gpuFacts, registerGpuReport } = await import('./gpuReport')

describe('registerGpuReport', () => {
  it('GPU-U1 logs once the GPU process has reported, never at ready when every feature reads software', async () => {
    const log = { info: vi.fn(), warn: vi.fn() }
    registerGpuReport(log as never)
    await electron.whenReady()
    await Promise.resolve()
    expect(log.info).not.toHaveBeenCalled()

    const [event, update] = electron.once.mock.calls[0] as [string, () => void]
    expect(event).toBe('gpu-info-update')
    update()
    await vi.waitFor(() =>
      expect(log.info).toHaveBeenCalledWith(
        'gpu-info',
        expect.objectContaining({ gpuCompositing: 'enabled' }),
      ),
    )
  })
})

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

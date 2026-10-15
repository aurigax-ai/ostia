import { describe, expect, it } from 'vitest'
import { DEVICE_PRESETS, devicePreset, parseDevicePresets, presetUserAgent } from './devicePresets'
import presetData from './devicePresets.json'

const PIXEL = {
  title: 'Pixel 9',
  type: 'phone',
  screen: {
    horizontal: { width: 924, height: 412 },
    'device-pixel-ratio': 2.625,
    vertical: { width: 412, height: 924 },
  },
  capabilities: ['touch', 'mobile'],
  'user-agent':
    'Mozilla/5.0 (Linux; Android 14; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/%s Mobile Safari/537.36',
  'user-agent-metadata': {
    platform: 'Android',
    platformVersion: '14',
    architecture: '',
    model: 'Pixel 9',
    mobile: true,
  },
}

describe('device presets', () => {
  it('reads a DevTools device entry into its portrait size, pixel ratio, flags and agent', () => {
    expect(parseDevicePresets({ devices: [PIXEL] })).toEqual([
      {
        id: 'pixel-9',
        title: 'Pixel 9',
        width: 412,
        height: 924,
        dpr: 2.625,
        mobile: true,
        touch: true,
        userAgent: PIXEL['user-agent'],
        metadata: PIXEL['user-agent-metadata'],
      },
    ])
  })

  it('reads a device without capabilities as neither mobile nor touch', () => {
    const [desktop] = parseDevicePresets({ devices: [{ ...PIXEL, capabilities: undefined }] })
    expect(desktop).toMatchObject({ mobile: false, touch: false })
  })

  it('skips entries without a size, pixel ratio, agent or metadata, and repeated titles', () => {
    const broken = [
      { ...PIXEL, screen: { ...PIXEL.screen, vertical: { width: 0, height: 924 } } },
      { ...PIXEL, screen: { ...PIXEL.screen, 'device-pixel-ratio': 'x' } },
      { ...PIXEL, 'user-agent': 7 },
      { ...PIXEL, 'user-agent-metadata': { platform: 'Android' } },
      { ...PIXEL, title: '' },
      null,
      PIXEL,
      PIXEL,
    ]
    expect(parseDevicePresets({ devices: broken }).map((p) => p.id)).toEqual(['pixel-9'])
    expect(parseDevicePresets({})).toEqual([])
    expect(parseDevicePresets(null)).toEqual([])
  })

  it('ships every entry of the bundled list, phones and tablets alike', () => {
    expect(DEVICE_PRESETS).toHaveLength(presetData.devices.length)
    expect(DEVICE_PRESETS.map((p) => p.id)).toEqual([
      'iphone-se',
      'iphone-16',
      'pixel-9',
      'samsung-galaxy-s20-ultra',
      'ipad-mini',
      'ipad-pro-13',
      'galaxy-tab-s4',
    ])
    expect(devicePreset('iphone-se')).toMatchObject({ width: 375, height: 667, dpr: 2 })
    expect(devicePreset('responsive')).toBeUndefined()
  })

  it('names the running Chrome major version in a Chrome agent, and leaves Safari agents alone', () => {
    const pixel = devicePreset('pixel-9')
    const iphone = devicePreset('iphone-se')
    if (!pixel || !iphone) throw new Error('missing preset')
    expect(presetUserAgent(pixel, '152.0.7977.130')).toContain('Chrome/152.0.0.0 Mobile Safari')
    expect(presetUserAgent(iphone, '152.0.7977.130')).toBe(iphone.userAgent)
  })
})

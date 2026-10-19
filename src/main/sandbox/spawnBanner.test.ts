import { describe, expect, it } from 'vitest'
import { en } from '../../shared/app/dict'
import { hiddenHomeNotice, missingPackages, sandboxFailureBanner } from './spawnBanner'

const t = en.native.paneBanner

describe('hiddenHomeNotice', () => {
  it('tells a Linux shell that writes to the hidden home folder are discarded, and how to keep them', () => {
    const notice = hiddenHomeNotice(t, 'linux')
    expect(notice).toContain('your home folder is hidden here')
    expect(notice).toContain('are discarded when this shell exits')
    expect(notice).toContain('Add a writable folder')
    expect(notice.endsWith('\x1b[0m\r\n')).toBe(true)
  })

  it('fits an 80-column pane without wrapping', () => {
    const lines = hiddenHomeNotice(t, 'linux')
      .replaceAll('\x1b[2m', '')
      .replaceAll('\x1b[0m', '')
      .split('\r\n')
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(80)
  })

  it('says nothing on macOS, where a write to the hidden home fails with an error', () => {
    expect(hiddenHomeNotice(t, 'darwin')).toBe('')
  })
})

describe('sandboxFailureBanner', () => {
  it('names the packages behind the missing programs and how to install them', () => {
    expect(missingPackages(['bwrap not found', 'socat is missing', 'unrelated'])).toEqual([
      'bubblewrap',
      'socat',
    ])
    const banner = sandboxFailureBanner(t, 'cannot start', ['bwrap not found'])
    expect(banner).toContain('Sandbox unavailable: cannot start')
    expect(banner).toContain('ostia system install bubblewrap')
    expect(banner).toContain('No shell was started')
  })
})

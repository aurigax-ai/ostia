import { describe, expect, it } from 'vitest'
import { BrowserFence } from './browserFence'

function setup(browser: 'allowlist' | 'unrestricted' = 'allowlist') {
  const domains = ['api.github.com', '*.example.org']
  const asked: string[] = []
  let answer = false
  const fence = new BrowserFence({
    policy: (workspaceId) => (workspaceId === 'sbx' ? { browser, domains } : null),
    requestDomain: async (_ws, host) => {
      asked.push(host)
      if (answer) domains.push(host)
      return answer
    },
  })
  const allow = (): void => {
    answer = true
  }
  return { fence, asked, allow }
}

describe('BrowserFence', () => {
  it('SBX-C52 holds a browse to a host not allowed, asks, and lets the retry through once allowed', async () => {
    const { fence, asked, allow } = setup()
    expect(fence.allowedNow('sbx', 'https://api.github.com/x')).toBe(true)
    expect(fence.allowedNow('sbx', 'https://docs.example.org/')).toBe(true)
    await expect(fence.check('sbx', 'https://example.com/')).resolves.toBe(false)
    expect(asked).toEqual(['example.com'])
    allow()
    await expect(fence.check('sbx', 'https://example.com/')).resolves.toBe(true)
    expect(fence.allowedNow('sbx', 'https://example.com/page')).toBe(true)
    expect(fence.allowedNow('plain', 'https://anything.test/')).toBe(true)
  })

  it('SBX-C53 blocks a redirect or navigation to a host not allowed, and non-web schemes', () => {
    const { fence } = setup()
    expect(fence.allowedNow('sbx', 'https://evil.test/login')).toBe(false)
    expect(fence.allowedNow('sbx', 'file:///etc/passwd')).toBe(false)
    expect(fence.allowedNow('sbx', 'http://127.0.0.1:3000/')).toBe(false)
    const open = setup('unrestricted')
    expect(open.fence.allowedNow('sbx', 'https://evil.test/login')).toBe(true)
  })

  it('refuses a blocked host in the browser without asking, even when a wider rule allows it', async () => {
    const asked: string[] = []
    const fence = new BrowserFence({
      policy: () => ({
        browser: 'allowlist',
        domains: ['*.example.org'],
        denied: ['ads.example.org', 'tracker.test'],
      }),
      requestDomain: async (_ws, host) => {
        asked.push(host)
        return true
      },
    })
    expect(fence.allowedNow('sbx', 'https://docs.example.org/')).toBe(true)
    expect(fence.allowedNow('sbx', 'https://ads.example.org/pixel')).toBe(false)
    await expect(fence.check('sbx', 'https://ads.example.org/pixel')).resolves.toBe(false)
    await expect(fence.check('sbx', 'https://tracker.test/')).resolves.toBe(false)
    expect(asked).toEqual([])
  })
})

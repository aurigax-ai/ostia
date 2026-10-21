import { describe, expect, it, vi } from 'vitest'
import {
  type AgentGuest,
  type AgentSession,
  type BrowserAgents,
  browserAgents,
  ELECTRON_AGENT_HOSTS,
  electronAgentMetadata,
  followAgentByHost,
  restartAfterAgent,
  setDeviceAgent,
  useBrowserAgents,
  wantsElectronAgent,
} from './signinUserAgent'

const ELECTRON =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ostia/0.5.10 Chrome/152.0.7977.130 Electron/44.5.1 Safari/537.36'
const REWRITTEN =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36'
const HOST = {
  chromeVersion: '152.0.7977.130',
  platform: 'darwin',
  systemVersion: '26.1',
  arch: 'arm64',
} as const

const agents: BrowserAgents = browserAgents(ELECTRON, 'ostia', HOST)

type Listener = Parameters<AgentSession['webRequest']['onBeforeSendHeaders']>[0]

function fakeSession(): {
  session: AgentSession
  send: (url: string, webContentsId?: number) => Record<string, string>
} {
  let listener: Listener | null = null
  let agent = ELECTRON
  const session: AgentSession = {
    getUserAgent: () => agent,
    setUserAgent: vi.fn((next: string) => {
      agent = next
    }),
    webRequest: {
      onBeforeSendHeaders: vi.fn((next: Listener) => {
        listener = next
      }),
    },
  }
  const send = (url: string, webContentsId?: number): Record<string, string> => {
    let sent: Record<string, string> = {}
    listener?.(
      { url, webContentsId, requestHeaders: { Accept: '*/*', 'User-Agent': ELECTRON } },
      (response) => {
        sent = response.requestHeaders
      },
    )
    return sent
  }
  return { session, send }
}

type NavigationListener = (details: {
  url: string
  isMainFrame: boolean
  isSameDocument?: boolean
}) => void

let nextGuestId = 1

function fakeGuest(): {
  guest: AgentGuest
  sendCommand: ReturnType<typeof vi.fn>
  emit: (
    event: string,
    url: string,
    extra?: { isMainFrame?: boolean; isSameDocument?: boolean },
  ) => void
} {
  const listeners = new Map<string, NavigationListener[]>()
  const sendCommand = vi.fn(() => new Promise<unknown>(() => {}))
  const guest: AgentGuest = {
    id: nextGuestId++,
    debugger: { isAttached: () => true, sendCommand },
    on: (event: string, listener: NavigationListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return guest
    },
  }
  const emit = (
    event: string,
    url: string,
    extra: { isMainFrame?: boolean; isSameDocument?: boolean } = {},
  ): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener({
        url,
        isMainFrame: extra.isMainFrame ?? true,
        isSameDocument: extra.isSameDocument ?? false,
      })
    }
  }
  return { guest, sendCommand, emit }
}

function overrides(sendCommand: ReturnType<typeof vi.fn>): string[] {
  return sendCommand.mock.calls
    .filter(([method]) => method === 'Emulation.setUserAgentOverride')
    .map(([, params]) => (params as { userAgent: string }).userAgent)
}

describe('wantsElectronAgent', () => {
  it('matches the Google sign-in hosts on any port and in any case', () => {
    expect(ELECTRON_AGENT_HOSTS).toEqual(['accounts.google.com', 'accounts.youtube.com'])
    expect(wantsElectronAgent('https://accounts.google.com/v3/signin/identifier?flow=1')).toBe(true)
    expect(wantsElectronAgent('https://accounts.youtube.com/accounts/CheckConnection')).toBe(true)
    expect(wantsElectronAgent('http://ACCOUNTS.Google.com/')).toBe(true)
    expect(wantsElectronAgent('https://accounts.google.com:8443/')).toBe(true)
  })

  it('takes exact hosts only, so subdomains, parents and look-alikes keep the rewritten agent', () => {
    for (const url of [
      'https://docs.google.com/',
      'https://mail.google.com/mail/u/0/',
      'https://myaccount.google.com/',
      'https://google.com/',
      'https://www.youtube.com/',
      'https://foo.accounts.google.com/',
      'https://accounts.google.com./',
      'https://accounts.google.com.tw/',
      'https://accounts.google.co.jp/',
      'https://accounts.google.com.evil.example/',
      'https://evil.example/accounts.google.com',
      'https://evil.example/?next=https://accounts.google.com/',
      'https://web.whatsapp.com/',
      'https://teams.microsoft.com/',
    ]) {
      expect(wantsElectronAgent(url), url).toBe(false)
    }
  })

  it('goes by host alone, so sockets to a sign-in host match and URLs without one do not', () => {
    expect(wantsElectronAgent('wss://accounts.google.com/socket')).toBe(true)
    for (const url of [
      'blob:https://accounts.google.com/0b1c',
      'file:///accounts.google.com',
      'about:blank',
      'data:text/html,accounts.google.com',
      'accounts.google.com',
      '',
    ]) {
      expect(wantsElectronAgent(url), url).toBe(false)
    }
  })
})

describe('browserAgents', () => {
  it('keeps the rewritten agent as the default and the Electron agent untouched', () => {
    expect(agents.rewritten).toBe(REWRITTEN)
    expect(agents.electron).toBe(ELECTRON)
  })

  it('describes Electron as plain Chromium without a Google Chrome brand', () => {
    expect(electronAgentMetadata(HOST)).toEqual({
      brands: [
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Chromium', version: '152' },
      ],
      fullVersionList: [
        { brand: 'Not?A_Brand', version: '24.0.0.0' },
        { brand: 'Chromium', version: '152.0.7977.130' },
      ],
      fullVersion: '152.0.7977.130',
      platform: 'macOS',
      platformVersion: '26.1.0',
      architecture: 'arm',
      model: '',
      mobile: false,
      bitness: '64',
      wow64: false,
    })
    const linux = electronAgentMetadata({
      ...HOST,
      platform: 'linux',
      systemVersion: '6.17.2-arch1-1',
      arch: 'x64',
    })
    expect(linux).toMatchObject({
      platform: 'Linux',
      platformVersion: '6.17.2',
      architecture: 'x86',
    })
  })
})

describe('useBrowserAgents', () => {
  it('sets the rewritten agent on the session and the Electron agent only on sign-in requests', () => {
    const { session, send } = fakeSession()
    expect(useBrowserAgents(session, 'ostia', HOST)).toEqual(agents)
    expect(session.setUserAgent).toHaveBeenCalledWith(REWRITTEN)
    expect(send('https://docs.google.com/')['User-Agent']).toBe(REWRITTEN)
    expect(send('https://accounts.google.com/ServiceLogin')['User-Agent']).toBe(ELECTRON)
    expect(send('https://accounts.youtube.com/accounts/CheckConnection')['User-Agent']).toBe(
      ELECTRON,
    )
    expect(send('https://ssl.gstatic.com/logo.png')['User-Agent']).toBe(REWRITTEN)
  })

  it('sets the rewritten agent on the first request after leaving the sign-in hosts', () => {
    const { session, send } = fakeSession()
    useBrowserAgents(session, 'ostia', HOST)
    expect(send('https://accounts.google.com/')['User-Agent']).toBe(ELECTRON)
    expect(send('https://web.whatsapp.com/')['User-Agent']).toBe(REWRITTEN)
    expect(send('https://docs.google.com/document/d/x')['User-Agent']).toBe(REWRITTEN)
  })

  it('replaces the agent header whatever its case and keeps the other headers', () => {
    const { session } = fakeSession()
    useBrowserAgents(session, 'ostia', HOST)
    const listener = vi.mocked(session.webRequest.onBeforeSendHeaders).mock.calls[0][0]
    let sent: Record<string, string> = {}
    listener(
      {
        url: 'https://web.whatsapp.com/',
        requestHeaders: { 'user-agent': ELECTRON, Cookie: 'a=1' },
      },
      (response) => {
        sent = response.requestHeaders
      },
    )
    expect(sent).toEqual({ Cookie: 'a=1', 'User-Agent': REWRITTEN })
  })

  it('reads the Electron agent once per session, before rewriting it, however many guests share it', () => {
    const { session, send } = fakeSession()
    useBrowserAgents(session, 'ostia', HOST)
    expect(useBrowserAgents(session, 'ostia', HOST)).toEqual(agents)
    expect(session.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1)
    expect(session.setUserAgent).toHaveBeenCalledTimes(1)
    expect(send('https://accounts.google.com/')['User-Agent']).toBe(ELECTRON)
  })
})

describe('followAgentByHost', () => {
  it('overrides the page agent when a main-frame navigation enters or leaves the sign-in hosts', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    expect(overrides(sendCommand)).toEqual([REWRITTEN])
    emit('did-start-navigation', 'https://example.com/')
    emit('did-start-navigation', 'https://docs.google.com/')
    expect(overrides(sendCommand)).toEqual([REWRITTEN])
    emit('did-redirect-navigation', 'https://accounts.google.com/ServiceLogin')
    expect(overrides(sendCommand)).toEqual([REWRITTEN, ELECTRON])
    emit('did-start-navigation', 'https://accounts.google.com/v3/signin')
    emit('did-start-navigation', 'https://web.whatsapp.com/')
    expect(overrides(sendCommand)).toEqual([REWRITTEN, ELECTRON, REWRITTEN])
    expect(sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', {
      userAgent: ELECTRON,
      userAgentMetadata: agents.metadata,
    })
  })

  it('starts from the agent of the address a popup opens at', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents, 'https://accounts.google.com/o/oauth2/auth')
    expect(overrides(sendCommand)).toEqual([ELECTRON])
    emit('did-start-navigation', 'https://accounts.google.com/v3/signin')
    emit('did-start-navigation', 'https://example.com/callback')
    expect(overrides(sendCommand)).toEqual([ELECTRON, REWRITTEN])
  })

  it('leaves subframes and same-document navigations alone', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    emit('did-start-navigation', 'https://accounts.youtube.com/', { isMainFrame: false })
    emit('did-redirect-navigation', 'https://accounts.google.com/', { isMainFrame: false })
    emit('did-start-navigation', 'https://accounts.google.com/#x', { isSameDocument: true })
    expect(overrides(sendCommand)).toEqual([REWRITTEN])
  })

  it('does not wait for the override, which only answers once the navigation proceeds', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    emit('did-start-navigation', 'https://accounts.google.com/')
    emit('did-start-navigation', 'https://docs.google.com/')
    emit('did-start-navigation', 'https://accounts.google.com/')
    expect(overrides(sendCommand)).toEqual([REWRITTEN, ELECTRON, REWRITTEN, ELECTRON])
  })

  it('swallows a failed override', async () => {
    const { guest, sendCommand, emit } = fakeGuest()
    sendCommand.mockImplementation(() => Promise.reject(new Error('detached')))
    followAgentByHost(guest, agents)
    emit('did-start-navigation', 'https://accounts.google.com/')
    await Promise.resolve()
    expect(overrides(sendCommand)).toEqual([REWRITTEN, ELECTRON])
  })

  it('follows each guest once and skips a guest without a debugger', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    followAgentByHost(guest, agents)
    emit('did-start-navigation', 'https://accounts.google.com/')
    expect(overrides(sendCommand)).toEqual([REWRITTEN, ELECTRON])

    const detached = fakeGuest()
    detached.guest.debugger.isAttached = () => false
    followAgentByHost(detached.guest, agents)
    detached.emit('did-start-navigation', 'https://accounts.google.com/')
    expect(detached.sendCommand).not.toHaveBeenCalled()
  })
})

describe('restartAfterAgent', () => {
  const SIGNIN = 'https://accounts.google.com/signin'

  function slowGuest() {
    const fake = fakeGuest()
    let ack: () => void = () => {}
    fake.sendCommand.mockImplementation(
      () =>
        new Promise<unknown>((resolve) => {
          ack = () => resolve({})
        }),
    )
    followAgentByHost(fake.guest, agents)
    fake.emit('did-start-navigation', 'https://example.com/')
    return { ...fake, ack: () => ack() }
  }

  it('hands back the agent switch of a redirect into a sign-in host until it is acknowledged', async () => {
    const { guest, emit, ack } = slowGuest()
    emit('did-redirect-navigation', SIGNIN)
    const restart = restartAfterAgent(guest.id, SIGNIN, 'GET')
    expect(restart).toBeDefined()
    let released = false
    void restart?.then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    ack()
    await restart
    expect(released).toBe(true)
    expect(restartAfterAgent(guest.id, SIGNIN, 'GET')).toBeUndefined()
  })

  it('hands it back once per redirect', () => {
    const { guest, emit } = slowGuest()
    emit('did-redirect-navigation', SIGNIN)
    expect(restartAfterAgent(guest.id, SIGNIN, 'GET')).toBeDefined()
    expect(restartAfterAgent(guest.id, SIGNIN, 'GET')).toBeUndefined()
  })

  it('leaves POST requests and other addresses alone', () => {
    const { guest, emit } = slowGuest()
    emit('did-redirect-navigation', SIGNIN)
    expect(restartAfterAgent(guest.id, SIGNIN, 'POST')).toBeUndefined()
    expect(restartAfterAgent(guest.id, 'https://example.com/other', 'GET')).toBeUndefined()
    expect(restartAfterAgent(guest.id, SIGNIN, 'GET')).toBeDefined()
  })

  it('leaves a redirect that keeps the agent alone', () => {
    const { guest, emit } = slowGuest()
    emit('did-redirect-navigation', 'https://docs.google.com/')
    expect(restartAfterAgent(guest.id, 'https://docs.google.com/', 'GET')).toBeUndefined()
  })

  it('does not restart a plain navigation into a sign-in host', () => {
    const { guest, emit } = slowGuest()
    emit('did-start-navigation', SIGNIN)
    expect(restartAfterAgent(guest.id, SIGNIN, 'GET')).toBeUndefined()
  })
})

describe('setDeviceAgent', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) Mobile/15E148 Safari/604.1'
  const device = { userAgent: IPHONE, metadata: { ...agents.metadata, mobile: true } }

  it('sends the device agent from that guest only, sign-in hosts included, until cleared', () => {
    const { session, send } = fakeSession()
    useBrowserAgents(session, 'ostia', HOST)
    const { guest } = fakeGuest()
    followAgentByHost(guest, agents)
    setDeviceAgent(guest.id, device)
    expect(send('https://example.com/', guest.id)['User-Agent']).toBe(IPHONE)
    expect(send('https://accounts.google.com/', guest.id)['User-Agent']).toBe(IPHONE)
    expect(send('https://example.com/', guest.id + 1000)['User-Agent']).toBe(REWRITTEN)
    expect(send('https://example.com/')['User-Agent']).toBe(REWRITTEN)
    setDeviceAgent(guest.id, null)
    expect(send('https://example.com/', guest.id)['User-Agent']).toBe(REWRITTEN)
  })

  it('overrides the page agent with the device and its metadata, and navigation keeps it', () => {
    const { guest, sendCommand, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    setDeviceAgent(guest.id, device)
    expect(sendCommand).toHaveBeenLastCalledWith('Emulation.setUserAgentOverride', {
      userAgent: IPHONE,
      userAgentMetadata: device.metadata,
    })
    emit('did-start-navigation', 'https://accounts.google.com/')
    expect(overrides(sendCommand)).toEqual([REWRITTEN, IPHONE])
    setDeviceAgent(guest.id, null)
    expect(overrides(sendCommand)).toEqual([REWRITTEN, IPHONE, ELECTRON])
  })

  it('forgets the device agent when the guest is destroyed', () => {
    const { session, send } = fakeSession()
    useBrowserAgents(session, 'ostia', HOST)
    const { guest, emit } = fakeGuest()
    followAgentByHost(guest, agents)
    setDeviceAgent(guest.id, device)
    emit('destroyed', '')
    expect(send('https://example.com/', guest.id)['User-Agent']).toBe(REWRITTEN)
  })
})

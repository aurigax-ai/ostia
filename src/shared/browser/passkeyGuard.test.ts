import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { PASSKEY_GUARD_JS, PASSKEY_NOTICE_PREFIX } from './passkeyGuard'

type Call = { name: string; options: unknown }

function pageWith(capabilities?: Record<string, boolean>) {
  const calls: Call[] = []
  const info = vi.fn()
  const proto = {
    create(options: unknown) {
      calls.push({ name: 'create', options })
      return Promise.resolve('created')
    },
    get(options: unknown) {
      calls.push({ name: 'get', options })
      return Promise.resolve('got')
    },
  }
  const credentials = Object.create(proto)
  const PublicKeyCredential = capabilities
    ? { getClientCapabilities: () => Promise.resolve({ ...capabilities }) }
    : {}
  const sandbox: Record<string, unknown> = {
    navigator: { credentials },
    PublicKeyCredential,
    DOMException,
    console: { info },
  }
  sandbox.window = sandbox
  runInNewContext(PASSKEY_GUARD_JS, sandbox)
  return { credentials, calls, info, sandbox }
}

const allow = (transports?: string[]) => ({
  publicKey: { allowCredentials: [{ id: new Uint8Array(4), type: 'public-key', transports }] },
})

describe('navigator.credentials.get', () => {
  it.each([
    ['internal only', ['internal']],
    ['hybrid only', ['hybrid']],
    ['internal and hybrid', ['internal', 'hybrid']],
  ])('rejects at once with NotAllowedError when the credential is %s', async (_n, transports) => {
    const { credentials, calls } = pageWith()
    await expect(credentials.get(allow(transports))).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    expect(calls).toEqual([])
  })

  it.each([
    ['usb', ['usb']],
    ['nfc', ['nfc']],
    ['ble', ['ble']],
    ['usb with hybrid', ['hybrid', 'usb']],
    ['no transports', undefined],
    ['empty transports', []],
  ])('passes the request through when the credential lists %s', async (_n, transports) => {
    const { credentials, calls } = pageWith()
    await expect(credentials.get(allow(transports))).resolves.toBe('got')
    expect(calls).toHaveLength(1)
  })

  it('passes through when any one credential could be a security key', async () => {
    const { credentials, calls } = pageWith()
    const options = {
      publicKey: {
        allowCredentials: [
          { id: new Uint8Array(4), type: 'public-key', transports: ['internal'] },
          { id: new Uint8Array(4), type: 'public-key', transports: ['usb'] },
        ],
      },
    }
    await expect(credentials.get(options)).resolves.toBe('got')
    expect(calls).toHaveLength(1)
  })

  it('passes through discoverable requests, conditional mediation and non-publicKey requests', async () => {
    const { credentials, calls } = pageWith()
    await expect(credentials.get({ publicKey: { challenge: new Uint8Array(4) } })).resolves.toBe(
      'got',
    )
    await expect(
      credentials.get({ mediation: 'conditional', ...allow(['internal']) }),
    ).resolves.toBe('got')
    await expect(credentials.get({ password: true })).resolves.toBe('got')
    await expect(credentials.get()).resolves.toBe('got')
    expect(calls).toHaveLength(4)
  })
})

describe('navigator.credentials.create', () => {
  it('rejects at once with NotAllowedError for a platform-only authenticator', async () => {
    const { credentials, calls } = pageWith()
    const options = {
      publicKey: { authenticatorSelection: { authenticatorAttachment: 'platform' } },
    }
    await expect(credentials.create(options)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(calls).toEqual([])
  })

  it.each([
    ['cross-platform', { authenticatorSelection: { authenticatorAttachment: 'cross-platform' } }],
    ['unrestricted', { authenticatorSelection: { userVerification: 'preferred' } }],
    ['no selection', {}],
  ])('passes the request through when it is %s', async (_n, publicKey) => {
    const { credentials, calls } = pageWith()
    await expect(credentials.create({ publicKey })).resolves.toBe('created')
    expect(calls).toHaveLength(1)
  })
})

describe('notice', () => {
  it('logs the notice once per page, however many requests are refused', async () => {
    const { credentials, info } = pageWith()
    await credentials.get(allow(['internal'])).catch(() => undefined)
    await credentials.get(allow(['hybrid'])).catch(() => undefined)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(PASSKEY_NOTICE_PREFIX)
  })

  it('stays silent when the request is passed through', async () => {
    const { credentials, info } = pageWith()
    await credentials.get(allow(['usb']))
    expect(info).not.toHaveBeenCalled()
  })
})

describe('PublicKeyCredential.getClientCapabilities', () => {
  it('stops claiming passkey, hybrid and platform verifier support', async () => {
    const { sandbox } = pageWith({
      passkeyPlatformAuthenticator: true,
      hybridTransport: true,
      userVerifyingPlatformAuthenticator: true,
      conditionalGet: true,
    })
    const pkc = sandbox.PublicKeyCredential as { getClientCapabilities: () => Promise<unknown> }
    await expect(pkc.getClientCapabilities()).resolves.toEqual({
      passkeyPlatformAuthenticator: false,
      hybridTransport: false,
      userVerifyingPlatformAuthenticator: false,
      conditionalGet: true,
    })
  })

  it('does nothing when the page has no getClientCapabilities', () => {
    const { sandbox } = pageWith()
    expect(sandbox.PublicKeyCredential).toEqual({})
  })
})

describe('installation', () => {
  it('wraps once even when the script runs twice in the same page', async () => {
    const { credentials, calls, sandbox } = pageWith()
    runInNewContext(PASSKEY_GUARD_JS, sandbox)
    await expect(credentials.get(allow(['usb']))).resolves.toBe('got')
    expect(calls).toHaveLength(1)
  })
})

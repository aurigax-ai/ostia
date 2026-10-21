import { createPublicKey, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { generateDeviceKeys, registrationOf } from './deviceKeys'
import { DeviceSigner } from './deviceSigner'
import { ServerError } from './serverClient'

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

function setup(now = () => 1_700_000_000_000) {
  const keys = generateDeviceKeys()
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_ED25519, Buffer.from(registrationOf(keys).signPub, 'base64url')]),
    format: 'der',
    type: 'spki',
  })
  const signer = new DeviceSigner({ keys: () => keys, deviceId: () => 'dev-1', now })
  const valid = (message: string, signature: string): boolean =>
    verify(null, Buffer.from(message), publicKey, Buffer.from(signature, 'base64url'))
  return { signer, valid }
}

describe('device signatures', () => {
  it('SSY-C1 signs the invite and elevation messages with a timestamp header', async () => {
    const { signer, valid } = setup()
    const invite = await signer.signed('invite', async (headers) => headers)
    expect(invite['X-Device-Timestamp']).toBe('1700000000000')
    expect(
      valid('ostia-server/invite/v1\ndev-1\n1700000000000', invite['X-Device-Signature']),
    ).toBe(true)
    const elevate = await signer.signed('elevate', async (headers) => headers)
    expect(elevate['X-Device-Timestamp']).toBe('1700000000001')
    expect(
      valid('ostia-server/elevate/v1\ndev-1\n1700000000001', elevate['X-Device-Signature']),
    ).toBe(true)
  })

  it('SSY-C2 keeps timestamps strictly increasing when the clock does not move', async () => {
    const { signer } = setup()
    const stamps: number[] = []
    for (let i = 0; i < 3; i += 1) {
      stamps.push(Number((await signer.signed('invite', async (h) => h))['X-Device-Timestamp']))
    }
    expect(stamps).toEqual([1_700_000_000_000, 1_700_000_000_001, 1_700_000_000_002])
  })

  it('SSY-C162 sends signed requests one at a time, in the order they were asked for', async () => {
    const { signer } = setup()
    const events: string[] = []
    const release: Array<() => void> = []
    const run = (name: string) =>
      signer.signed('wrapRead', async () => {
        events.push(`${name} start`)
        await new Promise<void>((resolve) => release.push(resolve))
        events.push(`${name} end`)
      })
    const all = Promise.all([run('a'), run('b')])
    await vi.waitFor(() => expect(release).toHaveLength(1))
    expect(events).toEqual(['a start'])
    release[0]?.()
    await vi.waitFor(() => expect(release).toHaveLength(2))
    expect(events).toEqual(['a start', 'a end', 'b start'])
    release[1]?.()
    await all
  })

  it('SSY-C163 keeps the queue running after a request fails', async () => {
    const { signer } = setup()
    await expect(
      signer.signed('wrapRead', () => Promise.reject(new ServerError(500, 'failed'))),
    ).rejects.toMatchObject({ status: 500 })
    await expect(signer.signed('wrapRead', async () => 'next')).resolves.toBe('next')
  })

  it('SSY-C164 signs again once on stale-signature, with a later timestamp, and not twice', async () => {
    const { signer } = setup()
    const stamps: string[] = []
    const stale = (headers: Record<string, string>) => {
      stamps.push(headers['X-Device-Timestamp'] ?? '')
      return Promise.reject(new ServerError(403, 'stale-signature'))
    }
    await expect(signer.signed('manifestPut', stale)).rejects.toMatchObject({
      code: 'stale-signature',
    })
    expect(stamps).toEqual(['1700000000000', '1700000000001'])
    let calls = 0
    await expect(
      signer.signed('manifestPut', () => {
        calls += 1
        return Promise.reject(new ServerError(403, 'bad-signature'))
      }),
    ).rejects.toMatchObject({ code: 'bad-signature' })
    expect(calls).toBe(1)
  })

  it('SSY-C165 stamps from the clock the server just gave after a future offset was refused as stale', async () => {
    const { signer } = setup()
    const now = 1_700_000_000_000
    signer.observeServerTime(now + 20 * 60_000)
    const sent: number[] = []
    const refuseFirst = (headers: Record<string, string>) => {
      sent.push(Number(headers['X-Device-Timestamp']))
      return sent.length === 1
        ? Promise.reject(new ServerError(403, 'stale-signature', null, now))
        : Promise.resolve(headers)
    }
    await signer.signed('invite', refuseFirst)
    expect(sent).toEqual([now + 10 * 60_000, now])
    const next = await signer.signed('invite', async (h) => h)
    expect(next['X-Device-Timestamp']).toBe(String(now + 1))
  })

  it('SSY-C169 counts any answer but a signature refusal as having used the stamp', async () => {
    const { signer } = setup()
    const now = 1_700_000_000_000
    await expect(
      signer.signed('manifestPut', () => Promise.reject(new ServerError(412, 'version-mismatch'))),
    ).rejects.toMatchObject({ status: 412 })
    await expect(
      signer.signed('manifestPut', () => Promise.reject(new ServerError(403, 'bad-signature'))),
    ).rejects.toMatchObject({ code: 'bad-signature' })
    const next = await signer.signed('manifestPut', async (h) => h)
    expect(next['X-Device-Timestamp']).toBe(String(now + 1))
  })

  it('SSY-C168 signs the bound fields after the timestamp', async () => {
    const { signer, valid } = setup()
    const headers = await signer.signed('wrapRead', async (h) => h, ['passphrase'])
    expect(
      valid(
        'ostia-server/wrap-read/v1\ndev-1\n1700000000000\npassphrase',
        headers['X-Device-Signature'],
      ),
    ).toBe(true)
    const put = await signer.signed('manifestPut', async (h) => h, ['3', 'hash'])
    expect(
      valid(
        'ostia-server/manifest-put/v1\ndev-1\n1700000000001\n3\nhash',
        put['X-Device-Signature'],
      ),
    ).toBe(true)
  })

  it('SSY-C3 signs revoke, approve and seen over the exact messages', () => {
    const { signer, valid } = setup()
    expect(
      valid('ostia-server/revoke/v1\ndev-1\ndev-2', signer.revoke('dev-2')['X-Device-Signature']),
    ).toBe(true)
    expect(
      valid(
        'ostia-server/approve/v1\ndev-1\napproval-9\ndev-3',
        signer.approve('approval-9', 'dev-3')['X-Device-Signature'],
      ),
    ).toBe(true)
  })

  it('SSY-C4 refuses to sign when signed out', () => {
    const signer = new DeviceSigner({ keys: () => null, deviceId: () => null })
    expect(() => signer.revoke('x')).toThrow(/not-signed-in/)
  })
})

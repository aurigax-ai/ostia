import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import linkVectors from '../../../../test/fixtures/server/vectors/link.json'
import { linkCode } from './syncLink'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function expected(joinerSign: Buffer, joinerBox: Buffer, approverSign: Buffer): string {
  const digest = createHash('sha256')
    .update(
      Buffer.concat([
        Buffer.from('ostia-sync/link-code/v1\n'),
        joinerSign,
        joinerBox,
        approverSign,
      ]),
    )
    .digest()
  let value = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`) >> 3n
  let chars = ''
  for (let i = 0; i < 25; i++) {
    chars = ALPHABET[Number(value & 31n)] + chars
    value >>= 5n
  }
  return chars.match(/.{5}/g)?.join('-') ?? ''
}

const bytes = (fill: number): Buffer => Buffer.alloc(32, fill)
const b64 = (buffer: Buffer): string => buffer.toString('base64url')

describe('the link code', () => {
  it('SSY-C154 is the first 125 bits of SHA-256 over the domain and the three keys, as 5 groups of 5', () => {
    const code = linkCode({ signPub: b64(bytes(1)), boxPub: b64(bytes(2)) }, b64(bytes(3)))
    expect(code).toBe(expected(bytes(1), bytes(2), bytes(3)))
    expect(code).toMatch(/^([A-Z2-7]{5}-){4}[A-Z2-7]{5}$/)
  })

  it('SSY-C155 changes when any of the three keys changes', () => {
    const base = linkCode({ signPub: b64(bytes(1)), boxPub: b64(bytes(2)) }, b64(bytes(3)))
    expect(linkCode({ signPub: b64(bytes(9)), boxPub: b64(bytes(2)) }, b64(bytes(3)))).not.toBe(
      base,
    )
    expect(linkCode({ signPub: b64(bytes(1)), boxPub: b64(bytes(9)) }, b64(bytes(3)))).not.toBe(
      base,
    )
    expect(linkCode({ signPub: b64(bytes(1)), boxPub: b64(bytes(2)) }, b64(bytes(9)))).not.toBe(
      base,
    )
  })

  it('SSY-C158 matches the server vector and changes with a swapped box key', () => {
    const joiner = { signPub: linkVectors.joinerSignPub, boxPub: linkVectors.joinerBoxPub }
    expect(linkCode(joiner, linkVectors.approverSignPub)).toBe(linkVectors.linkCode)
    expect(
      linkCode({ ...joiner, boxPub: linkVectors.swappedJoinerBoxPub }, linkVectors.approverSignPub),
    ).toBe(linkVectors.swappedBoxLinkCode)
  })
})

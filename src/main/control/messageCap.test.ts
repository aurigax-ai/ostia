import { describe, expect, it, vi } from 'vitest'
import { StreamMessageReader } from 'vscode-jsonrpc/node'
import { capIncomingMessages } from './messageCap'

function frame(length: number, body = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from(`Content-Length: ${length}\r\n\r\n`), body])
}

function json(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  return frame(body.length, body)
}

function connect(max: number) {
  const destroy = vi.fn()
  const cap = capIncomingMessages({ destroy }, max)
  const forwarded: Buffer[] = []
  cap.on('data', (chunk: Buffer) => forwarded.push(chunk))
  cap.on('error', () => {})
  const reader = new StreamMessageReader(cap)
  const messages: unknown[] = []
  const errors: unknown[] = []
  reader.listen((message) => messages.push(message))
  reader.onError((error) => errors.push(error))
  const send = async (data: Buffer): Promise<void> => {
    cap.write(data)
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { destroy, send, messages, errors, forwarded: () => Buffer.concat(forwarded) }
}

describe('capIncomingMessages in front of the real reader', () => {
  it('passes messages up to the cap through, split anywhere and several at once', async () => {
    const { destroy, send, messages, errors } = connect(200)
    const one = json({ jsonrpc: '2.0', method: 'a' })
    await send(Buffer.concat([one, one]))
    for (const byte of one) await send(Buffer.from([byte]))
    expect(destroy).not.toHaveBeenCalled()
    expect(errors).toEqual([])
    expect(messages).toHaveLength(3)
  })

  it('closes when a message declares more than the cap, before any of its body is forwarded', async () => {
    const { destroy, send, forwarded } = connect(10)
    await send(frame(11, Buffer.alloc(11)))
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(forwarded().length).toBe(0)
  })

  it('closes on two Content-Length headers, whichever comes first', async () => {
    for (const block of [
      'Content-Length: 1\r\nContent-Length: 2000000000\r\n\r\n',
      'Content-Length: 2000000000\r\nContent-Length: 1\r\n\r\n',
      'content-length: 1\r\nCONTENT-LENGTH: 1\r\n\r\n',
    ]) {
      const { destroy, send, forwarded } = connect(10)
      await send(Buffer.from(block))
      expect(destroy, block).toHaveBeenCalledTimes(1)
      expect(forwarded().length, block).toBe(0)
    }
  })

  it('reads the length the way the reader does and refuses what the reader would not accept', async () => {
    const ok = connect(100)
    await ok.send(Buffer.from('X-Other: y\r\nCONTENT-length:  7abc \r\n\r\n1234567'))
    expect(ok.destroy).not.toHaveBeenCalled()
    for (const block of [
      'Content-Length: -5\r\n\r\n',
      'Content-Length: x\r\n\r\n',
      'broken\r\n\r\n',
      'X: y\r\n\r\n',
    ]) {
      const bad = connect(100)
      await bad.send(Buffer.from(block))
      expect(bad.destroy, block).toHaveBeenCalledTimes(1)
    }
  })

  it('cannot be desynchronised from the reader by a second CR, which resets the reader’s header scan', async () => {
    const hidden = 'Content-Length: 200000000\r\n\r\n'
    const attacks = [
      `Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 40\r\n\r\n${hidden.padEnd(40, 'x')}`,
      `Content-Length: 5\r\n\r\r\n\r\nAAAAAContent-Length: 40\r\n\r\n${hidden.padEnd(40, 'x')}`,
      'Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 1000\r\n\r\n',
      'Content-Length: 5\r\r\n\r\nAAAAAContent-Length: 1000\r\nContent-Length: 200000000\r\n\r\n',
      'Content-Length: 5\r\n\r\r\n\r\nAAAAA',
      'Content-Length: 1\n\r\n\r\nAContent-Length: 200000000\r\n\r\n',
      'Content-Length: 1\r\n\n\r\nAContent-Length: 200000000\r\n\r\n',
    ]
    for (const attack of attacks) {
      const { destroy, send, errors, forwarded } = connect(50)
      await send(Buffer.from(attack))
      await send(frame(50, Buffer.alloc(50)))
      expect(destroy, attack).toHaveBeenCalled()
      expect(forwarded().length, attack).toBeLessThanOrEqual(Buffer.byteLength(attack) + 100)
      void errors
    }
  })

  it('never lets the reader see a header it would read differently than the cap did', async () => {
    const alphabet = [
      '\r',
      '\n',
      '\r\n',
      'Content-Length: 3',
      'Content-Length: 99999',
      'a',
      ':',
      ' ',
    ]
    let seed = 7
    const pick = (): string => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return alphabet[seed % alphabet.length]
    }
    for (let round = 0; round < 400; round++) {
      const input = Array.from({ length: 12 }, pick).join('')
      const { destroy, send, errors } = connect(20)
      await send(Buffer.from(input))
      await send(Buffer.from('\r\n\r\n'))
      if (!destroy.mock.calls.length) expect(errors, JSON.stringify(input)).toEqual([])
    }
  })

  it('counts the body of a big allowed message without keeping it', async () => {
    const { destroy, send, messages } = connect(1024)
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', method: 'big', params: 'x'.repeat(900) }),
    )
    await send(frame(body.length, body.subarray(0, 300)))
    await send(body.subarray(300))
    await send(json({ jsonrpc: '2.0', method: 'next' }))
    expect(destroy).not.toHaveBeenCalled()
    expect(messages).toHaveLength(2)
    await send(frame(5000))
    expect(destroy).toHaveBeenCalledTimes(1)
  })
})

import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { capIncomingMessages } from './messageCap'

function frame(length: number, body = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from(`Content-Length: ${length}\r\n\r\n`), body])
}

function connect(max: number) {
  const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
  capIncomingMessages(socket as never, max)
  return { socket, send: (data: Buffer) => socket.emit('data', data) }
}

describe('capIncomingMessages', () => {
  it('lets messages up to the cap through, split anywhere, and several in one chunk', () => {
    const { socket, send } = connect(10)
    const one = frame(4, Buffer.from('abcd'))
    send(Buffer.concat([one, one]))
    for (const byte of one) send(Buffer.from([byte]))
    send(frame(10, Buffer.alloc(10)))
    expect(socket.destroy).not.toHaveBeenCalled()
  })

  it('closes the connection when a message declares more than the cap, before its body arrives', () => {
    const { socket, send } = connect(10)
    send(frame(11))
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('closes on a header with no length or one that never ends', () => {
    const first = connect(10)
    first.send(Buffer.from('Content-Type: x\r\n\r\n'))
    expect(first.socket.destroy).toHaveBeenCalledTimes(1)
    const second = connect(10)
    second.send(Buffer.alloc(5000, 65))
    expect(second.socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('closes on two Content-Length headers, whichever comes first, since the reader uses the last', () => {
    for (const block of [
      'Content-Length: 1\r\nContent-Length: 2000000000\r\n\r\n',
      'Content-Length: 2000000000\r\nContent-Length: 1\r\n\r\n',
      'content-length: 1\r\nCONTENT-LENGTH: 1\r\n\r\n',
    ]) {
      const { socket, send } = connect(10)
      send(Buffer.from(block))
      expect(socket.destroy, block).toHaveBeenCalledTimes(1)
    }
  })

  it('reads the length the way the reader does: lower-cased key, parseInt value, no negatives', () => {
    const ok = connect(100)
    ok.send(Buffer.from('X-Other: y\r\nCONTENT-length:  7abc \r\n\r\n1234567'))
    expect(ok.socket.destroy).not.toHaveBeenCalled()
    for (const block of [
      'Content-Length: -5\r\n\r\n',
      'Content-Length: x\r\n\r\n',
      'broken\r\n\r\n',
    ]) {
      const bad = connect(100)
      bad.send(Buffer.from(block))
      expect(bad.socket.destroy, block).toHaveBeenCalledTimes(1)
    }
  })

  it('does not take header lines inside a body for headers, and keeps in step with the reader', () => {
    const { socket, send } = connect(50)
    const body = Buffer.from('Content-Length: 1\r\nContent-Length: 999999999\r\n\r\n')
    send(frame(body.length, body))
    expect(socket.destroy).not.toHaveBeenCalled()
    send(frame(51))
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })

  it('counts the body of a big allowed message without keeping it', () => {
    const { socket, send } = connect(1024)
    send(frame(1000, Buffer.alloc(300)))
    send(Buffer.alloc(700))
    send(frame(2))
    expect(socket.destroy).not.toHaveBeenCalled()
    send(Buffer.from('ok'))
    send(frame(5000))
    expect(socket.destroy).toHaveBeenCalledTimes(1)
  })
})

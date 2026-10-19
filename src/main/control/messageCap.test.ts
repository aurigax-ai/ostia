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

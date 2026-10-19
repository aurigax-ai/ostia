import { parentPort } from 'node:worker_threads'
import { Bzip2Decoder, Bzip2Error } from './bzip2'
import type { FromBzip2, ToBzip2 } from './bzip2Protocol'

const OUT_BYTES = 128 * 1024

const port = parentPort
const decoder = new Bzip2Decoder()
let pulls = 0
let asked = false
let stopped = false

function send(message: FromBzip2, transfer: ArrayBuffer[] = []): void {
  port?.postMessage(message, transfer)
}

function pump(): void {
  try {
    while (pulls > 0 && !stopped) {
      const out = new Uint8Array(OUT_BYTES)
      const n = decoder.read(out)
      if (n === null) {
        stopped = true
        send({ type: 'done' })
        return
      }
      if (n === 0) {
        if (!asked) {
          asked = true
          send({ type: 'need' })
        }
        return
      }
      pulls--
      send({ type: 'data', chunk: out.subarray(0, n) }, [out.buffer])
    }
  } catch (err) {
    stopped = true
    send({ type: 'error', problem: err instanceof Bzip2Error ? err.problem : 'format' })
  }
}

port?.on('message', (message: ToBzip2) => {
  if (message.type === 'input') {
    decoder.push(message.chunk)
    asked = false
  } else if (message.type === 'end') decoder.end()
  else pulls++
  pump()
})

import { Duplex } from 'node:stream'
import { Worker } from 'node:worker_threads'
import { Bzip2Error } from './bzip2'
import type { FromBzip2, ToBzip2 } from './bzip2Protocol'

const WORKER_HEAP_MB = 64

export class Bzip2Stream extends Duplex {
  private readonly worker: Worker
  readonly exited: Promise<void>
  private waiting: ((error?: Error | null) => void) | null = null
  private finished = false

  constructor(workerFile: string) {
    super()
    this.worker = new Worker(workerFile, {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
    })
    this.worker.on('message', (message: FromBzip2) => this.receive(message))
    this.worker.on('error', (error) => this.destroy(error))
    this.exited = new Promise((resolve) => this.worker.once('exit', () => resolve()))
    this.worker.on('exit', () => {
      if (!this.finished) this.destroy(new Error('bzip2 worker stopped'))
    })
  }

  private send(message: ToBzip2, transfer: ArrayBuffer[] = []): void {
    this.worker.postMessage(message, transfer)
  }

  private receive(message: FromBzip2): void {
    if (message.type === 'data') this.push(Buffer.from(message.chunk))
    else if (message.type === 'need') {
      const waiting = this.waiting
      this.waiting = null
      waiting?.()
    } else if (message.type === 'done') {
      this.finished = true
      this.push(null)
      void this.worker.terminate()
    } else this.destroy(new Bzip2Error(message.problem))
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    const copy = new Uint8Array(chunk)
    this.waiting = done
    this.send({ type: 'input', chunk: copy }, [copy.buffer])
  }

  override _final(done: (error?: Error | null) => void): void {
    this.send({ type: 'end' })
    done()
  }

  override _read(): void {
    this.send({ type: 'pull' })
  }

  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.finished = true
    void this.worker.terminate()
    done(error)
  }
}

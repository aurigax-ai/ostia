import type { Page } from './test'

const WAV_RATE = 44_100
const WAV_CHANNELS = 2
const WAV_BYTES_PER_SAMPLE = 2

export function silentWav(seconds: number): Buffer {
  const blockBytes = WAV_CHANNELS * WAV_BYTES_PER_SAMPLE
  const dataBytes = Math.floor(seconds * WAV_RATE) * blockBytes
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(WAV_CHANNELS, 22)
  header.writeUInt32LE(WAV_RATE, 24)
  header.writeUInt32LE(WAV_RATE * blockBytes, 28)
  header.writeUInt16LE(blockBytes, 32)
  header.writeUInt16LE(WAV_BYTES_PER_SAMPLE * 8, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes)])
}

export async function recordWebm(win: Page, seconds: number): Promise<Buffer> {
  const encoded = await win.evaluate(async (length) => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d') as CanvasRenderingContext2D
    const recorder = new MediaRecorder(canvas.captureStream(30), {
      mimeType: 'video/webm;codecs=vp9',
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve
    })
    const draw = (elapsed: number): void => {
      context.fillStyle = '#ff0000'
      context.fillRect(0, 0, 160, 180)
      context.fillStyle = '#0000ff'
      context.fillRect(160, 0, 160, 180)
      context.fillStyle = '#ffffff'
      context.fillRect(140 + ((elapsed / 20) % 40), 150, 12, 12)
    }
    recorder.start()
    const started = performance.now()
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const elapsed = performance.now() - started
        draw(elapsed)
        if (elapsed >= length * 1000) {
          clearInterval(timer)
          resolve()
        }
      }, 33)
    })
    recorder.stop()
    await stopped
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer())
    let text = ''
    for (let at = 0; at < bytes.length; at += 8192) {
      text += String.fromCharCode(...bytes.subarray(at, at + 8192))
    }
    return btoa(text)
  }, seconds)
  return Buffer.from(encoded, 'base64')
}

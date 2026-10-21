import type { RpcOutcome } from '../controlDispatch'

export const PHONE_IMAGE_MAX_BYTES = 10 * 1024 * 1024
export const PHONE_IMAGE_FRAME_BYTES = Math.ceil((PHONE_IMAGE_MAX_BYTES * 4) / 3) + 64 * 1024
const IMAGES_PER_MINUTE = 6
const MINUTE_MS = 60_000
const imageSends = new Map<string, number[]>()

type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp'

const MIME_OF: Record<ImageMime, (bytes: Buffer) => boolean> = {
  'image/png': (b) =>
    b.length > 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.length > 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP',
}

function refused(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

export function phoneImageOf(image: unknown): Buffer | RpcOutcome {
  if (typeof image !== 'object' || image === null) return refused('image-type')
  const { mime, data } = image as Record<string, unknown>
  if (typeof mime !== 'string' || !Object.hasOwn(MIME_OF, mime) || typeof data !== 'string') {
    return refused('image-type')
  }
  if (data.length > Math.ceil((PHONE_IMAGE_MAX_BYTES * 4) / 3) + 4)
    return refused('image-too-large')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > PHONE_IMAGE_MAX_BYTES) return refused('image-too-large')
  return MIME_OF[mime as ImageMime](bytes) ? bytes : refused('image-type')
}

export function imageAllowed(deviceId: string): boolean {
  const now = Date.now()
  const recent = (imageSends.get(deviceId) ?? []).filter((at) => now - at < MINUTE_MS)
  if (recent.length >= IMAGES_PER_MINUTE) {
    imageSends.set(deviceId, recent)
    return false
  }
  imageSends.set(deviceId, [...recent, now])
  return true
}

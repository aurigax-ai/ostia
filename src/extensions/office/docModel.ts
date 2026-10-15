import mammoth from 'mammoth'
import { checkOfficeContainer } from './canonicalZip'
import { GuardStop, type OfficeLimits, type OfficeProblem } from './officeLimits'

const IMAGES_MAX_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export type DocumentResult =
  | { ok: true; html: string; imagesDropped: number }
  | { ok: false; problem: OfficeProblem }

export async function readDocument(
  bytes: Uint8Array,
  limits: OfficeLimits,
): Promise<DocumentResult> {
  try {
    checkOfficeContainer(bytes, limits)
    let imageBytes = 0
    let imagesDropped = 0
    const convertImage = mammoth.images.imgElement(async (image) => {
      if (!IMAGE_TYPES.has(image.contentType)) {
        imagesDropped++
        return { src: '' }
      }
      const data = await image.readAsBase64String()
      imageBytes += data.length
      if (imageBytes > IMAGES_MAX_BYTES) {
        imagesDropped++
        return { src: '' }
      }
      return { src: `data:${image.contentType};base64,${data}` }
    })
    const copy = bytes.slice()
    const input = { arrayBuffer: copy.buffer, buffer: copy }
    const result = await mammoth.convertToHtml(input as unknown as { arrayBuffer: ArrayBuffer }, {
      convertImage,
      externalFileAccess: false,
    })
    return { ok: true, html: result.value, imagesDropped }
  } catch (error) {
    return { ok: false, problem: error instanceof GuardStop ? error.problem : 'failed' }
  }
}
